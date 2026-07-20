import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createSmokeProject } from "../tooling/create-smoke-project.mjs";
import {
  parsePackageSmokeArgs,
  resolveNpmCli
} from "../tooling/package-smoke.mjs";

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runNode(args, cwd = kitRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function writeTarString(header, offset, length, value) {
  const encoded = Buffer.from(value, "utf8");
  assert.ok(encoded.length <= length, `tar 字段过长：${value}`);
  encoded.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  const source = `${value.toString(8).padStart(length - 1, "0")}\0`;
  header.write(source, offset, length, "ascii");
}

function tarHeader(relativePath, content, { type = "0", linkname = "" } = {}) {
  const archivePath = `package/${relativePath}`;
  const encoded = Buffer.from(archivePath, "utf8");
  const header = Buffer.alloc(512);
  if (encoded.length <= 100) {
    encoded.copy(header, 0);
  } else {
    const splitAt = archivePath.lastIndexOf("/");
    const prefix = archivePath.slice(0, splitAt);
    const name = archivePath.slice(splitAt + 1);
    assert.ok(Buffer.byteLength(prefix) <= 155);
    assert.ok(Buffer.byteLength(name) <= 100);
    writeTarString(header, 0, 100, name);
    writeTarString(header, 345, 155, prefix);
  }
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, content.length);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  if (linkname) writeTarString(header, 157, 100, linkname);
  writeTarString(header, 257, 6, "ustar");
  writeTarString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(
    `${checksum.toString(8).padStart(6, "0")}\0 `,
    148,
    8,
    "ascii"
  );
  return header;
}

async function writeTarball(target, entries) {
  const chunks = [];
  for (const [relativePath, value] of [...entries].sort(([left], [right]) => (
    left.localeCompare(right, "en")
  ))) {
    const descriptor = Buffer.isBuffer(value)
      ? { content: value, type: "0", linkname: "" }
      : value;
    const { content, type, linkname } = descriptor;
    chunks.push(tarHeader(relativePath, content, { type, linkname }), content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  await writeFile(target, gzipSync(Buffer.concat(chunks)));
}

test("package smoke script verifies the packed CLI", async () => {
  const result = await runNode(["tooling/package-smoke.mjs"]);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.source, "candidate");
  assert.equal(output.packageVersion, "0.1.0");
  assert.equal(output.initStatus, "applied");
  assert.equal(output.validateStatus, "valid");
  assert.equal(output.secondInitCreated, 0);
  assert.equal(output.secondInitUpdated, 0);
  assert.ok(output.packageFiles > 0);
  assert.equal(output.candidateVerification.source, "candidate");
  assert.equal(output.registryVerification, undefined);
});

test("smoke fixture creates a real supported Git project in a Chinese spaced path", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "治理 烟测-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const project = path.join(parent, "用户 项目");

  const result = await createSmokeProject(project);

  assert.equal(result.rootDir, path.resolve(project));
  assert.match(
    await readFile(path.join(project, "demo-server", "pom.xml"), "utf8"),
    /spring-boot[\s\S]*mybatis[\s\S]*flyway/
  );
  assert.equal(
    JSON.parse(await readFile(
      path.join(project, "demo-admin", "package.json"),
      "utf8"
    )).name,
    "demo-admin"
  );
  assert.equal(
    JSON.parse(await readFile(
      path.join(project, "demo-miniprogram", "project.config.json"),
      "utf8"
    )).appid,
    "touristappid"
  );
  assert.ok(await readFile(path.join(project, ".git", "HEAD"), "utf8"));
});

