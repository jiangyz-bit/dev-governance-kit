#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  link,
  open,
  readFile,
  realpath,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTarballEntries } from "./package-smoke.mjs";

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaKeys = [
  "schemaVersion",
  "version",
  "commit",
  "tarball",
  "sha256",
  "files"
];
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const commitPattern = /^[0-9a-f]{40}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const controlPattern = /[\u0000-\u001f\u007f]/;
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

function sanitizeFailure(source, sensitivePaths) {
  let output = String(source ?? "未知错误")
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
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^ \t\r\n)"'<>]*/g, "<已隐藏路径>")
    .replace(/(^|[\s("'=])\/[^ \t\r\n)"'<>]+/g, "$1<已隐藏路径>")
    .replace(/\s*\n\s*/g, " ")
    .trim();
  return limitUtf8(output || "未知错误", maximumFailureBytes);
}

function cliSensitivePaths(args) {
  const pathOptions = new Set([
    "--pack-json",
    "--directory",
    "--output",
    "--evidence",
    "--tarball"
  ]);
  const output = [process.cwd(), kitRoot];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (pathOptions.has(args[index])) output.push(args[index + 1]);
  }
  return output;
}

function assertPlainObject(value, label) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
}

function assertExactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} 字段不符合 schema`);
  }
}

function assertVersion(value, label = "version") {
  if (typeof value !== "string" || !versionPattern.test(value)) {
    throw new Error(`${label} 不是有效 SemVer`);
  }
}

function assertCommit(value, label = "commit") {
  if (typeof value !== "string" || !commitPattern.test(value)) {
    throw new Error(`${label} 必须是 40 位小写 Git commit SHA`);
  }
}

function assertSafeString(value, label) {
  if (
    typeof value !== "string"
    || value.length === 0
    || controlPattern.test(value)
  ) {
    throw new Error(`${label} 包含空值或控制字符`);
  }
}

function assertSafeBasename(value, label) {
  assertSafeString(value, label);
  if (
    path.basename(value) !== value
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
  ) {
    throw new Error(`${label} 必须是安全文件名`);
  }
}

function assertFiles(files, label) {
  if (!Array.isArray(files)) throw new Error(`${label} 必须是数组`);
  const sorted = [...files].sort();
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    assertSafeString(file, `${label}[${index}]`);
    if (
      file.startsWith("/")
      || file.includes("\\")
      || file.split("/").some((part) => (
        part === "" || part === "." || part === ".."
      ))
    ) {
      throw new Error(`${label} 包含越界或歧义路径`);
    }
    if (file !== sorted[index]) {
      throw new Error(`${label} 必须排序且唯一`);
    }
    if (index > 0 && file === files[index - 1]) {
      throw new Error(`${label} 必须排序且唯一`);
    }
  }
}

async function assertUnlinkedPath(target, {
  label,
  type = "file",
  allowMissing = false
}) {
  const resolved = path.resolve(target);
  let info;
  try {
    info = await lstat(resolved);
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") return resolved;
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`${label} 不能是链接`);
  if (type === "file" && !info.isFile()) {
    throw new Error(`${label} 必须是普通文件`);
  }
  if (type === "directory" && !info.isDirectory()) {
    throw new Error(`${label} 必须是目录`);
  }
  const actual = await realpath(resolved);
  if (path.resolve(actual) !== resolved) {
    throw new Error(`${label} 的路径不能经过链接`);
  }
  return resolved;
}

async function readJsonFile(target, label) {
  let value;
  try {
    value = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON：${error.message}`);
  }
  return value;
}

function actualArchiveMetadata(entries) {
  const files = [...entries.keys()].sort();
  assertFiles(files, "tarball files");
  const packageSource = entries.get("package.json");
  if (!packageSource) throw new Error("tarball 缺少 package.json");
  let packageJson;
  try {
    packageJson = JSON.parse(packageSource.toString("utf8"));
  } catch (error) {
    throw new Error(`tarball package.json 不是有效 JSON：${error.message}`);
  }
  assertPlainObject(packageJson, "tarball package.json");
  if (packageJson.name !== "dev-governance-kit") {
    throw new Error("tarball package.json name 不匹配");
  }
  assertVersion(packageJson.version, "tarball package.json version");
  return { files, packageJson };
}

