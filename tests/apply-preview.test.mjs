import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createApplyPreview,
  executeApplyPreview
} from "../tooling/lib/apply-preview.mjs";
import { writeUtf8Atomic } from "../tooling/lib/files.mjs";
import { loadProjectManifest } from "../tooling/lib/manifest.mjs";
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
