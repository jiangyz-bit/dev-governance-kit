import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath ?? path.join(
  path.dirname(process.execPath),
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js"
);
const npmCommand = process.platform === "win32" ? process.execPath : "npm";
const npmPrefix = process.platform === "win32" ? [npmCli] : [];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      ...options
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

test("package exposes the governance CLI and supported Node version", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.type, "module");
  assert.equal(pkg.bin["governance-kit"], "./tooling/cli.mjs");
  assert.equal(pkg.engines.node, ">=20");
  assert.equal(pkg.scripts.test, "node --test tests/*.test.mjs");
});

test("package exports only the public initialization entry point", async () => {
  const api = await import("../tooling/index.mjs");
  assert.equal(typeof api.initializeGovernance, "function");
  assert.equal("planInitialization" in api, false);
  assert.equal("executeInitialization" in api, false);
});

test("help advertises init but not the unimplemented create command", async () => {
  const source = await readFile(new URL("../tooling/cli.mjs", import.meta.url), "utf8");
  assert.match(source, /governance-kit init/);
  assert.doesNotMatch(source, /governance-kit create/);
});

test("npm package contains runtime files but excludes internal project material", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "governance-pack-list-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packed = await run(
    npmCommand,
    [
      ...npmPrefix,
      "pack",
      "--dry-run",
      "--json",
      "--pack-destination",
      root
    ],
    { cwd: kitRoot }
  );
  assert.equal(packed.code, 0, packed.stderr);
  const metadata = JSON.parse(packed.stdout);
  assert.equal(metadata.length, 1);
  const files = new Set(metadata[0].files.map((entry) => (
    entry.path.replaceAll("\\", "/")
  )));

  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    "tooling/cli.mjs",
    "tooling/index.mjs",
    "tooling/lib/init.mjs",
    "core/rules/agent-workflow.md",
    "schemas/governance-kit.schema.json",
    "templates/server/AGENTS.md",
    "profiles/java-springboot-mybatis/profile.yaml",
    "blueprints/java-react-wechat.yaml",
    "docs/MANIFEST_REFERENCE.md"
  ]) {
    assert.ok(files.has(required), `安装包缺少运行文件：${required}`);
  }

  for (const leaked of files) {
    assert.equal(/^tests\//.test(leaked), false, `不应发布测试：${leaked}`);
    assert.equal(
      /^docs\/superpowers\//.test(leaked),
      false,
      `不应发布内部设计资料：${leaked}`
    );
    assert.equal(
      leaked === "docs/MIGRATION_FROM_V1_TEMPLATES.md",
      false,
      `不应发布废弃迁移资料：${leaked}`
    );
    assert.equal(
      /^\.superpowers\//.test(leaked),
      false,
      `不应发布工作树 scratch：${leaked}`
    );
  }
});

test("packed CLI runs after a clean local install", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "governance-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packed = await run(
    npmCommand,
    [...npmPrefix, "pack", "--pack-destination", root, "--silent"],
    { cwd: kitRoot }
  );
  assert.equal(packed.code, 0, packed.stderr);
  const archive = (await readdir(root)).find((entry) => entry.endsWith(".tgz"));
  assert.ok(archive, "npm pack 应生成安装包");
  const installed = await run(
    npmCommand,
    [
      ...npmPrefix,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      path.join(root, archive)
    ],
    { cwd: root }
  );
  assert.equal(installed.code, 0, installed.stderr);

  const installedPackage = path.join(
    root,
    "node_modules",
    "dev-governance-kit"
  );
  const installedManifest = JSON.parse(await readFile(
    path.join(installedPackage, "package.json"),
    "utf8"
  ));
  const help = await run(process.execPath, [
    path.join(installedPackage, installedManifest.bin["governance-kit"]),
    "--help"
  ], {
    cwd: root
  });
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /governance-kit init/);
});

test("README documents both supported workflows", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /governance-kit apply/);
  assert.match(readme, /governance-kit validate/);
  for (const heading of [
    "## 它能解决什么问题",
    "## 3 分钟快速开始",
    "## 执行后会得到什么",
    "## 已有项目是否安全",
    "## 交给 AI Agent 使用"
  ]) {
    assert.match(readme, new RegExp(heading));
  }
  for (const legacyText of [
    "V1",
    "第一阶段",
    "第二阶段",
    "第三阶段",
    "MIGRATION_FROM_V1_TEMPLATES"
  ]) {
    assert.doesNotMatch(readme, new RegExp(legacyText));
  }
  assert.ok(readme.split(/\r?\n/).length <= 170, "README 应保持简洁");
});
