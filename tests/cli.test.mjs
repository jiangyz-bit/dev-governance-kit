import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFixtureWorkspace } from "./helpers/workspace.mjs";

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(kitRoot, "tooling", "cli.mjs");

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
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function runCli(args) {
  return runNode([cliPath, ...args]);
}

test("apply dry-run emits JSON and writes nothing", async (t) => {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  const result = await runCli(["apply", "--workspace", workspace, "--dry-run", "--json"]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.command, "apply");
  assert.equal(output.ok, true);
  assert.ok(output.report.created.length > 0);
  await assert.rejects(readFile(path.join(workspace, "demo-server", "AGENTS.md"), "utf8"));
});

test("apply then validate succeeds", async (t) => {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  const applied = await runCli(["apply", "--workspace", workspace, "--json"]);
  assert.equal(applied.code, 0);
  assert.equal(JSON.parse(applied.stdout).ok, true);

  const serverRoot = path.join(workspace, "demo-server");
  const generated = await runNode(["scripts/generate-status-registry.mjs"], serverRoot);
  assert.equal(generated.code, 0);
  const checked = await runNode(["scripts/check-status-registry.mjs"], serverRoot);
  assert.equal(checked.code, 0);
  assert.match(checked.stdout, /Status registry check passed\./);

  const validated = await runCli(["validate", "--workspace", workspace, "--json"]);
  assert.equal(validated.code, 0);
  assert.equal(JSON.parse(validated.stdout).report.valid, true);
});

test("apply exits 1 for a user-file conflict", async (t) => {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  await writeFile(path.join(workspace, "demo-server", "AGENTS.md"), "# 用户文件\n", "utf8");
  const result = await runCli(["apply", "--workspace", workspace, "--json"]);
  assert.equal(result.code, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.ok(output.report.conflicts.some((entry) => entry.code === "USER_FILE_CONFLICT"));
});

test("validate exits 1 for registry drift", async (t) => {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  await runCli(["apply", "--workspace", workspace, "--json"]);
  const registry = path.join(workspace, "demo-server", "docs", "STATUS_ENUM_REGISTRY.md");
  await appendFile(registry, "\n漂移\n", "utf8");
  const result = await runCli(["validate", "--workspace", workspace, "--json"]);
  assert.equal(result.code, 1);
  const output = JSON.parse(result.stdout);
  assert.ok(output.report.errors.some((entry) => entry.code === "STATUS_REGISTRY_DRIFT"));
});

test("invalid CLI usage exits 2 and prints usage", async () => {
  const unknown = await runCli(["unknown"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /用法：/);

  const invalidFlag = await runCli(["validate", "--dry-run"]);
  assert.equal(invalidFlag.code, 2);
  assert.match(invalidFlag.stderr, /--dry-run/);
});

test("human-readable mode is Chinese", async (t) => {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  const result = await runCli(["apply", "--workspace", workspace, "--dry-run"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /创建：/);
  assert.match(result.stdout, /冲突：/);
});

test("monorepo apply is idempotent and validates", async (t) => {
  const workspace = await createFixtureWorkspace(t, "monorepo");
  const first = await runCli(["apply", "--workspace", workspace, "--json"]);
  assert.equal(first.code, 0);
  const second = await runCli(["apply", "--workspace", workspace, "--json"]);
  assert.equal(second.code, 0);
  const secondReport = JSON.parse(second.stdout).report;
  assert.equal(secondReport.created.length, 0);
  assert.equal(secondReport.updated.length, 0);
  const validated = await runCli(["validate", "--workspace", workspace, "--json"]);
  assert.equal(validated.code, 0);
});

test("multi-repo apply preserves component Git metadata", async (t) => {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  const markers = [];
  for (const component of ["demo-server", "demo-admin", "demo-miniprogram"]) {
    const marker = path.join(workspace, component, ".git", "governance-test-marker");
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, component, "utf8");
    markers.push({ marker, component });
  }

  const applied = await runCli(["apply", "--workspace", workspace, "--json"]);
  assert.equal(applied.code, 0);
  const validated = await runCli(["validate", "--workspace", workspace, "--json"]);
  assert.equal(validated.code, 0);
  for (const { marker, component } of markers) {
    assert.equal(await readFile(marker, "utf8"), component);
  }
  await assert.rejects(readFile(path.join(workspace, ".git"), "utf8"));
});
