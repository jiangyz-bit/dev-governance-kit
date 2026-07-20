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
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { createSmokeProject } from "./create-smoke-project.mjs";

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const maximumFailureBytes = 900;

function replaceAllLiteral(source, value, replacement) {
  if (!value) return source;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.replace(
    new RegExp(escaped, process.platform === "win32" ? "gi" : "g"),
    replacement
  );
}

function limitUtf8(source, maximumBytes) {
  let output = "";
  let bytes = 0;
  for (const character of source) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maximumBytes) return `${output}…`;
    output += character;
    bytes += size;
  }
  return output;
}

function sanitizeDiagnostic(source, sensitivePaths = []) {
  let output = String(source ?? "")
    .replaceAll("\0", "")
    .replace(/\r\n?/g, "\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const paths = [...new Set(sensitivePaths.filter(Boolean).map((value) => (
    path.resolve(String(value))
  )))].sort((left, right) => right.length - left.length);
  for (const sensitivePath of paths) {
    output = replaceAllLiteral(output, sensitivePath, "<已隐藏路径>");
    output = replaceAllLiteral(
      output,
      sensitivePath.replaceAll("\\", "/"),
      "<已隐藏路径>"
    );
  }
  output = output
    .replace(/file:\/\/\/[^\s)"']+/gi, "<已隐藏路径>")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\r\n]*/g, "<已隐藏路径>")
    .replace(
      /(^|[\s("'=])\/[^ \t\r\n)"'<>]+/g,
      "$1<已隐藏路径>"
    );
  output = output.trim();
  return limitUtf8(output, maximumFailureBytes);
}

export function formatPackageSmokeError(error, { sensitivePaths = [] } = {}) {
  const summary = sanitizeDiagnostic(
    error?.message ?? "未知错误",
    sensitivePaths
  );
  return `PACKAGE_SMOKE_FAILED: ${summary || "未知错误"}`;
}

class PackageSmokeFailure extends Error {
  constructor(error, sensitivePaths) {
    super(formatPackageSmokeError(error, { sensitivePaths }));
    this.name = "PackageSmokeFailure";
  }
}

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
        `子命令失败：${path.basename(command)}`,
        `退出码：${code ?? "null"}${signal ? `，信号：${signal}` : ""}`,
        (stderr || stdout).trim()
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

function portableTarPackagePath(archivePath) {
  if (!archivePath.startsWith("package/")) {
    throw new Error("tarball 条目不在 package/ 根目录");
  }
  const packagePath = archivePath.slice("package/".length);
  const segments = packagePath.split("/");
  if (
    !packagePath
    || packagePath.includes("\\")
    || path.posix.isAbsolute(packagePath)
    || segments.some((segment) => (
      segment === "" || segment === "." || segment === ".."
    ))
    || path.posix.normalize(packagePath) !== packagePath
  ) {
    throw new Error("tarball 包含越界或歧义条目路径");
  }
  return packagePath;
}

export async function readTarballEntries(tarball) {
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
    if (contentStart + size > archive.length) {
      throw new Error("tarball 条目内容不完整");
    }
    const content = archive.subarray(contentStart, contentStart + size);

    if (type === "x") {
      pendingPath = parsePax(content).path ?? pendingPath;
    } else if (type === "L") {
      pendingPath = content.toString("utf8").replace(/\0.*$/, "");
    } else if (type === "\0" || type === "0") {
      const archivePath = pendingPath ?? headerPath;
      pendingPath = undefined;
      const packagePath = portableTarPackagePath(archivePath);
      if (entries.has(packagePath)) {
        throw new Error(`tarball 包含重复条目：${packagePath}`);
      }
      entries.set(packagePath, Buffer.from(content));
    } else {
      pendingPath = undefined;
      portableTarPackagePath(headerPath);
      throw new Error(`tarball 包含不支持的条目类型：${type || "unknown"}`);
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

function isPathAtOrInside(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function normalizeTrustedFileEntry(rootDir, rootRealPath, entry) {
  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error("可信 package.json.files 包含空条目");
  }
  if (entry.includes("\\")) {
    throw new Error(`可信 package.json.files 使用了反斜杠：${entry}`);
  }
  if (path.posix.isAbsolute(entry) || path.win32.isAbsolute(entry)) {
    throw new Error(`可信 package.json.files 包含绝对路径：${entry}`);
  }
  const relativePath = entry.endsWith("/") ? entry.slice(0, -1) : entry;
  const segments = relativePath.split("/");
  if (
    !relativePath
    || relativePath === "."
    || segments.some((segment) => (
      segment === "" || segment === "." || segment === ".."
    ))
    || path.posix.normalize(relativePath) !== relativePath
  ) {
    throw new Error(`可信 package.json.files 包含越界或歧义路径：${entry}`);
  }

  const resolvedPath = path.resolve(rootDir, ...segments);
  if (
    resolvedPath === path.resolve(rootDir)
    || !isPathAtOrInside(rootDir, resolvedPath)
  ) {
    throw new Error(`可信 package.json.files 解析到仓库外：${entry}`);
  }

  let current = path.resolve(rootDir);
  for (const segment of segments) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new Error(`可信 package.json.files 不允许符号链接：${entry}`);
    }
  }
  const resolvedRealPath = await realpath(current);
  if (!isPathAtOrInside(rootRealPath, resolvedRealPath)) {
    throw new Error(`可信 package.json.files 解析到仓库外：${entry}`);
  }
  return relativePath;
}

function assertTrustedPackagePolicy(artifact, trusted) {
  const fields = ["name", "version", "files", "bin", "engines"];
  for (const field of fields) {
    if (!isDeepStrictEqual(artifact?.[field], trusted?.[field])) {
      throw new Error(
        `artifact package.json 与可信发布策略不一致：${field}`
      );
    }
  }
}

export async function expandTrustedPackageFiles(
  trustedPackageJson,
  { rootDir = kitRoot } = {}
) {
  if (!Array.isArray(trustedPackageJson.files)) {
    throw new Error("可信 package.json.files 必须是数组");
  }
  const expected = new Set(["package.json", "README.md", "LICENSE"]);
  const rootRealPath = await realpath(rootDir);
  for (const allowed of trustedPackageJson.files) {
    const relativePath = await normalizeTrustedFileEntry(
      rootDir,
      rootRealPath,
      allowed
    );
    await listFiles(rootDir, relativePath, expected);
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

    const trustedPackageJson = JSON.parse(await readFile(
      path.join(kitRoot, "package.json"),
      "utf8"
    ));
    const tarEntries = await readTarballEntries(tarball);
    const tarPackageJson = JSON.parse(
      tarEntries.get("package.json")?.toString("utf8") ?? "null"
    );
    assertTrustedPackagePolicy(tarPackageJson, trustedPackageJson);
    const actualFiles = [...tarEntries.keys()].sort();
    const expectedFiles = await expandTrustedPackageFiles(trustedPackageJson);
    assertSamePaths(actualFiles, expectedFiles);
    if (packMetadata) {
      assert.equal(packMetadata.name, trustedPackageJson.name);
      assert.equal(packMetadata.version, tarPackageJson.version);
      assertSamePaths(
        packMetadata.files.map((entry) => entry.path.replaceAll("\\", "/")),
        expectedFiles
      );
    }
    for (const bin of ["dev-governance-kit", "governance-kit"]) {
      const target = trustedPackageJson.bin?.[bin]?.replace(/^\.\//, "");
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
  } catch (error) {
    if (error instanceof PackageSmokeFailure) throw error;
    throw new PackageSmokeFailure(error, [
      root,
      kitRoot,
      parsed.tarball
    ]);
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
  const sensitivePaths = [
    kitRoot,
    ...process.argv.slice(2).filter((argument) => path.isAbsolute(argument))
  ];
  try {
    const result = await runPackageSmoke(
      parsePackageSmokeArgs(process.argv.slice(2))
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof PackageSmokeFailure
      ? error.message
      : formatPackageSmokeError(error, { sensitivePaths });
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
