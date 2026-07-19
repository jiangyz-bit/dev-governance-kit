import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertRealPathInside,
  assertSnapshotUnchanged,
  preflightWritableTargets,
  snapshotPath,
  writeUtf8Atomic
} from "../tooling/lib/files.mjs";

async function makeWorkspace(t) {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "governance-files-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  return workspaceDir;
}

async function createLink(t, target, link, type) {
  try {
    await symlink(target, link, type);
    return true;
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      t.skip("当前环境不允许创建符号链接");
      return false;
    }
    throw error;
  }
}

test("rejects a component symlink that resolves outside the workspace", async (t) => {
  const workspaceDir = await makeWorkspace(t);
  const outsideDir = await mkdtemp(path.join(tmpdir(), "governance-outside-"));
  t.after(() => rm(outsideDir, { recursive: true, force: true }));
  const linkedPath = path.join(workspaceDir, "server");
  if (!await createLink(t, outsideDir, linkedPath, process.platform === "win32" ? "junction" : "dir")) return;

  await assert.rejects(
    assertRealPathInside(workspaceDir, linkedPath, { allowMissing: false }),
    (error) => error.code === "UNSAFE_REAL_PATH"
  );
});

test("rejects a linked ancestor even when it resolves inside workspace", async (t) => {
  const workspaceDir = await makeWorkspace(t);
  const actualDir = path.join(workspaceDir, "actual");
  await mkdir(actualDir);
  await writeFile(path.join(actualDir, "file.txt"), "safe", "utf8");
  const linkedDir = path.join(workspaceDir, "linked");
  if (!await createLink(t, actualDir, linkedDir, "dir")) return;

  await assert.rejects(
    assertRealPathInside(workspaceDir, path.join(linkedDir, "file.txt"), { allowMissing: true }),
    (error) => error.code === "UNSAFE_REAL_PATH"
  );
});

test("rejects a linked file inside workspace", async (t) => {
  const workspaceDir = await makeWorkspace(t);
  const target = path.join(workspaceDir, "target.txt");
  const linked = path.join(workspaceDir, "linked.txt");
  await writeFile(target, "safe", "utf8");
  if (!await createLink(t, target, linked, "file")) return;

  await assert.rejects(
    assertRealPathInside(workspaceDir, linked, { allowMissing: false }),
    (error) => error.code === "UNSAFE_REAL_PATH"
  );
});

test("detects a target changed after preview", async (t) => {
  const workspaceDir = await makeWorkspace(t);
  const target = path.join(workspaceDir, "target.txt");
  await writeFile(target, "before", "utf8");
  const snapshot = await snapshotPath(target);
  await writeFile(target, "changed", "utf8");

  await assert.rejects(
    assertSnapshotUnchanged(snapshot),
    (error) => error.code === "TARGET_CHANGED_AFTER_PREVIEW"
  );
});

test("detects a same-content file replacement after preview", async (t) => {
  const workspaceDir = await makeWorkspace(t);
  const target = path.join(workspaceDir, "target.txt");
  const replacement = path.join(workspaceDir, "replacement.txt");
  await writeFile(target, "same", "utf8");
  const snapshot = await snapshotPath(target);
  await writeFile(replacement, "same", "utf8");
  await rm(target);
  await (await import("node:fs/promises")).rename(replacement, target);

  await assert.rejects(
    assertSnapshotUnchanged(snapshot),
    (error) => error.code === "TARGET_CHANGED_AFTER_PREVIEW"
  );
});

test("preflights every target parent before any write", async (t) => {
  const workspaceDir = await makeWorkspace(t);
  const writableTarget = path.join(workspaceDir, "new-dir", "writable.txt");
  const blockedParent = path.join(workspaceDir, "not-a-directory");
  const deniedTarget = path.join(blockedParent, "denied.txt");
  await writeFile(blockedParent, "not a directory", "utf8");

  await assert.rejects(
    preflightWritableTargets([writableTarget, deniedTarget]),
    (error) => error.code === "TARGET_NOT_WRITABLE"
  );
  await assert.rejects(access(path.dirname(writableTarget)));
  assert.equal(await readFile(blockedParent, "utf8"), "not a directory");
});

test("writes atomically only when the preview snapshot remains current", async (t) => {
  const workspaceDir = await makeWorkspace(t);
  const target = path.join(workspaceDir, "target.txt");
  await writeFile(target, "before", "utf8");
  const snapshot = await snapshotPath(target);

  await writeUtf8Atomic(target, "after", { expectedSnapshot: snapshot });

  assert.equal(await readFile(target, "utf8"), "after");
});

test("does not overwrite a target that appeared after preview", async (t) => {
  const workspaceDir = await makeWorkspace(t);
  const target = path.join(workspaceDir, "target.txt");
  const snapshot = await snapshotPath(target);
  await writeFile(target, "other process", "utf8");

  await assert.rejects(
    writeUtf8Atomic(target, "ours", { expectedSnapshot: snapshot }),
    (error) => error.code === "TARGET_CHANGED_AFTER_PREVIEW"
  );
  assert.equal(await readFile(target, "utf8"), "other process");
});

test("stops before writing when the signal is already aborted", async (t) => {
  const workspaceDir = await makeWorkspace(t);
  const target = path.join(workspaceDir, "target.txt");
  const signal = AbortSignal.abort();

  await assert.rejects(
    writeUtf8Atomic(target, "content", { signal }),
    (error) => error.name === "AbortError"
  );
  await assert.rejects(readFile(target, "utf8"), { code: "ENOENT" });
});
