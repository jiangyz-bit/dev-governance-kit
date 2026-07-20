import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { stringify } from "yaml";
import {
  executeInitialization,
  initializeGovernance,
  planInitialization
} from "../tooling/lib/init.mjs";
import { executeApplyPreview } from "../tooling/lib/apply-preview.mjs";
import { GovernanceError } from "../tooling/lib/errors.mjs";
import { writeUtf8Atomic } from "../tooling/lib/files.mjs";
import { renderInitManifest } from "../tooling/lib/init-manifest.mjs";
import { loadProjectManifest } from "../tooling/lib/manifest.mjs";
import { validateWorkspace } from "../tooling/lib/validate.mjs";
import { createProjectWorkspace } from "./helpers/project-workspace.mjs";

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const componentRelativeDir = "demo-server";

function manifestFor(workspaceDir, {
  name = path.basename(workspaceDir),
  componentPath = componentRelativeDir
} = {}) {
  return {
    schemaVersion: 1,
    project: {
      name,
      repositoryMode: "monorepo"
    },
    components: {
      server: {
        profile: "java-springboot-mybatis",
        path: componentPath
      }
    },
    contracts: {
      statusRegistryOwner: "server",
      apiContractOwner: "server"
    },
    generation: {
      conflictPolicy: "report"
    }
  };
}

async function createSupportedWorkspace(t, {
  manifest,
  manifestSource,
  extraFiles = {}
} = {}) {
  const files = {
    [`${componentRelativeDir}/pom.xml`]: [
      "<project><dependencies>",
      "<dependency><artifactId>spring-boot</artifactId></dependency>",
      "<dependency><artifactId>mybatis</artifactId></dependency>",
      "<dependency><artifactId>flyway</artifactId></dependency>",
      "</dependencies></project>"
    ].join(""),
    ...extraFiles
  };
  const workspaceDir = await createProjectWorkspace(t, {
    directories: [".git"],
    files
  });
  if (manifestSource !== undefined) {
    await writeFile(
      path.join(workspaceDir, "governance-kit.yaml"),
      manifestSource,
      "utf8"
    );
  } else if (manifest !== undefined) {
    await writeFile(
      path.join(workspaceDir, "governance-kit.yaml"),
      renderInitManifest(manifest === true ? manifestFor(workspaceDir) : manifest),
      "utf8"
    );
  }
  return workspaceDir;
}

async function snapshotWorkspace(rootDir, relativeDir = "") {
  const absoluteDir = path.join(rootDir, relativeDir);
  const entries = (await readdir(absoluteDir, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const result = {};
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(result, await snapshotWorkspace(rootDir, relativePath));
    } else if (entry.isFile()) {
      result[relativePath.replaceAll("\\", "/")] = await readFile(
        path.join(rootDir, relativePath),
        "utf8"
      );
    }
  }
  return result;
}

function firstWritablePreviewItem(plan) {
  return plan.applyPreview.operations.find(({ classification }) => (
    classification.category === "created"
    || classification.category === "updated"
  ));
}

test("plans an absent manifest without writing it", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);

  const plan = await planInitialization({ workspaceDir, kitRoot });

  assert.equal(plan.status, "ready");
  assert.equal(plan.manifestChange.category, "created");
  await assert.rejects(
    readFile(path.join(workspaceDir, "governance-kit.yaml"), "utf8"),
    (error) => error.code === "ENOENT"
  );
});

test("uses an existing valid manifest without re-detecting", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t, { manifest: true });
  let detectCalls = 0;

  const plan = await planInitialization({
    workspaceDir,
    kitRoot,
    detect: async () => {
      detectCalls += 1;
      throw new Error("不应重新识别");
    }
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.manifestChange.category, "unchanged");
  assert.equal(plan.source, "existing-manifest");
  assert.equal(detectCalls, 0);
});

