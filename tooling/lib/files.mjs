import { createHash, randomUUID } from "node:crypto";
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { GovernanceError } from "./errors.mjs";

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function throwIfAborted(signal) {
  signal?.throwIfAborted();
}

function unsafeRealPath(root, target, message) {
  return new GovernanceError("UNSAFE_REAL_PATH", message, { root, target });
}

async function assertNoLinkedPathSegments(targetPath) {
  const target = path.resolve(targetPath);
  const parsed = path.parse(target);
  const parts = target.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;

  for (const part of parts) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw unsafeRealPath(parsed.root, current, `路径包含符号链接：${current}`);
      }
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
  return target;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function nearestExistingParent(targetPath) {
  let parent = path.dirname(targetPath);
  while (true) {
    try {
      const info = await lstat(parent);
      return { parent, info };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const next = path.dirname(parent);
      if (next === parent) throw error;
      parent = next;
    }
  }
}

async function cleanupOwnedTemporary(temporaryPath, identity) {
  if (!identity) return;
  try {
    const current = await lstat(temporaryPath);
    if (sameIdentity(current, identity)) {
      await unlink(temporaryPath);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export async function readYamlFile(filePath) {
  const source = await readFile(filePath, "utf8");
  return parse(source);
}

export function resolveInside(rootDir, relativePath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new GovernanceError("UNSAFE_PATH", `路径逃逸出工作区：${relativePath}`, {
      root,
      target
    });
  }
  return target;
}

export async function assertRealPathInside(rootDir, targetPath, {
  allowMissing = false
} = {}) {
  const rootResolved = path.resolve(rootDir);
  const rootInfo = await lstat(rootResolved);
  if (rootInfo.isSymbolicLink()) {
    throw unsafeRealPath(rootResolved, rootResolved, `工作区根路径是符号链接：${rootResolved}`);
  }
  const rootReal = await realpath(rootResolved);
  const target = path.resolve(targetPath);
  if (!isInside(rootResolved, target)) {
    throw unsafeRealPath(rootReal, target, "目标路径逃逸出工作区");
  }

  const relativeParts = path.relative(rootResolved, target).split(path.sep).filter(Boolean);
  let current = rootReal;
  for (const part of relativeParts) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw unsafeRealPath(rootReal, current, `路径包含符号链接：${current}`);
      }
      const targetReal = await realpath(current);
      if (!isInside(rootReal, targetReal)) {
        throw unsafeRealPath(rootReal, targetReal, `真实路径逃逸出工作区：${current}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!allowMissing) throw error;
      break;
    }
  }
  return target;
}

export async function snapshotPath(filePath, {
  includeContent = false,
  fsOperations = {}
} = {}) {
  const lstatTarget = fsOperations.lstat ?? lstat;
  const openTarget = fsOperations.open ?? open;
  let handle;
  let observedExisting = false;
  try {
    const linkInfo = await lstatTarget(filePath);
    observedExisting = true;
    if (linkInfo.isSymbolicLink()) {
      throw new GovernanceError("UNSAFE_REAL_PATH", `目标是链接：${filePath}`);
    }
    handle = await openTarget(filePath, "r");
    const before = await handle.stat();
    const currentLinkInfo = await lstatTarget(filePath);
    if (currentLinkInfo.isSymbolicLink() || !sameIdentity(currentLinkInfo, before)) {
      throw new GovernanceError("TARGET_CHANGED_DURING_READ", `打开时目标发生变化：${filePath}`);
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (
      !sameIdentity(before, after)
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
    ) {
      throw new GovernanceError("TARGET_CHANGED_DURING_READ", `读取时目标发生变化：${filePath}`);
    }
    const snapshot = {
      path: filePath,
      exists: true,
      size: after.size,
      device: after.dev,
      inode: after.ino,
      mtimeMs: after.mtimeMs,
      hash: createHash("sha256").update(content).digest("hex")
    };
    return includeContent
      ? { ...snapshot, content: content.toString("utf8") }
      : snapshot;
  } catch (error) {
    if (error.code === "ENOENT" && !observedExisting) {
      return { path: filePath, exists: false, size: 0, hash: null };
    }
    if (error.code === "ENOENT") {
      throw new GovernanceError("TARGET_CHANGED_DURING_READ", `读取时目标消失：${filePath}`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function assertSnapshotUnchanged(expected) {
  const actual = await snapshotPath(expected.path);
  if (
    actual.exists !== expected.exists
    || actual.size !== expected.size
    || actual.device !== expected.device
    || actual.inode !== expected.inode
    || actual.mtimeMs !== expected.mtimeMs
    || actual.hash !== expected.hash
  ) {
    throw new GovernanceError(
      "TARGET_CHANGED_AFTER_PREVIEW",
      `预览后目标文件发生变化：${expected.path}`,
      { expected, actual }
    );
  }
}

export async function preflightWritableTargets(targetPaths) {
  const targets = [...new Set(targetPaths.map((target) => path.resolve(target)))];
  const prepared = [];
  for (const target of targets) {
    try {
      await assertNoLinkedPathSegments(target);
      const { parent, info } = await nearestExistingParent(target);
      if (!info.isDirectory()) {
        throw new Error("最近存在的父路径不是目录");
      }
      await access(parent, constants.W_OK);
      prepared.push({ targetPath: target, parentDir: parent });
    } catch (error) {
      throw new GovernanceError(
        "TARGET_NOT_WRITABLE",
        `目标路径不可写：${target}`,
        { target, cause: error.code ?? error.message }
      );
    }
  }
  return prepared;
}

export function detectStaleTempFiles(targetPaths, observedPaths) {
  const targets = [...new Set(targetPaths.map((target) => path.resolve(target)))];
  const candidates = [...new Set(observedPaths.map((candidate) => path.resolve(candidate)))];
  const warnings = [];
  for (const target of targets) {
    const prefix = `.${path.basename(target)}.`;
    for (const candidate of candidates) {
      if (path.dirname(candidate) !== path.dirname(target)) continue;
      const name = path.basename(candidate);
      if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
      const identity = name.slice(prefix.length, -4);
      const separator = identity.indexOf(".");
      if (separator === -1) continue;
      const pid = identity.slice(0, separator);
      const uuid = identity.slice(separator + 1);
      if (
        !/^\d+$/.test(pid)
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)
      ) {
        continue;
      }
      warnings.push({
        code: "STALE_TEMP_FILE",
        path: candidate,
        targetPath: target
      });
    }
  }
  return warnings.sort((left, right) => left.path.localeCompare(right.path));
}

export async function writeUtf8Atomic(filePath, content, {
  expectedSnapshot,
  signal,
  fsOperations = {}
} = {}) {
  const openTemporary = fsOperations.open ?? open;
  const renameTarget = fsOperations.rename ?? rename;
  throwIfAborted(signal);
  const targetPath = path.resolve(filePath);
  const expected = expectedSnapshot ?? await snapshotPath(targetPath);
  await preflightWritableTargets([targetPath]);
  throwIfAborted(signal);

  let temporaryPath;
  let temporaryIdentity;
  try {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await assertNoLinkedPathSegments(targetPath);
    throwIfAborted(signal);

    temporaryPath = path.join(
      path.dirname(targetPath),
      `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`
    );
    const handle = await openTemporary(temporaryPath, "wx");
    try {
      temporaryIdentity = await handle.stat();
      throwIfAborted(signal);
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    throwIfAborted(signal);
    await assertNoLinkedPathSegments(targetPath);
    await assertSnapshotUnchanged(expected);
    throwIfAborted(signal);

    if (expected.exists) {
      await renameTarget(temporaryPath, targetPath);
    } else {
      await link(temporaryPath, targetPath);
      await unlink(temporaryPath);
    }
    temporaryIdentity = undefined;
  } finally {
    await cleanupOwnedTemporary(temporaryPath, temporaryIdentity);
  }
}
