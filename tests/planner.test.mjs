import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadProjectManifest } from "../tooling/lib/manifest.mjs";
import { buildApplyPlan } from "../tooling/lib/planner.mjs";

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesRoot = path.join(kitRoot, "tests", "fixtures");

async function withManifest(t, source) {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "governance-manifest-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  await writeFile(path.join(workspaceDir, "governance-kit.yaml"), source, "utf8");
  return workspaceDir;
}

test("resolves multi-repo and monorepo component roots", async () => {
  const multi = await loadProjectManifest(path.join(fixturesRoot, "multi-repo"), kitRoot);
  assert.equal(multi.manifest.project.repositoryMode, "multi-repo");
  assert.equal(path.basename(multi.components.server.rootDir), "demo-server");
  assert.equal(path.basename(multi.components.client.rootDir), "demo-miniprogram");

  const mono = await loadProjectManifest(path.join(fixturesRoot, "monorepo"), kitRoot);
  assert.equal(mono.manifest.project.repositoryMode, "monorepo");
  assert.equal(path.relative(mono.workspaceDir, mono.components.admin.rootDir), path.join("apps", "admin"));
});

test("plans Core, shared, component, and Profile content without placeholders", async () => {
  const context = await loadProjectManifest(path.join(fixturesRoot, "multi-repo"), kitRoot);
  const plan = await buildApplyPlan(context);
  for (const componentType of ["server", "admin", "client"]) {
    assert.ok(plan.operations.some((operation) =>
      operation.component === componentType
      && operation.targetPath.endsWith(path.join("docs", "governance", "architecture.md"))
    ));
    assert.ok(plan.operations.some((operation) =>
      operation.component === componentType
      && operation.targetPath.endsWith(path.join("docs", "governance", "TECH_STACK.md"))
    ));
  }
  assert.ok(plan.operations.some((operation) =>
    operation.component === "client"
    && operation.sourcePath.endsWith(path.join("templates", "miniprogram", "AGENTS.md"))
  ));
  assert.ok(plan.operations.every((operation) =>
    !operation.content.includes("{{") && !operation.content.includes("}}")
  ));
  for (const operation of plan.operations) {
    const componentRoot = context.components[operation.component].rootDir;
    const relative = path.relative(componentRoot, operation.targetPath);
    assert.ok(!relative.startsWith("..") && !path.isAbsolute(relative));
  }
});

test("rejects an unknown contract owner", async (t) => {
  const workspaceDir = await withManifest(t, `
schemaVersion: 1
project: { name: demo, repositoryMode: monorepo }
components:
  admin: { profile: react-admin, path: admin }
contracts: { statusRegistryOwner: server, apiContractOwner: admin }
generation: { conflictPolicy: report }
`);
  await assert.rejects(
    loadProjectManifest(workspaceDir, kitRoot),
    (error) => error.code === "UNKNOWN_CONTRACT_OWNER"
  );
});

test("rejects an incompatible Profile", async (t) => {
  const workspaceDir = await withManifest(t, `
schemaVersion: 1
project: { name: demo, repositoryMode: monorepo }
components:
  server: { profile: react-admin, path: server }
contracts: { statusRegistryOwner: server, apiContractOwner: server }
generation: { conflictPolicy: report }
`);
  await assert.rejects(
    loadProjectManifest(workspaceDir, kitRoot),
    (error) => error.code === "INCOMPATIBLE_PROFILE"
  );
});

test("rejects component paths outside the workspace", async (t) => {
  const workspaceDir = await withManifest(t, `
schemaVersion: 1
project: { name: demo, repositoryMode: monorepo }
components:
  server: { profile: java-springboot-mybatis, path: ../server }
contracts: { statusRegistryOwner: server, apiContractOwner: server }
generation: { conflictPolicy: report }
`);
  await assert.rejects(
    loadProjectManifest(workspaceDir, kitRoot),
    (error) => error.code === "UNSAFE_PATH"
  );
});
