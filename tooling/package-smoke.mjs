#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm
} from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSmokeProject } from "./create-smoke-project.mjs";

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parsePackageSmokeArgs(args) {
  let tarball;
  let source = "candidate";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--tarball") {
      if (tarball !== undefined) throw new Error("--tarball 不能重复");
      tarball = args[index + 1];
      if (!tarball || tarball.startsWith("--")) {
        throw new Error("--tarball 缺少路径");
      }
      if (!path.isAbsolute(tarball)) {
        throw new Error("--tarball 必须使用绝对路径");
      }
      tarball = path.resolve(tarball);
      index += 1;
    } else if (argument === "--source") {
      const value = args[index + 1];
      if (!["candidate", "registry"].includes(value)) {
        throw new Error("--source 只能是 candidate 或 registry");
      }
      source = value;
      index += 1;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  if (source === "registry" && !tarball) {
    throw new Error("registry 烟测必须同时提供 --tarball");
  }
  return { tarball, source };
}

function run(command, args, { cwd, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      shell: false
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error([
        `子命令失败：${path.basename(command)} ${args.join(" ")}`,
        `退出码：${code ?? "null"}${signal ? `，信号：${signal}` : ""}`,
        stderr || stdout
      ].filter(Boolean).join("\n")));
    });
  });
}

async function isFile(target) {
  try {
    return (await lstat(target)).isFile();
  } catch {
    return false;
  }
}

export async function resolveNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js"
    ),
    path.join(
      path.dirname(process.execPath),
      "..",
      "lib",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js"
    )
  ].filter(Boolean);

  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    candidates.push(
      path.join(directory, "npm-cli.js"),
      path.join(directory, "node_modules", "npm", "bin", "npm-cli.js")
    );
    if (process.platform !== "win32") {
      try {
        const resolved = await realpath(path.join(directory, "npm"));
        candidates.push(resolved);
      } catch {
        // 继续检查其他 PATH 目录。
      }
    }
  }

  for (const candidate of candidates) {
    if (candidate && await isFile(candidate)) return path.resolve(candidate);
  }
  throw new Error("无法定位 npm-cli.js");
}

function parseOctal(buffer, start, length) {
  const source = buffer
    .subarray(start, start + length)
    .toString("utf8")
    .replace(/\0.*$/, "")
    .trim();
  return source ? Number.parseInt(source, 8) : 0;
}

function tarString(buffer, start, length) {
  return buffer
    .subarray(start, start + length)
    .toString("utf8")
    .replace(/\0.*$/, "");
}

function parsePax(content) {
  const fields = {};
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset);
    if (space < 0) break;
    const length = Number.parseInt(
      content.subarray(offset, space).toString("ascii"),
      10
    );
    if (!Number.isFinite(length) || length <= 0) break;
    const record = content
      .subarray(space + 1, offset + length)
      .toString("utf8")
      .replace(/\n$/, "");
    const equals = record.indexOf("=");
    if (equals >= 0) fields[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return fields;
}

