import assert from "node:assert/strict";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { applyGovernance } from "../tooling/lib/apply.mjs";
import {
  validateRuleIds,
  validateWorkspace
} from "../tooling/lib/validate.mjs";
import { createFixtureWorkspace } from "./helpers/workspace.mjs";

test("validates a clean applied workspace", async (t) => {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  await applyGovernance({ workspaceDir: workspace });
  const report = await validateWorkspace({ workspaceDir: workspace });
  assert.equal(report.valid, true);
  assert.equal(report.errors.length, 0);
});

test("reports unresolved placeholders", async (t) => {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  await applyGovernance({ workspaceDir: workspace });
  const target = path.join(workspace, "demo-admin", "AGENTS.md");
  await appendFile(target, "\n{{BUILD_COMMAND}}\n", "utf8");
  const report = await validateWorkspace({ workspaceDir: workspace });
  assert.ok(report.errors.some((error) =>
    error.code === "UNRESOLVED_PLACEHOLDER" && error.path === target
  ));
});

test("reports a missing managed file", async (t) => {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  await applyGovernance({ workspaceDir: workspace });
  const target = path.join(workspace, "demo-server", "AGENTS.md");
  await rm(target);
  const report = await validateWorkspace({ workspaceDir: workspace });
  assert.ok(report.errors.some((error) =>
    error.code === "MISSING_GENERATED_FILE" && error.path === target
  ));
});

test("reports status registry drift", async (t) => {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  await applyGovernance({ workspaceDir: workspace });
  const target = path.join(workspace, "demo-server", "docs", "STATUS_ENUM_REGISTRY.md");
  const current = await readFile(target, "utf8");
  await writeFile(target, current.replace("`draft`", "`broken`"), "utf8");
  const report = await validateWorkspace({ workspaceDir: workspace });
  assert.ok(report.errors.some((error) => error.code === "STATUS_REGISTRY_DRIFT"));
});

test("rejects duplicate rule IDs", () => {
  assert.throws(
    () => validateRuleIds([
      { path: "one.md", content: "<!-- rule-id: CORE-ARCH-001 -->" },
      { path: "two.md", content: "<!-- rule-id: CORE-ARCH-001 -->" }
    ]),
    (error) => error.code === "DUPLICATE_RULE_ID"
  );
});

test("returns manifest compatibility errors instead of throwing", async (t) => {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  const manifestPath = path.join(workspace, "governance-kit.yaml");
  const source = await readFile(manifestPath, "utf8");
  await writeFile(
    manifestPath,
    source.replace("profile: java-springboot-mybatis", "profile: react-admin"),
    "utf8"
  );
  const report = await validateWorkspace({ workspaceDir: workspace });
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((error) => error.code === "INCOMPATIBLE_PROFILE"));
});
