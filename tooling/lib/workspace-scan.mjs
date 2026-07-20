import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { GovernanceError } from "./errors.mjs";
import { assertRealPathInside } from "./files.mjs";

const skippedDirectories = new Set([
  ".git", "node_modules", "target", "dist", "build",
  ".next", "coverage", "vendor"
]);

const defaultLimits = {
  maxDepth: 4,
  maxEntries: 10_000,
  maxDurationMs: 10_000
};

function throwIfInterrupted(signal) {
  if (signal?.aborted) {
    throw new GovernanceError("INTERRUPTED", "工作区扫描已中断");
  }
}

function limitWarning(warnings, limit) {
  warnings.push({ code: "SCAN_LIMIT_REACHED", limit });
}

function linkWarning(warnings, targetPath) {
  warnings.push({ code: "LINK_SKIPPED", path: targetPath });
}

async function isSafeDirectory(workspaceDir, directoryPath, warnings) {
  try {
    const info = await lstat(directoryPath);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      linkWarning(warnings, directoryPath);
      return false;
    }
    await assertRealPathInside(workspaceDir, directoryPath, { allowMissing: false });
    return true;
  } catch (error) {
    if (error.code === "UNSAFE_REAL_PATH" || error.code === "ENOENT") {
      linkWarning(warnings, directoryPath);
      return false;
    }
    throw error;
  }
}

export async function scanWorkspace({
  workspaceDir,
  limits = {},
  now = Date.now,
  signal
}) {
  const effectiveLimits = { ...defaultLimits, ...limits };
  const rootDir = path.resolve(workspaceDir);
  const entries = [];
  const gitMarkers = [];
  const warnings = [];
  const startedAt = now();
  const queue = [{ directoryPath: rootDir, relativePath: "", depth: 0 }];
  let truncated = false;

  if (!await isSafeDirectory(rootDir, rootDir, warnings)) {
    return { entries, gitMarkers, truncated, warnings };
  }

  while (queue.length > 0 && !truncated) {
    throwIfInterrupted(signal);
    if (now() - startedAt > effectiveLimits.maxDurationMs) {
      limitWarning(warnings, "maxDurationMs");
      truncated = true;
      break;
    }

    const current = queue.shift();
    throwIfInterrupted(signal);
    if (!await isSafeDirectory(rootDir, current.directoryPath, warnings)) continue;
    throwIfInterrupted(signal);
    if (now() - startedAt > effectiveLimits.maxDurationMs) {
      limitWarning(warnings, "maxDurationMs");
      truncated = true;
      break;
    }

    const children = await readdir(current.directoryPath, { withFileTypes: true });
    throwIfInterrupted(signal);
    if (now() - startedAt > effectiveLimits.maxDurationMs) {
      limitWarning(warnings, "maxDurationMs");
      truncated = true;
      break;
    }

    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      throwIfInterrupted(signal);
      const relativePath = current.relativePath
        ? path.posix.join(current.relativePath, child.name)
        : child.name;
      const absolutePath = path.join(current.directoryPath, child.name);
      const depth = current.depth + 1;

      if (depth > effectiveLimits.maxDepth) {
        limitWarning(warnings, "maxDepth");
        truncated = true;
        break;
      }

      let info;
      try {
        info = await lstat(absolutePath);
      } catch (error) {
        if (error.code === "ENOENT") {
          linkWarning(warnings, absolutePath);
          continue;
        }
        throw error;
      }
      if (info.isSymbolicLink()) {
        linkWarning(warnings, absolutePath);
        continue;
      }

      if (child.name === ".git" && (info.isDirectory() || info.isFile())) {
        try {
          await assertRealPathInside(rootDir, absolutePath, { allowMissing: false });
        } catch (error) {
          if (error.code === "UNSAFE_REAL_PATH") {
            linkWarning(warnings, absolutePath);
            continue;
          }
          throw error;
        }
        gitMarkers.push({
          rootDir: current.directoryPath,
          markerPath: absolutePath,
          type: info.isDirectory() ? "directory" : "file"
        });
        continue;
      }

      if (info.isDirectory()) {
        if (skippedDirectories.has(child.name)) continue;
        if (!await isSafeDirectory(rootDir, absolutePath, warnings)) continue;
        entries.push({ relativePath, absolutePath, type: "directory" });
        if (entries.length >= effectiveLimits.maxEntries) {
          limitWarning(warnings, "maxEntries");
          truncated = true;
          break;
        }
        queue.push({ directoryPath: absolutePath, relativePath, depth });
        continue;
      }

      entries.push({ relativePath, absolutePath, type: info.isFile() ? "file" : "other" });
      if (entries.length >= effectiveLimits.maxEntries) {
        limitWarning(warnings, "maxEntries");
        truncated = true;
        break;
      }
    }
  }

  return { entries, gitMarkers, truncated, warnings };
}