function parsePackMetadata(value) {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("pack JSON 必须只包含本次生成的一个 tarball");
  }
  const metadata = value[0];
  assertPlainObject(metadata, "pack metadata");
  if (metadata.name !== "dev-governance-kit") {
    throw new Error("pack metadata name 不匹配");
  }
  assertVersion(metadata.version, "pack metadata version");
  assertSafeBasename(metadata.filename, "pack metadata filename");
  const expectedFilename = `dev-governance-kit-${metadata.version}.tgz`;
  if (metadata.filename !== expectedFilename) {
    throw new Error("pack metadata filename 与 version 不匹配");
  }
  if (!Array.isArray(metadata.files)) {
    throw new Error("pack metadata files 必须是数组");
  }
  const files = metadata.files.map((item, index) => {
    assertPlainObject(item, `pack metadata files[${index}]`);
    assertSafeString(item.path, `pack metadata files[${index}].path`);
    if (item.path.includes("\\")) {
      throw new Error(`pack metadata files[${index}].path 使用了反斜杠`);
    }
    return item.path;
  }).sort();
  assertFiles(files, "pack metadata files");
  return { ...metadata, files };
}

function assertSameFiles(left, right, label) {
  if (
    left.length !== right.length
    || left.some((file, index) => file !== right[index])
  ) {
    throw new Error(`${label} files 不一致`);
  }
}

