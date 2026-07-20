#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(kitRoot, "package.json");
const packageName = "dev-governance-kit";
const registry = "https://registry.npmjs.org/";
const registryEndpoint = `${registry}${packageName}`;
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
const defaultMaximumResponseBytes = 4 * 1024 * 1024;
const registryTimeoutMilliseconds = 10_000;

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

async function readBoundedRegistryBody(response, maximumBytes) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(0|[1-9]\d*)$/.test(contentLength)) {
      throw new Error("npm registry content-length 无效");
    }
    if (BigInt(contentLength) > BigInt(maximumBytes)) {
      throw new Error("npm registry 响应过大");
    }
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error("npm registry 响应缺少可读取的 body");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error("npm registry 响应 body 类型无效");
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("npm registry 响应过大");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, total)
    );
  } catch (error) {
    throw new Error(`npm registry 响应不是有效 UTF-8：${error.message}`);
  }
}

function parseRegistryJson(source) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`npm registry 返回的 JSON 无效：${error.message}`);
  }
}

function compareStableVersions(left, right) {
  const leftParts = left.split(".").map(BigInt);
  const rightParts = right.split(".").map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

function versionsFromPackument(value) {
  assertPlainObject(value, "npm registry 文档");
  if (value.name !== packageName) {
    throw new Error("npm registry 文档 name 不匹配");
  }
  assertPlainObject(value.versions, "npm registry 文档 versions");
  const stableVersions = [];
  for (const [version, descriptor] of Object.entries(value.versions)) {
    assertPublishedVersion(version, "npm registry version key");
    assertPlainObject(descriptor, `npm registry version ${version}`);
    if (
      descriptor.name !== packageName
      || descriptor.version !== version
    ) {
      throw new Error(`npm registry version ${version} 元数据矛盾`);
    }
    if (stableVersionPattern.test(version)) stableVersions.push(version);
  }
  return stableVersions.sort(compareStableVersions);
}

function assertRegistryResponse(response) {
  if (
    response === null
    || typeof response !== "object"
    || !Number.isInteger(response.status)
    || typeof response.url !== "string"
    || typeof response.redirected !== "boolean"
    || response.headers === null
    || typeof response.headers !== "object"
    || typeof response.headers.get !== "function"
  ) {
    throw new Error("npm registry 返回了无效响应结构");
  }
  if (response.redirected || response.url !== registryEndpoint) {
    throw new Error("npm registry 响应 URL 不符合固定端点");
  }
  const contentType = response.headers.get("content-type");
  if (
    typeof contentType !== "string"
    || !/(?:^|[+/.-])json(?:$|[;\s])/i.test(contentType)
  ) {
    throw new Error("npm registry 响应 content-type 不是 JSON");
  }
}

function isExactNotFound(value) {
  return (
    value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === 1
    && value.error === "Not found"
  );
}

export async function queryPublishedVersions({
  fetchImpl = globalThis.fetch,
  maximumResponseBytes = defaultMaximumResponseBytes
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl 必须是函数");
  }
  if (
    !Number.isSafeInteger(maximumResponseBytes)
    || maximumResponseBytes < 1
  ) {
    throw new Error("maximumResponseBytes 必须是正整数");
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    registryTimeoutMilliseconds
  );
  timeout.unref?.();
  try {
    let response;
    try {
      response = await fetchImpl(registryEndpoint, {
        method: "GET",
        headers: {
          accept: "application/vnd.npm.install-v1+json"
        },
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: controller.signal
      });
    } catch (error) {
      throw new Error(`npm registry 查询失败：${error.message}`);
    }
    assertRegistryResponse(response);
    if (response.status !== 200 && response.status !== 404) {
      throw new Error(`npm registry 查询失败：HTTP ${response.status}`);
    }
    const source = await readBoundedRegistryBody(
      response,
      maximumResponseBytes
    );
    const value = parseRegistryJson(source);
    if (response.status === 404) {
      if (!isExactNotFound(value)) {
        throw new Error("npm registry 404 响应无法确认包不存在");
      }
      return [];
    }
    return versionsFromPackument(value);
  } finally {
    clearTimeout(timeout);
  }
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

function redactCredentials(source) {
  let output = source.replace(
    /\b(https?):\/\/[^@\s/?#]+@/gi,
    "$1://<凭据已隐藏>@"
  );
  output = output.replace(
    /(["']?Authorization["']?\s*[:=]\s*)(?:"(?:Basic|Bearer)\s+[^"\r\n]*"|'(?:Basic|Bearer)\s+[^'\r\n]*'|(?:Basic|Bearer)\s+[^\s,;}\]]+)/gi,
    "$1<凭据已隐藏>"
  );
  output = output.replace(
    /(\bnpm_[A-Za-z0-9_.:/-]+\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/gi,
    "$1<凭据已隐藏>"
  );
  return output.replace(
    /(["']?(?:_authToken|_auth|password|token|secret|apiKey)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/gi,
    "$1<凭据已隐藏>"
  );
}

export function sanitizeReleaseFailure(source, sensitivePaths = []) {
  let output = redactCredentials(String(source ?? "未知错误"))
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
  try {
    const { tag } = parseCliArgs(args);
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    const publishedVersions = await queryPublishedVersions();
    const result = verifyRelease({ tag, packageJson, publishedVersions });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const summary = sanitizeReleaseFailure(error?.message, [
      process.cwd(),
      kitRoot,
      packagePath
    ]);
    process.stderr.write(`RELEASE_VERIFY_FAILED: ${summary}\n`);
    process.exitCode = 1;
  }
}
