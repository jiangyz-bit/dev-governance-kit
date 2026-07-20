#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(kitRoot, "package.json");
const packageName = "dev-governance-kit";
const registry = "https://registry.npmjs.org/";
const repositoryUrl =
  "https://github.com/jiangyz-bit/dev-governance-kit.git";
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const prereleaseIdentifier =
  "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const publishedVersionPattern = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)`
  + `(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?`
  + "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$"
);
const maximumFailureBytes = 900;

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

function assertStableVersion(value, label) {
  if (typeof value !== "string" || !stableVersionPattern.test(value)) {
    throw new Error(`${label} 必须是无前缀的稳定 SemVer`);
  }
}

function assertPublishedVersion(value, label) {
  if (typeof value !== "string" || !publishedVersionPattern.test(value)) {
    throw new Error(`${label} 包含无效 npm 版本`);
  }
}

function assertExactObject(value, expected, label) {
  assertPlainObject(value, label);
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
    || expectedKeys.some((key) => value[key] !== expected[key])
  ) {
    throw new Error(`${label} 不符合发布策略`);
  }
}

export function normalizePublishedVersions(value) {
  const versions = typeof value === "string"
    ? [value]
    : value;
  if (!Array.isArray(versions)) {
    throw new Error("npm registry 版本 JSON 必须是字符串或数组");
  }
  const seen = new Set();
  for (let index = 0; index < versions.length; index += 1) {
    const version = versions[index];
    assertPublishedVersion(version, `npm registry 版本[${index}]`);
    if (seen.has(version)) {
      throw new Error("npm registry 版本数组不能包含重复版本");
    }
    seen.add(version);
  }
  return [...versions];
}

export function verifyRelease(input) {
  assertPlainObject(input, "verifyRelease 输入");
  const inputKeys = Object.keys(input).sort();
  if (
    inputKeys.length !== 3
    || inputKeys[0] !== "packageJson"
    || inputKeys[1] !== "publishedVersions"
    || inputKeys[2] !== "tag"
  ) {
    throw new Error("verifyRelease 输入字段不符合 schema");
  }
  const { tag, packageJson, publishedVersions } = input;
  if (typeof tag !== "string") {
    throw new Error("Release tag 必须是字符串");
  }
  assertPlainObject(packageJson, "packageJson");
  if (!Array.isArray(publishedVersions)) {
    throw new Error("publishedVersions 必须是字符串数组");
  }
  const normalizedVersions = normalizePublishedVersions(publishedVersions);
  assertStableVersion(packageJson.version, "package.json version");
  if (tag !== `v${packageJson.version}`) {
    throw new Error("Release tag 与 package.json.version 不一致");
  }
  if (normalizedVersions.includes(packageJson.version)) {
    throw new Error(`npm 版本已存在：${packageJson.version}`);
  }
  if (Object.hasOwn(packageJson, "private")) {
    throw new Error("package.json 仍包含 private");
  }
  if (packageJson.name !== packageName) {
    throw new Error(`package.json name 必须是 ${packageName}`);
  }
  if (packageJson.author !== "coogle") {
    throw new Error("package.json author 必须是 coogle");
  }
  if (packageJson.license !== "MIT") {
    throw new Error("package.json license 必须是 MIT");
  }
  assertExactObject(packageJson.repository, {
    type: "git",
    url: repositoryUrl
  }, "package.json repository");
  assertExactObject(packageJson.publishConfig, {
    access: "public",
    registry
  }, "package.json publishConfig");
  assertExactObject(packageJson.engines, {
    node: ">=20.3.0"
  }, "package.json engines");
  assertExactObject(packageJson.bin, {
    "dev-governance-kit": "./tooling/cli.mjs",
    "governance-kit": "./tooling/cli.mjs"
  }, "package.json bin");
  return {
    ok: true,
    package: packageName,
    version: packageJson.version,
    tag
  };
}

function runNpmCommand(file, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      ...options,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    const maximumOutputBytes = 1024 * 1024;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const collect = (target) => (chunk) => {
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes > maximumOutputBytes) {
        child.kill();
        return;
      }
      if (target === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (outputBytes > maximumOutputBytes) {
        reject(new Error("npm registry 查询输出过大"));
        return;
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function isOfficialPackageNotFound(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  return result.code !== 0
    && /\bE404\b/.test(output)
    && /(?:404 )?Not Found - GET https:\/\/registry\.npmjs\.org\/dev-governance-kit - Not found/i.test(output);
}

export async function queryPublishedVersions({
  npmCliPath,
  runCommand = runNpmCommand
} = {}) {
  if (
    typeof npmCliPath !== "string"
    || npmCliPath.length === 0
    || path.basename(npmCliPath).toLowerCase() !== "npm-cli.js"
  ) {
    throw new Error("无法定位可信的 npm-cli.js");
  }
  const result = await runCommand(process.execPath, [
    npmCliPath,
    "view",
    packageName,
    "versions",
    "--json",
    `--registry=${registry}`
  ], {
    cwd: kitRoot,
    shell: false,
    env: { ...process.env }
  });
  if (
    result === null
    || typeof result !== "object"
    || Array.isArray(result)
    || !Number.isInteger(result.code)
    || typeof result.stdout !== "string"
    || typeof result.stderr !== "string"
  ) {
    throw new Error("npm registry 查询返回了无效执行结果");
  }
  if (result.code !== 0) {
    if (isOfficialPackageNotFound(result)) return [];
    throw new Error(`npm registry 查询失败：${result.stderr || result.stdout}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`npm registry 返回的 JSON 无效：${error.message}`);
  }
  return normalizePublishedVersions(parsed);
}

function resolveNpmCliPath() {
  const candidate = process.env.npm_execpath;
  if (
    typeof candidate === "string"
    && path.basename(candidate).toLowerCase() === "npm-cli.js"
  ) {
    return path.resolve(candidate);
  }
  return path.resolve(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js"
  );
}

function parseCliArgs(args) {
  if (
    args.length !== 2
    || args[0] !== "--tag"
    || typeof args[1] !== "string"
    || args[1].length === 0
  ) {
    throw new Error("参数格式必须是 --tag v<version>");
  }
  return { tag: args[1] };
}

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
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  for (const sensitivePath of [...new Set(sensitivePaths.filter(Boolean))]
    .map((value) => path.resolve(String(value)))
    .sort((left, right) => right.length - left.length)) {
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
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return limitUtf8(output || "未知错误", maximumFailureBytes);
}

function isDirectExecution() {
  return process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
  const args = process.argv.slice(2);
  const npmCliPath = resolveNpmCliPath();
  try {
    const { tag } = parseCliArgs(args);
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    const publishedVersions = await queryPublishedVersions({ npmCliPath });
    const result = verifyRelease({ tag, packageJson, publishedVersions });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const summary = sanitizeFailure(error?.message, [
      process.cwd(),
      kitRoot,
      packagePath,
      npmCliPath
    ]);
    process.stderr.write(`RELEASE_VERIFY_FAILED: ${summary}\n`);
    process.exitCode = 1;
  }
}
