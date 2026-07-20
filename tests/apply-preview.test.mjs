import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createApplyPreview,
  executeApplyPreview
} from "../tooling/lib/apply-preview.mjs";
import { snapshotPath, writeUtf8Atomic } from "../tooling/lib/files.mjs";
import { loadProjectManifest } from "../tooling/lib/manifest.mjs";
import { buildApplyPlan } from "../tooling/lib/planner.mjs";
import { createFixtureWorkspace } from "./helpers/workspace.mjs";

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function createPreview(t, options = {}) {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  const context = await loadProjectManifest(workspace, kitRoot);
  const preview = await createApplyPreview({ context, ...options });
  return { preview, workspace };
}

test("classifies all operations without writing", async (t) => {
  const { preview } = await createPreview(t);
  assert.ok(preview.report.created.length > 0);
  assert.equal(preview.operations.length, preview.report.created.length);

  const firstTarget = preview.operations[0].operation.targetPath;
  await assert.rejects(
    readFile(firstTarget, "utf8"),
    (error) => error.code === "ENOENT"
  );
});

test("classifies from one captured handle without retaining captured content", async (t) => {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  const context = await loadProjectManifest(workspace, kitRoot);
  const plan = await buildApplyPlan(context);
  const firstOperation = plan.operations[0];
  const capturedUserContent = "captured user secret";
  await mkdir(path.dirname(firstOperation.targetPath), { recursive: true });
  await writeFile(firstOperation.targetPath, firstOperation.content, "utf8");
  let captureCalls = 0;

  const preview = await createApplyPreview({
    context,
    capturePath: async (targetPath) => {
      captureCalls += 1;
      if (targetPath !== firstOperation.targetPath) {
        return snapshotPath(targetPath, { includeContent: true });
      }
      await writeFile(targetPath, capturedUserContent, "utf8");
      const capture = await snapshotPath(targetPath, { includeContent: true });
      await writeFile(targetPath, firstOperation.content, "utf8");
      return capture;
    }
  });

  const firstItem = preview.operations.find(
    (item) => item.operation.targetPath === firstOperation.targetPath
  );
  assert.equal(captureCalls, preview.operations.length);
  assert.equal(firstItem.classification.category, "conflicts");
  assert.equal(firstItem.classification.entry.code, "USER_FILE_CONFLICT");
  assert.equal("content" in firstItem.snapshot, false);
  assert.equal(JSON.stringify(firstItem.snapshot).includes(capturedUserContent), false);
  assert.equal(JSON.stringify(preview.report).includes(capturedUserContent), false);
});

test("stops before writing if any previewed target changed", async (t) => {
  const { preview } = await createPreview(t);
  const changedTarget = preview.operations[0].operation.targetPath;
  const untouchedTarget = preview.operations[1].operation.targetPath;
  await mkdir(path.dirname(changedTarget), { recursive: true });
  await writeFile(changedTarget, "user change", "utf8");

  await assert.rejects(
    executeApplyPreview(preview, { allowConflicts: false }),
    (error) =>
      error.code === "TARGET_CHANGED_AFTER_PREVIEW"
      && error.details.written.length === 0
  );
  assert.equal(await readFile(changedTarget, "utf8"), "user change");
  await assert.rejects(
    readFile(untouchedTarget, "utf8"),
    (error) => error.code === "ENOENT"
  );
});

test("rejects static conflicts without writing any target", async (t) => {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  const conflictingTarget = path.join(workspace, "demo-server", "AGENTS.md");
  await writeFile(conflictingTarget, "# 用户规则\n", "utf8");
  const context = await loadProjectManifest(workspace, kitRoot);
  const preview = await createApplyPreview({ context });
  const nonConflictingItem = preview.operations.find(
    (item) => item.classification.category === "created"
  );

  await assert.rejects(
    executeApplyPreview(preview, { allowConflicts: false }),
    (error) =>
      error.code === "INIT_CONFLICT"
      && error.details.conflicts.some((entry) => entry.path === conflictingTarget)
  );
  assert.equal(await readFile(conflictingTarget, "utf8"), "# 用户规则\n");
  await assert.rejects(
    readFile(nonConflictingItem.operation.targetPath, "utf8"),
    (error) => error.code === "ENOENT"
  );
});

test("never overwrites a later target changed after an earlier write", async (t) => {
  const { preview } = await createPreview(t);
  const firstTarget = preview.operations[0].operation.targetPath;
  const changedTarget = preview.operations[1].operation.targetPath;
  let caught;

  try {
    await executeApplyPreview(preview, {
      allowConflicts: false,
      writeFile: async (target, content, options) => {
        await writeUtf8Atomic(target, content, options);
        if (target === firstTarget) {
          await writeFile(changedTarget, "concurrent user change", "utf8");
        }
      }
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(await readFile(changedTarget, "utf8"), "concurrent user change");
  assert.equal(caught?.code, "TARGET_CHANGED_AFTER_PREVIEW");
  assert.deepEqual(caught?.details.written, [firstTarget]);
});

test("reports a stable interruption without writing", async (t) => {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  const context = await loadProjectManifest(workspace, kitRoot);
  const previewController = new AbortController();
  previewController.abort();

  await assert.rejects(
    createApplyPreview({ context, signal: previewController.signal }),
    (error) => error.code === "INTERRUPTED"
  );

  const preview = await createApplyPreview({ context });
  const executeController = new AbortController();
  executeController.abort();
  await assert.rejects(
    executeApplyPreview(preview, {
      allowConflicts: false,
      signal: executeController.signal
    }),
    (error) =>
      error.code === "INTERRUPTED"
      && error.details.written.length === 0
  );
  await assert.rejects(
    readFile(preview.operations[0].operation.targetPath, "utf8"),
    (error) => error.code === "ENOENT"
  );
});