async function writeExclusiveAtomic(output, content) {
  try {
    await lstat(output);
    throw new Error(`输出文件已存在：${path.basename(output)}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = `${output}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, output);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`输出文件已存在：${path.basename(output)}`);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function createReleaseEvidence({
  commit,
  packJson,
  directory,
  output
}) {
  assertCommit(commit);
  const releaseDirectory = await assertUnlinkedPath(directory, {
    label: "directory",
    type: "directory"
  });
  const packJsonPath = await assertUnlinkedPath(packJson, {
    label: "pack JSON",
    type: "file"
  });
  const outputPath = await assertUnlinkedPath(output, {
    label: "output",
    allowMissing: true
  });
  if (
    path.dirname(packJsonPath) !== releaseDirectory
    || path.dirname(outputPath) !== releaseDirectory
  ) {
    throw new Error("pack JSON 和 output 必须直接位于 directory 中");
  }
  const metadata = parsePackMetadata(
    await readJsonFile(packJsonPath, "pack JSON")
  );
  const tarballPath = await assertUnlinkedPath(
    path.join(releaseDirectory, metadata.filename),
    { label: "tarball", type: "file" }
  );
  if (path.dirname(tarballPath) !== releaseDirectory) {
    throw new Error("tarball 必须直接位于 directory 中");
  }
  const tarballBytes = await readFile(tarballPath);
  const entries = await readTarballEntries(tarballBytes);
  const actual = actualArchiveMetadata(entries);
  if (actual.packageJson.version !== metadata.version) {
    throw new Error("pack metadata 与 tarball package.json version 不一致");
  }
  assertSameFiles(metadata.files, actual.files, "pack metadata 与 tarball");
  const evidence = {
    schemaVersion: 1,
    version: metadata.version,
    commit,
    tarball: metadata.filename,
    sha256: createHash("sha256").update(tarballBytes).digest("hex"),
    files: actual.files
  };
  await writeExclusiveAtomic(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

function validateEvidenceSchema(value) {
  assertPlainObject(value, "evidence");
  assertExactKeys(value, schemaKeys, "evidence");
  if (value.schemaVersion !== 1) {
    throw new Error("evidence schemaVersion 不受支持");
  }
  assertVersion(value.version, "evidence version");
  assertCommit(value.commit, "evidence commit");
  assertSafeBasename(value.tarball, "evidence tarball");
  if (!sha256Pattern.test(value.sha256)) {
    throw new Error("evidence sha256 无效");
  }
  assertFiles(value.files, "evidence files");
  return value;
}

export async function verifyReleaseEvidence({
  evidence,
  tarball,
  expectedCommit,
  expectedVersion
}) {
  assertCommit(expectedCommit, "expected commit");
  assertVersion(expectedVersion, "expected version");
  const evidencePath = await assertUnlinkedPath(evidence, {
    label: "evidence",
    type: "file"
  });
  const tarballPath = await assertUnlinkedPath(tarball, {
    label: "tarball",
    type: "file"
  });
  const value = validateEvidenceSchema(
    await readJsonFile(evidencePath, "evidence")
  );
  if (value.commit !== expectedCommit) {
    throw new Error("evidence commit 与 expected commit 不一致");
  }
  if (value.version !== expectedVersion) {
    throw new Error("evidence version 与 expected version 不一致");
  }
  if (value.tarball !== path.basename(tarballPath)) {
    throw new Error("evidence tarball 与实际 tarball 文件名不一致");
  }
  const tarballBytes = await readFile(tarballPath);
  const digest = createHash("sha256").update(tarballBytes).digest("hex");
  if (value.sha256 !== digest) {
    throw new Error("evidence sha256 与实际 tarball 不一致");
  }
  const entries = await readTarballEntries(tarballBytes);
  const actual = actualArchiveMetadata(entries);
  if (actual.packageJson.version !== expectedVersion) {
    throw new Error("tarball package.json version 与 expected version 不一致");
  }
  assertSameFiles(value.files, actual.files, "evidence 与 tarball");
  return value;
}

function parseCliArgs(args) {
  const mode = args[0];
  const specs = {
    create: ["commit", "pack-json", "directory", "output"],
    verify: ["evidence", "tarball", "expected-commit", "expected-version"]
  };
  const required = specs[mode];
  if (!required) throw new Error("命令必须是 create 或 verify");
  const values = {};
  for (let index = 1; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`参数格式无效：${option ?? "<missing>"}`);
    }
    const name = option.slice(2);
    if (!required.includes(name)) throw new Error(`未知参数：${option}`);
    if (Object.hasOwn(values, name)) throw new Error(`参数不能重复：${option}`);
    assertSafeString(value, option);
    values[name] = value;
  }
  for (const name of required) {
    if (!Object.hasOwn(values, name)) throw new Error(`缺少参数：--${name}`);
  }
  return { mode, values };
}

function isDirectExecution() {
  return process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
  const cliArgs = process.argv.slice(2);
  const command = ["create", "verify"].includes(cliArgs[0])
    ? cliArgs[0]
    : "unknown";
  try {
    const { mode, values } = parseCliArgs(cliArgs);
    if (mode === "create") {
      const result = await createReleaseEvidence({
        commit: values.commit,
        packJson: values["pack-json"],
        directory: values.directory,
        output: values.output
      });
      process.stdout.write(`${JSON.stringify({
        ok: true,
        mode,
        evidence: path.resolve(values.output),
        tarball: result.tarball,
        version: result.version
      })}\n`);
    } else {
      const result = await verifyReleaseEvidence({
        evidence: values.evidence,
        tarball: values.tarball,
        expectedCommit: values["expected-commit"],
        expectedVersion: values["expected-version"]
      });
      process.stdout.write(`${JSON.stringify({
        ok: true,
        mode,
        tarball: result.tarball,
        version: result.version,
        commit: result.commit
      })}\n`);
    }
  } catch (error) {
    const summary = sanitizeFailure(
      error?.message,
      cliSensitivePaths(cliArgs)
    );
    process.stderr.write(
      `RELEASE_EVIDENCE_FAILED: ${command}: ${summary}\n`
    );
    process.exitCode = 1;
  }
}
