import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("package exposes the governance CLI and supported Node version", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.type, "module");
  assert.equal(pkg.bin["governance-kit"], "./tooling/cli.mjs");
  assert.equal(pkg.engines.node, ">=20");
  assert.equal(pkg.scripts.test, "node --test tests/*.test.mjs");
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