test("smoke fixture refuses a non-empty directory without changing it", async (t) => {
  const project = await mkdtemp(path.join(tmpdir(), "governance-nonempty-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const marker = path.join(project, "keep.txt");
  await writeFile(marker, "user data", "utf8");

  await assert.rejects(
    createSmokeProject(project),
    /目录必须为空/
  );
  assert.equal(await readFile(marker, "utf8"), "user data");
});

test("package smoke arguments require an absolute reused tarball", () => {
  assert.throws(
    () => parsePackageSmokeArgs(["--tarball", "candidate.tgz"]),
    /绝对路径/
  );
  assert.throws(
    () => parsePackageSmokeArgs(["--source", "registry"]),
    /registry.*--tarball/
  );
  assert.deepEqual(
    parsePackageSmokeArgs([
      "--tarball",
      path.resolve("candidate.tgz"),
      "--source",
      "registry"
    ]),
    {
      tarball: path.resolve("candidate.tgz"),
      source: "registry"
    }
  );
});

test("verbose JSON exposes package runtime evidence only when requested", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "governance-runtime-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const project = path.join(parent, "用户 项目");
  await createSmokeProject(project);

  const verbose = await runNode([
    "tooling/cli.mjs",
    "init",
    "--workspace",
    project,
    "--yes",
    "--json",
    "--verbose"
  ]);
  assert.equal(verbose.code, 0, verbose.stderr);
  const verboseResult = JSON.parse(verbose.stdout);
  assert.equal(verboseResult.version, "0.1.0");
  assert.equal(path.resolve(verboseResult.runtime.packageRoot), kitRoot);

  const normal = await runNode([
    "tooling/cli.mjs",
    "init",
    "--workspace",
    project,
    "--yes",
    "--json"
  ]);
  assert.equal(normal.code, 0, normal.stderr);
  const normalResult = JSON.parse(normal.stdout);
  assert.equal(normalResult.version, undefined);
  assert.equal(normalResult.runtime, undefined);
});

test("an absolute registry tarball is reused with separate verification output", async (t) => {
  const packDir = await mkdtemp(path.join(tmpdir(), "governance-reuse-pack-"));
  t.after(() => rm(packDir, { recursive: true, force: true }));
  const npmCli = await resolveNpmCli();
  const packed = await runNode([
    npmCli,
    "pack",
    "--silent",
    "--pack-destination",
    packDir
  ]);
  assert.equal(packed.code, 0, packed.stderr);
  const filename = (await readdir(packDir)).find((entry) => (
    entry.endsWith(".tgz")
  ));
  assert.ok(filename, "npm pack 应生成 tgz");
  const tarball = path.resolve(packDir, filename);

  const result = await runNode([
    "tooling/package-smoke.mjs",
    "--tarball",
    tarball,
    "--source",
    "registry"
  ]);

  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.source, "registry");
  assert.equal(output.registryVerification.source, "registry");
  assert.equal(output.registryVerification.packageVersion, "0.1.0");
  assert.ok(output.registryVerification.files.includes("tooling/cli.mjs"));
  assert.equal(output.candidateVerification, undefined);
});

test("reused tarballs cannot redefine the trusted package allowlist", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "governance-malicious-pack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const npmCli = await resolveNpmCli();
  const packed = await runNode([
    npmCli,
    "pack",
    "--silent",
    "--pack-destination",
    root
  ]);
  assert.equal(packed.code, 0, packed.stderr);
  const filename = (await readdir(root)).find((entry) => entry.endsWith(".tgz"));
  assert.ok(filename);
  const {
    readTarballEntries,
    runPackageSmoke
  } = await import("../tooling/package-smoke.mjs");
  assert.equal(typeof readTarballEntries, "function");
  const original = await readTarballEntries(path.join(root, filename));
  const originalPackage = JSON.parse(original.get("package.json"));

  const cases = [
    {
      name: "path traversal",
      expected: /artifact package\.json 与可信发布策略不一致/,
      mutate(entries, packageJson) {
        packageJson.files = ["../outside-sensitive"];
      }
    },
    {
      name: "self-consistent omission",
      expected: /artifact package\.json 与可信发布策略不一致/,
      mutate(entries, packageJson) {
        packageJson.files = packageJson.files.filter((entry) => (
          entry !== "docs/MANIFEST_REFERENCE.md"
        ));
        entries.delete("docs/MANIFEST_REFERENCE.md");
      }
    },
    {
      name: "self-consistent extra file",
      expected: /artifact package\.json 与可信发布策略不一致/,
      async mutate(entries, packageJson) {
        packageJson.files.push("tooling/package-smoke.mjs");
        entries.set(
          "tooling/package-smoke.mjs",
          await readFile(path.join(kitRoot, "tooling", "package-smoke.mjs"))
        );
      }
    },
    {
      name: "extra symbolic link",
      expected: /tarball 包含不支持的条目类型/,
      mutate(entries) {
        entries.set("sneaky-link", {
          content: Buffer.alloc(0),
          type: "2",
          linkname: "tooling/cli.mjs"
        });
      }
    }
  ];

  for (const fixture of cases) {
    const entries = new Map(original);
    const packageJson = structuredClone(originalPackage);
    await fixture.mutate(entries, packageJson);
    entries.set(
      "package.json",
      Buffer.from(`${JSON.stringify(packageJson, null, 2)}\n`, "utf8")
    );
    const tarball = path.join(root, `${fixture.name.replaceAll(" ", "-")}.tgz`);
    await writeTarball(tarball, entries);

    await assert.rejects(
      runPackageSmoke({ tarball, source: "candidate" }),
      fixture.expected,
      fixture.name
    );
  }
});