test("validates an existing invalid manifest before reconfigure", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t, {
    manifestSource: "schemaVersion: 1\ncomponents: ["
  });
  const before = await snapshotWorkspace(workspaceDir);
  let detectCalls = 0;

  const result = await planInitialization({
    workspaceDir,
    kitRoot,
    reconfigure: true,
    detect: async () => {
      detectCalls += 1;
      throw new Error("不应在无效 Manifest 后识别");
    }
  });

  assert.equal(result.status, "conflict");
  assert.equal(result.code, "INVALID_MANIFEST");
  assert.equal(result.written.length, 0);
  assert.equal(detectCalls, 0);
  assert.deepEqual(await snapshotWorkspace(workspaceDir), before);
  assert.equal("stack" in result.failed, false);
});

test("rejects a schema-incompatible manifest before reconfigure", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t, {
    manifestSource: "schemaVersion: 99\nproject: {}\ncomponents: {}\n"
  });

  const result = await planInitialization({
    workspaceDir,
    kitRoot,
    reconfigure: true
  });

  assert.equal(result.status, "conflict");
  assert.equal(result.code, "INVALID_MANIFEST");
  assert.equal(result.written.length, 0);
});

test("classifies equal and changed reconfigure candidates separately", async (t) => {
  const sameWorkspace = await createSupportedWorkspace(t);
  await writeFile(
    path.join(sameWorkspace, "governance-kit.yaml"),
    renderInitManifest(manifestFor(sameWorkspace)),
    "utf8"
  );
  const changedWorkspace = await createSupportedWorkspace(t, {
    manifest: manifestFor("ignored", { name: "legacy-name" })
  });

  const same = await planInitialization({
    workspaceDir: sameWorkspace,
    kitRoot,
    reconfigure: true
  });
  const changed = await planInitialization({
    workspaceDir: changedWorkspace,
    kitRoot,
    reconfigure: true
  });

  assert.equal(same.status, "ready");
  assert.equal(same.manifestChange.category, "unchanged");
  assert.equal("diff" in same.manifestChange, false);
  assert.equal(changed.status, "ready");
  assert.equal(changed.manifestChange.category, "updated");
  assert.match(changed.manifestChange.diff, /^[-+]/m);
});

test("keeps unconfirmed existing-manifest evidence questions blocking", async (t) => {
  const workspaceDir = await createProjectWorkspace(t, {
    directories: [".git"],
    files: {
      "server/pom.xml": "<project>spring-boot mybatis</project>"
    }
  });
  const manifest = {
    schemaVersion: 1,
    project: { name: "demo", repositoryMode: "monorepo" },
    components: {
      server: { profile: "java-springboot-mybatis", path: "server" }
    },
    contracts: {
      statusRegistryOwner: "server",
      apiContractOwner: "server"
    },
    generation: { conflictPolicy: "report" }
  };
  await writeFile(
    path.join(workspaceDir, "governance-kit.yaml"),
    stringify(manifest),
    "utf8"
  );

  const blocked = await planInitialization({
    workspaceDir,
    kitRoot,
    answers: { yes: true }
  });
  const confirmed = await planInitialization({
    workspaceDir,
    kitRoot,
    answers: {
      questions: {
        "PROFILE_EVIDENCE_MISMATCH:server": { confirmed: true }
      }
    }
  });

  assert.equal(blocked.status, "needs_input");
  assert.equal(blocked.code, "PROFILE_EVIDENCE_MISMATCH");
  assert.equal(confirmed.status, "ready");
});

test("maps empty workspaces to unsupported without producing a plan", async (t) => {
  const workspaceDir = await createProjectWorkspace(t);

  const result = await planInitialization({ workspaceDir, kitRoot });

  assert.equal(result.status, "unsupported");
  assert.equal(result.code, "NO_PROJECT_FOUND");
  assert.equal(result.plan, null);
  assert.equal(result.report, null);
});

