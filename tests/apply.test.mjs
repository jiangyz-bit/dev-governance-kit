import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { applyGovernance } from "../tooling/lib/apply.mjs";
import { createFixtureWorkspace } from "./helpers/workspace.mjs";

test("dry-run reports files without writing them", async (t) => {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  const report = await applyGovernance({ workspaceDir: workspace, dryRun: true });
  assert.ok(report.created.length > 0);
  await assert.rejects(readFile(path.join(workspace, "demo-server", "AGENTS.md"), "utf8"));
});

test("does not overwrite a user-owned AGENTS.md", async (t) => {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  const target = path.join(workspace, "demo-server", "AGENTS.md");
  const nonConflictingTarget = path.join(
    workspace,
    "demo-server",
    "docs",
    "API_RULES.md"
  );
  await writeFile(target, "# 用户规则\n", "utf8");
  const report = await applyGovernance({ workspaceDir: workspace });
  assert.ok(report.conflicts.some((entry) =>
    entry.path === target && entry.code === "USER_FILE_CONFLICT"
  ));
  assert.ok(report.created.some((entry) => entry.path === nonConflictingTarget));
  assert.equal(await readFile(target, "utf8"), "# 用户规则\n");
  assert.notEqual(await readFile(nonConflictingTarget, "utf8"), "");
});

test("a second unchanged apply is idempotent", async (t) => {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  await applyGovernance({ workspaceDir: workspace });
  const second = await applyGovernance({ workspaceDir: workspace });
  assert.equal(second.created.length, 0);
  assert.equal(second.updated.length, 0);
  assert.equal(second.conflicts.length, 0);
  assert.ok(second.unchanged.length > 0);
});

test("does not update a managed file from a different source version", async (t) => {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  const target = path.join(workspace, "demo-server", "AGENTS.md");
  const original = [
    "<!-- governance-kit:managed -->",
    "<!-- source-id: component:server:AGENTS.md -->",
    "<!-- source-version: 0 -->",
    "",
    "# 旧版本",
    ""
  ].join("\n");
  await writeFile(target, original, "utf8");
  const report = await applyGovernance({ workspaceDir: workspace });
  assert.ok(report.conflicts.some((entry) =>
    entry.path === target && entry.code === "SOURCE_VERSION_MISMATCH"
  ));
  assert.equal(await readFile(target, "utf8"), original);
});

test("existing status source is create-only", async (t) => {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  const target = path.join(workspace, "demo-server", "docs", "status-enums.json");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "{\"userOwned\":true}\n", "utf8");
  const report = await applyGovernance({ workspaceDir: workspace });
  assert.ok(report.conflicts.some((entry) =>
    entry.path === target && entry.code === "CREATE_ONLY_EXISTS"
  ));
  assert.equal(await readFile(target, "utf8"), "{\"userOwned\":true}\n");
});