test("package smoke failures redact paths and cap diagnostic output", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "governance-secret-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = path.join(root, "private candidate.tgz");

  const result = await runNode([
    "tooling/package-smoke.mjs",
    "--tarball",
    missing,
    "--source",
    "registry"
  ]);

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /PACKAGE_SMOKE_FAILED/);
  assert.match(result.stderr, /已隐藏路径/);
  assert.doesNotMatch(result.stderr, new RegExp(
    root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "i"
  ));
  assert.doesNotMatch(result.stderr, new RegExp(
    kitRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "i"
  ));
  assert.doesNotMatch(result.stderr, /\n\s+at\s/);
  assert.ok(
    Buffer.byteLength(result.stderr, "utf8") <= 1024,
    "失败摘要必须保持有限长度"
  );

  const { formatPackageSmokeError } = await import(
    "../tooling/package-smoke.mjs"
  );
  const formatted = formatPackageSmokeError(new Error(
    `诊断 C:\\private\\npm-cache\\debug.log /Users/private/npm-cache/debug.log ${"x".repeat(5000)}`
  ));
  assert.doesNotMatch(formatted, /C:\\private/i);
  assert.doesNotMatch(formatted, /\/Users\/private/);
  assert.match(formatted, /已隐藏路径/);
  assert.ok(Buffer.byteLength(formatted, "utf8") <= 1024);
});

test("trusted files reject portable path ambiguities and linked escapes", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "governance-policy-root-"));
  const outside = await mkdtemp(path.join(tmpdir(), "governance-policy-outside-"));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true })
  ]));
  await mkdir(path.join(root, "allowed"), { recursive: true });
  await writeFile(path.join(root, "allowed", "runtime.mjs"), "export {};\n");
  const { expandTrustedPackageFiles } = await import(
    "../tooling/package-smoke.mjs"
  );
  assert.equal(typeof expandTrustedPackageFiles, "function");

  const valid = await expandTrustedPackageFiles(
    { files: ["allowed/"] },
    { rootDir: root }
  );
  assert.ok(valid.includes("allowed/runtime.mjs"));

  for (const invalid of [
    "",
    ".",
    "..",
    "../outside",
    "/absolute",
    "C:/absolute",
    "allowed\\runtime.mjs",
    "allowed//runtime.mjs",
    "allowed/./runtime.mjs"
  ]) {
    await assert.rejects(
      expandTrustedPackageFiles(
        { files: [invalid] },
        { rootDir: root }
      ),
      /可信 package\.json\.files/,
      invalid
    );
  }

  const linkPath = path.join(root, "linked");
  try {
    await symlink(
      outside,
      linkPath,
      process.platform === "win32" ? "junction" : "dir"
    );
    await assert.rejects(
      expandTrustedPackageFiles(
        { files: ["linked/"] },
        { rootDir: root }
      ),
      /符号链接|仓库外/
    );
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    t.diagnostic(`当前平台不能创建目录链接：${error.code}`);
  }
});
