import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertRealPathInside,
  assertSnapshotUnchanged,
  detectStaleTempFiles,
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

test("rejects a workspace root that is itself a symlink or junction", async (t) => {
  const parentDir = await makeWorkspace(t);
  const actualRoot = path.join(parentDir, "actual-root");
  const linkedRoot = path.join(parentDir, "linked-root");
  await mkdir(actualRoot);
  await writeFile(path.join(actualRoot, "file.txt"), "safe", "utf8");
  if (!await createLink(
    t,
    actualRoot,
    linkedRoot,
    process.platform === "win32" ? "junction" : "dir"
  )) return;

  await assert.rejects(
    assertRealPathInside(linkedRoot, path.join(linkedRoot, "file.txt"), {
      allowMissing: false
    }),
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

test("allows a workspace reached through a linked external ancestor", async (t) => {
  const parentDir = await makeWorkspace(t);
  const actualParent = path.join(parentDir, "actual-parent");
  const linkedParent = path.join(parentDir, "linked-parent");
  const actualWorkspace = path.join(actualParent, "workspace");
  await mkdir(actualWorkspace, { recursive: true });
  if (!await createLink(
    t,
    actualParent,
    linkedParent,
    process.platform === "win32" ? "junction" : "dir"
  )) return;

  const workspaceDir = path.join(linkedParent, "workspace");
  const target = path.join(workspaceDir, "created.txt");
  await preflightWritableTargets([target], { rootDir: workspaceDir });
  await writeUtf8Atomic(target, "safe", { rootDir: workspaceDir });

  assert.equal(await readFile(path.join(actualWorkspace, "created.txt"), "utf8"), "safe");
});

test("preflight rejects when its scope root is itself a link", async (t) => {
  const parentDir = await makeWorkspace(t);
  const actualRoot = path.join(parentDir, "actual-root");
  const linkedRoot = path.join(parentDir, "linked-root");
  await mkdir(actualRoot);
  if (!await createLink(
    t,
    actualRoot,
    linkedRoot,
    process.platform === "win32" ? "junction" : "dir"
  )) return;

  await assert.rejects(
    preflightWritableTargets(
      [path.join(linkedRoot, "created.txt")],
      { rootDir: linkedRoot }
    ),
    (error) =>
      error.code === "TARGET_NOT_WRITABLE"
      && error.details?.cause === "UNSAFE_REAL_PATH"
  );
});

test("preflight rejects a link inside its scope", async (t) => {
  const workspaceDir = await makeWorkspace(t);
  const actualDir = path.join(workspaceDir, "actual");
  const linkedDir = path.join(workspaceDir, "linked");
  await mkdir(actualDir);
  if (!await createLink(
    t,
    actualDir,
    linkedDir,
    process.platform === "win32" ? "junction" : "dir"
  )) return;

  await assert.rejects(
    preflightWritableTargets(
      [path.join(linkedDir, "created.txt")],
      { rootDir: workspaceDir }
    ),
    (error) =>
      error.code === "TARGET_NOT_WRITABLE"
      && error.details?.cause === "UNSAFE_REAL_PATH"
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

test("optionally captures UTF-8 content from the snapshotted file handle", async (t) => {
  const workspaceDir = await makeWorkspace(t);
  const target = path.join(workspaceDir, "target.txt");
  const content = "同一文件句柄内容\n";
  await writeFile(target, content, "utf8");

  const snapshot = await snapshotPath(target);
  const captured = await snapshotPath(target, { includeContent: true });
  const { content: capturedContent, ...capturedSnapshot } = captured;

  assert.equal("content" in snapshot, false);
  assert.equal(capturedContent, content);
  assert.equal(
    captured.hash,
    createHash("sha256").update(Buffer.from(capturedContent, "utf8")).digest("hex")
  );
  assert.deepEqual(capturedSnapshot, snapshot);
});

test("normalizes a target disappearing during snapshot capture", async (t) => {
  const workspaceDir = await makeWorkspace(t);
  const target = path.join(workspaceDir, "target.txt");
  await writeFile(target, "sensitive content", "utf8");
  let calls = 0;

  await assert.rejects(
    snapshotPath(target, {
      includeContent: true,
      fsOperations: {
        lstat: async (...args) => {
          calls += 1;
          if (calls === 2) {
            const error = new Error("simulated native ENOENT");
            error.code = "ENOENT";
            throw error;
          }
          return lstat(...args);
        }
      }
    }),
    (error) =>
      error.code === "TARGET_CHANGED_DURING_READ"
      && !error.message.includes("simulated native ENOENT")
      && !JSON.stringify(error.details).includes("sensitive content")
  );
});

test("normalizes a target replacement during snapshot capture", async (t) => {
  const workspaceDir = await makeWorkspace(t);
  const target = path.join(workspaceDir, "target.txt");
  const replacement = path.join(workspaceDir, "replacement.txt");
  await writeFile(target, "original sensitive content", "utf8");
  await writeFile(replacement, "replacement sensitive content", "utf8");

  await assert.rejects(
    snapshotPath(target, {
      includeContent: true,
      fsOperations: {
        open: () => open(replacement, "r")
      }
    }),
    (error) =>
      error.code === "TARGET_CHANGED_DURING_READ"
      && !JSON.stringify(error.details).includes("sensitive content")
  );
});

test("preflights every target parent before any write", async (t) => {
  const workspaceDir = await makeWorkspace(t);
  const writableTarget = path.join(workspaceDir, "new-dir", "writable.txt");
  const blockedParent = path.join(workspaceDir, "not-a-directory");
  const deniedTarget = path.join(blockedParent, "denied.txt");
  await writeFile(blockedParent, "not a directory", "utf8");

  await assert.rejects(
    preflightWritableTargets(
      [writableTarget, deniedTarget],
      { rootDir: workspaceDir }
    ),
    (error) => error.code === "TARGET_NOT_WRITABLE"
  );
  await assert.rejects(access(path.dirname(writableTarget)));
  assert.equal(await readFile(blockedParent, "utf8"), "not a directory");
});

test("preflight writable targets stops at an aborted signal", async (t) => {
  const workspaceDir = await makeWorkspace(t);
  const target = path.join(workspaceDir, "target.txt");
  const signal = AbortSignal.abort();

  await assert.rejects(
    preflightWritableTargets([target], { rootDir: workspaceDir, signal }),
    (error) => error.name === "AbortError"
  );
  await assert.rejects(readFile(target, "utf8"), { code: "ENOENT" });
});

test("preflight preserves an abort that arrives during a target check", async (t) => {
  const workspaceDir = await makeWorkspace(t);
  const target = path.join(workspaceDir, "target.txt");
  const controller = new AbortController();
  queueMicrotask(() => controller.abort());

  await assert.rejects(
    preflightWritableTargets(
      [target],
      { rootDir: workspaceDir, signal: controller.signal }
    ),
    (error) => error.name === "AbortError"
  );
  await assert.rejects(readFile(target, "utf8"), { code: "ENOENT" });
});

test("writes atomically only when the preview snapshot remains current", async (t) => {
  const workspaceDir = await makeWorkspace(t);
  const target = path.join(workspaceDir, "target.txt");
  await writeFile(target, "before", "utf8");
  const snapshot = await snapshotPath(target);

  await writeUtf8Atomic(target, "after", {
    expectedSnapshot: snapshot,
    rootDir: workspaceDir
  });

  assert.equal(await readFile(target, "utf8"), "after");
});

test("does not overwrite a target that appeared after preview", async (t) => {
  const workspaceDir = await makeWorkspace(t);
  const target = path.join(workspaceDir, "target.txt");
  const snapshot = await snapshotPath(target);
  await writeFile(target, "other process", "utf8");

  await assert.rejects(
    writeUtf8Atomic(target, "ours", {
      expectedSnapshot: snapshot,
      rootDir: workspaceDir
    }),
    (error) => error.code === "TARGET_CHANGED_AFTER_PREVIEW"
  );
  assert.equal(await readFile(target, "utf8"), "other process");
});

test("stops before writing when the signal is already aborted", async (t) => {
  const workspaceDir = await makeWorkspace(t);
  const target = path.join(workspaceDir, "target.txt");
  const signal = AbortSignal.abort();

  await assert.rejects(
    writeUtf8Atomic(target, "content", { rootDir: workspaceDir, signal }),
    (error) => error.name === "AbortError"
  );
  await assert.rejects(readFile(target, "utf8"), { code: "ENOENT" });
});

test("reports stale UUID temporary files without deleting or trusting them", async (t) => {
  const workspaceDir = await makeWorkspace(t);
  const target = path.join(workspaceDir, "target.txt");
  const staleTemporary = path.join(
    workspaceDir,
    ".target.txt.999.00000000-0000-4000-8000-000000000000.tmp"
  );
  await writeFile(target, "before", "utf8");
  await writeFile(staleTemporary, "untrusted stale content", "utf8");

  const observedPaths = (await readdir(workspaceDir))
    .map((name) => path.join(workspaceDir, name));
  const warnings = detectStaleTempFiles([target, target], observedPaths);
  assert.deepEqual(warnings, [{
    code: "STALE_TEMP_FILE",
    path: staleTemporary,
    targetPath: target
  }]);

  const snapshot = await snapshotPath(target);
  await writeUtf8Atomic(target, "after", {
    expectedSnapshot: snapshot,
    rootDir: workspaceDir
  });

  assert.equal(await readFile(target, "utf8"), "after");
  assert.equal(await readFile(staleTemporary, "utf8"), "untrusted stale content");
  const observedAfterRerun = (await readdir(workspaceDir))
    .map((name) => path.join(workspaceDir, name));
  assert.deepEqual(detectStaleTempFiles([target], observedAfterRerun), warnings);
});

test("rejects a regular target changed to a link after preview and cleans its temporary", async (t) => {
  const workspaceDir = await makeWorkspace(t);
  const outsideDir = await mkdtemp(path.join(tmpdir(), "governance-link-target-"));
  t.after(() => rm(outsideDir, { recursive: true, force: true }));
  const target = path.join(workspaceDir, "target.txt");
  await writeFile(target, "before", "utf8");
  const snapshot = await snapshotPath(target);
  let temporaryPath;

  await assert.rejects(
    writeUtf8Atomic(target, "after", {
      expectedSnapshot: snapshot,
      rootDir: workspaceDir,
      fsOperations: {
        open: async (...args) => {
          temporaryPath = args[0];
          const handle = await open(...args);
          await rm(target);
          await symlink(
            outsideDir,
            target,
            process.platform === "win32" ? "junction" : "dir"
          );
          return handle;
        }
      }
    }),
    (error) => error.code === "UNSAFE_REAL_PATH"
  );
  await assert.rejects(readFile(temporaryPath, "utf8"), { code: "ENOENT" });
});

test("does not delete a preoccupied temporary path", async (t) => {
  const workspaceDir = await makeWorkspace(t);
  const target = path.join(workspaceDir, "target.txt");
  let temporaryPath;

  await assert.rejects(
    writeUtf8Atomic(target, "ours", {
      rootDir: workspaceDir,
      fsOperations: {
        open: async (...args) => {
          temporaryPath = args[0];
          await writeFile(temporaryPath, "occupied", "utf8");
          return open(...args);
        }
      }
    }),
    (error) => error.code === "EEXIST"
  );
  assert.equal(await readFile(temporaryPath, "utf8"), "occupied");
  await assert.rejects(readFile(target, "utf8"), { code: "ENOENT" });
});

test("cleans its temporary file when atomic rename fails", async (t) => {
  const workspaceDir = await makeWorkspace(t);
  const target = path.join(workspaceDir, "target.txt");
  await writeFile(target, "before", "utf8");
  const snapshot = await snapshotPath(target);
  let temporaryPath;
  const renameError = Object.assign(new Error("rename failed"), { code: "EACCES" });

  await assert.rejects(
    writeUtf8Atomic(target, "after", {
      expectedSnapshot: snapshot,
      rootDir: workspaceDir,
      fsOperations: {
        open: async (...args) => {
          temporaryPath = args[0];
          return open(...args);
        },
        rename: async () => {
          throw renameError;
        }
      }
    }),
    (error) => error === renameError
  );
  assert.equal(await readFile(target, "utf8"), "before");
  await assert.rejects(readFile(temporaryPath, "utf8"), { code: "ENOENT" });
});

test("cleans its temporary file when Windows rename-over-existing fails", {
  skip: process.platform !== "win32"
}, async (t) => {
  const workspaceDir = await makeWorkspace(t);
  const target = path.join(workspaceDir, "target.txt");
  await writeFile(target, "before", "utf8");
  const snapshot = await snapshotPath(target);
  let temporaryPath;
  const renameError = Object.assign(new Error("destination exists"), { code: "EEXIST" });

  await assert.rejects(
    writeUtf8Atomic(target, "after", {
      expectedSnapshot: snapshot,
      rootDir: workspaceDir,
      fsOperations: {
        open: async (...args) => {
          temporaryPath = args[0];
          return open(...args);
        },
        rename: async () => {
          throw renameError;
        }
      }
    }),
    (error) => error === renameError
  );
  assert.equal(await readFile(target, "utf8"), "before");
  await assert.rejects(readFile(temporaryPath, "utf8"), { code: "ENOENT" });
});

test("stops at the next checkpoint when aborted during execution", async (t) => {
  const workspaceDir = await makeWorkspace(t);
  const target = path.join(workspaceDir, "target.txt");
  const controller = new AbortController();
  let temporaryPath;

  await assert.rejects(
    writeUtf8Atomic(target, "content", {
      rootDir: workspaceDir,
      signal: controller.signal,
      fsOperations: {
        open: async (...args) => {
          temporaryPath = args[0];
          const handle = await open(...args);
          return {
            stat: (...methodArgs) => handle.stat(...methodArgs),
            writeFile: (...methodArgs) => handle.writeFile(...methodArgs),
            sync: async () => {
              await handle.sync();
              controller.abort();
            },
            close: (...methodArgs) => handle.close(...methodArgs)
          };
        }
      }
    }),
    (error) => error.name === "AbortError"
  );
  await assert.rejects(readFile(target, "utf8"), { code: "ENOENT" });
  await assert.rejects(readFile(temporaryPath, "utf8"), { code: "ENOENT" });
});
