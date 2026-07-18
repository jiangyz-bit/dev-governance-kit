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
  assert.match(readme, /已有项目/);
  assert.match(readme, /新项目/);
});