test("does not write anything when a governance target conflicts", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t, {
    extraFiles: {
      [`${componentRelativeDir}/AGENTS.md`]: "# 用户规则\n"
    }
  });
  const before = await snapshotWorkspace(workspaceDir);

  const result = await initializeGovernance({
    workspaceDir,
    kitRoot,
    yes: true
  });

  assert.equal(result.status, "conflict");
  assert.equal(result.written.length, 0);
  assert.deepEqual(await snapshotWorkspace(workspaceDir), before);
});

test("permission preflight checks every writable target once and leaves the workspace unchanged", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const before = await snapshotWorkspace(workspaceDir);
  const calls = [];

  const result = await planInitialization({
    workspaceDir,
    kitRoot,
    preflightTargets: async (targets) => {
      calls.push(targets);
      throw new GovernanceError("TARGET_NOT_WRITABLE", "无写入权限");
    }
  });

  assert.equal(result.status, "conflict");
  assert.equal(result.code, "TARGET_NOT_WRITABLE");
  assert.equal(result.written.length, 0);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes(path.join(workspaceDir, "governance-kit.yaml")));
  assert.ok(calls[0].includes(path.join(workspaceDir, componentRelativeDir, "AGENTS.md")));
  assert.deepEqual(await snapshotWorkspace(workspaceDir), before);
});

test("reports stale atomic temporary files in plan warnings without deleting them", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const stalePath = path.join(
    workspaceDir,
    componentRelativeDir,
    ".AGENTS.md.123.123e4567-e89b-42d3-a456-426614174000.tmp"
  );
  await writeFile(stalePath, "保留", "utf8");

  const plan = await planInitialization({ workspaceDir, kitRoot });

  assert.equal(plan.status, "ready");
  assert.ok(plan.report.warnings.some((warning) => (
    warning.code === "STALE_TEMP_FILE"
    && warning.path === stalePath
    && warning.targetPath === path.join(workspaceDir, componentRelativeDir, "AGENTS.md")
  )));
  assert.equal(await readFile(stalePath, "utf8"), "保留");
});

test("still reports stale temporary files when every managed target is unchanged", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const first = await initializeGovernance({
    workspaceDir,
    kitRoot,
    yes: true
  });
  assert.equal(first.status, "applied");
  const stalePath = path.join(
    workspaceDir,
    componentRelativeDir,
    ".AGENTS.md.123.123e4567-e89b-42d3-a456-426614174000.tmp"
  );
  await writeFile(stalePath, "保留", "utf8");

  const plan = await planInitialization({ workspaceDir, kitRoot });

  assert.equal(plan.status, "ready");
  assert.equal(plan.writableTargets.length, 0);
  assert.ok(plan.report.warnings.some((warning) => (
    warning.code === "STALE_TEMP_FILE"
    && warning.path === stalePath
  )));
  assert.equal(await readFile(stalePath, "utf8"), "保留");
});

test("separates internal ready plans from public planned dry-runs", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);

  const plan = await planInitialization({ workspaceDir, kitRoot });
  const result = await initializeGovernance({
    workspaceDir,
    kitRoot,
    dryRun: true
  });

  assert.equal(plan.status, "ready");
  assert.equal(result.status, "planned");
  assert.equal(result.ok, true);
  await assert.rejects(
    readFile(path.join(workspaceDir, "governance-kit.yaml"), "utf8"),
    (error) => error.code === "ENOENT"
  );
});

test("returns a structured prewrite conflict when a target changes after planning", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const plan = await planInitialization({ workspaceDir, kitRoot });
  const changedTarget = firstWritablePreviewItem(plan).operation.targetPath;
  await mkdir(path.dirname(changedTarget), { recursive: true });
  await writeFile(changedTarget, "用户并发修改", "utf8");

  const result = await executeInitialization(plan);

  assert.equal(result.status, "conflict");
  assert.equal(result.code, "TARGET_CHANGED_AFTER_PREVIEW");
  assert.deepEqual(result.written, []);
  assert.equal(await readFile(changedTarget, "utf8"), "用户并发修改");
  await assert.rejects(
    readFile(path.join(workspaceDir, "governance-kit.yaml"), "utf8"),
    (error) => error.code === "ENOENT"
  );
});