async function readTarball(tarball) {
  const archive = gunzipSync(await readFile(tarball));
  const entries = new Map();
  let offset = 0;
  let pendingPath;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = parseOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0);
    const prefix = tarString(header, 345, 155);
    const headerName = tarString(header, 0, 100);
    const headerPath = prefix ? `${prefix}/${headerName}` : headerName;
    const contentStart = offset + 512;
    const content = archive.subarray(contentStart, contentStart + size);

    if (type === "x") {
      pendingPath = parsePax(content).path ?? pendingPath;
    } else if (type === "L") {
      pendingPath = content.toString("utf8").replace(/\0.*$/, "");
    } else if (type === "\0" || type === "0") {
      const archivePath = pendingPath ?? headerPath;
      pendingPath = undefined;
      const packagePath = archivePath.startsWith("package/")
        ? archivePath.slice("package/".length)
        : archivePath;
      entries.set(packagePath.replaceAll("\\", "/"), Buffer.from(content));
    } else {
      pendingPath = undefined;
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function listFiles(rootDir, relativePath, output) {
  const absolutePath = path.join(rootDir, relativePath);
  const info = await lstat(absolutePath);
  if (info.isSymbolicLink()) {
    throw new Error(`发布白名单不能包含符号链接：${relativePath}`);
  }
  if (info.isFile()) {
    output.add(relativePath.replaceAll("\\", "/"));
    return;
  }
  if (!info.isDirectory()) {
    throw new Error(`发布白名单包含不支持的文件类型：${relativePath}`);
  }
  const entries = await readdir(absolutePath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    await listFiles(
      rootDir,
      path.join(relativePath, entry.name),
      output
    );
  }
}

async function expectedPackageFiles(packageJson) {
  const expected = new Set(["package.json", "README.md", "LICENSE"]);
  for (const allowed of packageJson.files) {
    const relativePath = allowed.replace(/[\\/]+$/, "");
    await listFiles(kitRoot, relativePath, expected);
  }
  return [...expected].sort();
}

function assertSamePaths(actual, expected) {
  assert.deepEqual(
    [...actual].sort(),
    [...expected].sort(),
    "tarball 文件必须与 package.json.files 白名单精确一致"
  );
}

function parseJsonDocument(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} 没有输出单个有效 JSON：${error.message}`);
  }
}

function isPathAtOrInside(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

export async function runPackageSmoke(options = {}) {
  const parsed = {
    tarball: options.tarball,
    source: options.source ?? "candidate"
  };
  if (!["candidate", "registry"].includes(parsed.source)) {
    throw new Error("source 只能是 candidate 或 registry");
  }
  if (parsed.tarball && !path.isAbsolute(parsed.tarball)) {
    throw new Error("tarball 必须是绝对路径");
  }
  if (parsed.source === "registry" && !parsed.tarball) {
    throw new Error("registry 烟测必须提供 tarball");
  }

  const root = await mkdtemp(path.join(tmpdir(), "governance-package-smoke-"));
  try {
    const npmCli = await resolveNpmCli();
    const npxCli = path.join(path.dirname(npmCli), "npx-cli.js");
    if (!await isFile(npxCli)) throw new Error("无法定位 npx-cli.js");
    const packDir = path.join(root, "pack");
    const projectDir = path.join(root, "用户 项目");
    const consumerDir = path.join(root, "consumer project");
    await Promise.all([
      mkdir(packDir, { recursive: true }),
      mkdir(consumerDir, { recursive: true })
    ]);
    await createSmokeProject(projectDir);

    let tarball = parsed.tarball;
    let packMetadata;
    if (tarball) {
      await access(tarball);
    } else {
      const packed = await run(process.execPath, [
        npmCli,
        "pack",
        "--json",
        "--pack-destination",
        packDir
      ], { cwd: kitRoot });
      const metadata = JSON.parse(packed.stdout);
      assert.equal(metadata.length, 1, "npm pack 必须只生成一个 tarball");
      [packMetadata] = metadata;
      tarball = path.resolve(packDir, packMetadata.filename);
    }

    const tarEntries = await readTarball(tarball);
    const tarPackageJson = JSON.parse(
      tarEntries.get("package.json")?.toString("utf8") ?? "null"
    );
    assert.equal(tarPackageJson?.name, "dev-governance-kit");
    const actualFiles = [...tarEntries.keys()].sort();
    const expectedFiles = await expectedPackageFiles(tarPackageJson);
    assertSamePaths(actualFiles, expectedFiles);
    if (packMetadata) {
      assert.equal(packMetadata.version, tarPackageJson.version);
      assertSamePaths(
        packMetadata.files.map((entry) => entry.path.replaceAll("\\", "/")),
        expectedFiles
      );
    }
    for (const bin of ["dev-governance-kit", "governance-kit"]) {
      const target = tarPackageJson.bin?.[bin]?.replace(/^\.\//, "");
      assert.ok(target, `tarball 缺少 bin：${bin}`);
      assert.ok(tarEntries.has(target), `tarball 缺少 bin 目标：${target}`);
    }

    await run(process.execPath, [npmCli, "init", "--yes"], {
      cwd: consumerDir
    });
    await run(process.execPath, [
      npmCli,
      "install",
      "--no-audit",
      "--no-fund",
      tarball
    ], { cwd: consumerDir });

    const runNpx = (args) => run(process.execPath, [
      npxCli,
      "--no-install",
      ...args
    ], { cwd: consumerDir });
    const init = parseJsonDocument(await runNpx([
      "dev-governance-kit",
      "init",
      "--workspace",
      projectDir,
      "--yes",
      "--json",
      "--verbose"
    ]), "init");
    const validate = parseJsonDocument(await runNpx([
      "dev-governance-kit",
      "validate",
      "--workspace",
      projectDir,
      "--json"
    ]), "validate");
    const secondInit = parseJsonDocument(await runNpx([
      "dev-governance-kit",
      "init",
      "--workspace",
      projectDir,
      "--yes",
      "--json",
      "--verbose"
    ]), "第二次 init");
    await runNpx(["governance-kit", "--help"]);

    assert.equal(init.status, "applied");
    assert.equal(init.valid, true);
    assert.equal(validate.report?.valid, true);
    assert.equal(secondInit.status, "applied");
    assert.equal(secondInit.report?.created?.length, 0);
    assert.equal(secondInit.report?.updated?.length, 0);
    assert.equal(init.version, tarPackageJson.version);

    const installedRoot = path.resolve(
      consumerDir,
      "node_modules",
      "dev-governance-kit"
    );
    assert.equal(
      path.resolve(init.runtime?.packageRoot ?? ""),
      installedRoot,
      "CLI runtime.packageRoot 必须精确指向 consumer 中的安装包"
    );
    assert.equal(
      isPathAtOrInside(kitRoot, init.runtime.packageRoot),
      false,
      "CLI 不能从源码仓库读取运行时资源"
    );

    const verification = {
      source: parsed.source,
      packageVersion: tarPackageJson.version,
      files: actualFiles
    };
    return {
      ok: true,
      source: parsed.source,
      packageVersion: tarPackageJson.version,
      packageFiles: actualFiles.length,
      initStatus: init.status,
      validateStatus: "valid",
      secondInitCreated: secondInit.report.created.length,
      secondInitUpdated: secondInit.report.updated.length,
      runtime: init.runtime,
      ...(parsed.source === "registry"
        ? { registryVerification: verification }
        : { candidateVerification: verification })
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1])
    === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
  try {
    const result = await runPackageSmoke(
      parsePackageSmokeArgs(process.argv.slice(2))
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