test("uses partial_failure only after a file was written", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t, { manifest: true });
  const plan = await planInitialization({ workspaceDir, kitRoot });

  const result = await executeInitialization(plan, {
    executePreview: async () => {
      throw new GovernanceError("INJECTED_FAILURE", "预览执行失败");
    }
  });

  assert.equal(result.status, "conflict");
  assert.equal(result.code, "INJECTED_FAILURE");
  assert.deepEqual(result.written, []);
});

test("returns evidence-backed safe rerun recovery after a partial failure", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const plan = await planInitialization({ workspaceDir, kitRoot });
  const item = firstWritablePreviewItem(plan);

  const result = await executeInitialization(plan, {
    executePreview: async (preview, { signal }) => {
      await writeUtf8Atomic(item.operation.targetPath, item.operation.content, {
        expectedSnapshot: item.snapshot,
        rootDir: preview.context.workspaceDir,
        signal
      });
      throw new GovernanceError("INJECTED_WRITE_FAILURE", "注入写入失败", {
        written: [item.operation.targetPath]
      });
    }
  });

  assert.equal(result.status, "partial_failure");
  assert.equal(result.applied, true);
  assert.equal(result.valid, false);
  assert.deepEqual(result.written, [
    path.join(workspaceDir, "governance-kit.yaml"),
    item.operation.targetPath
  ]);
  assert.equal(result.recovery.safeToRerun, true);
  assert.equal(
    result.recovery.nextCommand,
    "npx dev-governance-kit init --verbose"
  );
});

test("detects a committed manifest when its writer throws after commit", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const plan = await planInitialization({ workspaceDir, kitRoot });

  const result = await executeInitialization(plan, {
    writeFile: async (targetPath, content, options) => {
      await writeUtf8Atomic(targetPath, content, options);
      throw new GovernanceError(
        "INJECTED_POST_COMMIT_FAILURE",
        "提交后注入失败"
      );
    }
  });

  assert.equal(result.status, "partial_failure");
  assert.equal(result.code, "INJECTED_POST_COMMIT_FAILURE");
  assert.deepEqual(result.written, [
    path.join(workspaceDir, "governance-kit.yaml")
  ]);
  assert.equal(result.recovery.safeToRerun, true);
});

test("marks recovery unsafe when written bytes no longer match the plan", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const plan = await planInitialization({ workspaceDir, kitRoot });
  const item = firstWritablePreviewItem(plan);

  const result = await executeInitialization(plan, {
    executePreview: async (preview, { signal }) => {
      await writeUtf8Atomic(item.operation.targetPath, item.operation.content, {
        expectedSnapshot: item.snapshot,
        rootDir: preview.context.workspaceDir,
        signal
      });
      await writeFile(item.operation.targetPath, "用户修改", "utf8");
      throw new GovernanceError("INJECTED_WRITE_FAILURE", "注入写入失败", {
        written: [item.operation.targetPath]
      });
    }
  });

  assert.equal(result.status, "partial_failure");
  assert.equal(result.recovery.safeToRerun, false);
});

test("never overwrites a user edit made after a partial failure", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const plan = await planInitialization({ workspaceDir, kitRoot });
  const item = firstWritablePreviewItem(plan);
  const first = await executeInitialization(plan, {
    executePreview: async (preview, { signal }) => {
      await writeUtf8Atomic(item.operation.targetPath, item.operation.content, {
        expectedSnapshot: item.snapshot,
        rootDir: preview.context.workspaceDir,
        signal
      });
      throw new GovernanceError("INJECTED_WRITE_FAILURE", "注入写入失败", {
        written: [item.operation.targetPath]
      });
    }
  });
  await writeFile(item.operation.targetPath, "user edit", "utf8");
  const before = await snapshotWorkspace(workspaceDir);

  const rerun = await initializeGovernance({
    workspaceDir,
    kitRoot,
    yes: true
  });

  assert.equal(first.status, "partial_failure");
  assert.equal(rerun.status, "conflict");
  assert.deepEqual(await snapshotWorkspace(workspaceDir), before);
});

test("reports validation failure as applied true and valid false", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const plan = await planInitialization({ workspaceDir, kitRoot });

  const result = await executeInitialization(plan, {
    validate: async () => ({
      valid: false,
      checks: [],
      warnings: [],
      errors: [{ code: "INJECTED" }]
    })
  });

  assert.equal(result.status, "failed_validation");
  assert.equal(result.applied, true);
  assert.equal(result.valid, false);
  assert.ok(result.written.length > 0);
});

test("a second initialization is unchanged and valid", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);

  const first = await initializeGovernance({
    workspaceDir,
    kitRoot,
    yes: true
  });
  const second = await initializeGovernance({
    workspaceDir,
    kitRoot,
    yes: true
  });

  assert.equal(first.status, "applied");
  assert.equal(second.status, "applied");
  assert.equal(second.valid, true);
  assert.equal(second.report.created.length, 0);
  assert.equal(second.report.updated.length, 0);
});

test("returns interrupted when planning is aborted between scan and detection", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const controller = new AbortController();
  const before = await snapshotWorkspace(workspaceDir);

  const result = await planInitialization({
    workspaceDir,
    kitRoot,
    signal: controller.signal,
    detect: async (options) => {
      controller.abort();
      return options.scan;
    }
  });

  assert.equal(result.status, "interrupted");
  assert.equal(result.code, "INTERRUPTED");
  assert.equal(result.written.length, 0);
  assert.deepEqual(await snapshotWorkspace(workspaceDir), before);
});

test("returns interrupted when existing-manifest loading aborts after its snapshot", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t, { manifest: true });
  const controller = new AbortController();
  const before = await snapshotWorkspace(workspaceDir);

  const result = await planInitialization({
    workspaceDir,
    kitRoot,
    signal: controller.signal,
    loadManifest: async (...args) => {
      controller.abort();
      return loadProjectManifest(...args);
    }
  });

  assert.equal(result.status, "interrupted");
  assert.equal(result.code, "INTERRUPTED");
  assert.deepEqual(await snapshotWorkspace(workspaceDir), before);
});

test("validation honors AbortSignal with a stable INTERRUPTED error", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t, { manifest: true });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    validateWorkspace({
      workspaceDir,
      kitRoot,
      signal: controller.signal
    }),
    (error) => error.code === "INTERRUPTED"
  );
});

test("validation interruption after writes reports exact recovery state", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const plan = await planInitialization({ workspaceDir, kitRoot });
  const controller = new AbortController();
  let receivedSignal;

  const result = await executeInitialization(plan, {
    signal: controller.signal,
    validate: async ({ signal }) => {
      receivedSignal = signal;
      controller.abort();
      throw new GovernanceError("INTERRUPTED", "验证中断");
    }
  });

  assert.equal(receivedSignal, controller.signal);
  assert.equal(result.status, "interrupted");
  assert.equal(result.code, "INTERRUPTED");
  assert.equal(result.applied, true);
  assert.ok(result.written.length > 1);
  assert.equal(result.recovery.safeToRerun, true);
});

test("executeInitialization uses the supplied preview and never replans through apply", async (t) => {
  const workspaceDir = await createSupportedWorkspace(t);
  const plan = await planInitialization({ workspaceDir, kitRoot });
  let suppliedPreview;

  const result = await executeInitialization(plan, {
    executePreview: async (preview, options) => {
      suppliedPreview = preview;
      return executeApplyPreview(preview, options);
    }
  });

  assert.equal(suppliedPreview, plan.applyPreview);
  assert.equal(result.status, "applied");
});
