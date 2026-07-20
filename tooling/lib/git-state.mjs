import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";

function gitEnvironment() {
  return { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
}

async function defaultRunGit(args, { signal, env = gitEnvironment() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      env,
      signal,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (signal?.aborted) {
        reject(error);
        return;
      }
      resolve({ code: 1, stdout, stderr: stderr || error.message });
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function markerKey(markerPath) {
  const resolved = path.resolve(markerPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function findNearestGitMarkers(workspaceDir, componentRoots) {
  const boundary = path.resolve(workspaceDir);
  const markers = [];
  const seen = new Set();

  for (const componentRoot of componentRoots) {
    let current = path.resolve(componentRoot);
    while (true) {
      const relative = path.relative(boundary, current);
      if (relative.startsWith("..") || path.isAbsolute(relative)) break;

      const markerPath = path.join(current, ".git");
      try {
        const info = await lstat(markerPath);
        if (!info.isSymbolicLink() && (info.isDirectory() || info.isFile())) {
          const key = markerKey(markerPath);
          if (!seen.has(key)) {
            seen.add(key);
            markers.push({
              rootDir: current,
              markerPath,
              type: info.isDirectory() ? "directory" : "file"
            });
          }
          break;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (current === boundary) break;
      current = path.dirname(current);
    }
  }
  return markers;
}

export async function inspectGitStates({
  gitMarkers,
  runGit = defaultRunGit,
  signal
}) {
  const states = [];
  for (const marker of gitMarkers) {
    const result = await runGit([
      "-C", marker.rootDir, "status", "--porcelain", "--untracked-files=normal"
    ], {
      signal,
      env: gitEnvironment()
    });
    states.push(result.code === 0
      ? {
          rootDir: marker.rootDir,
          available: true,
          dirty: result.stdout.trim().length > 0,
          warning: null
        }
      : {
          rootDir: marker.rootDir,
          available: false,
          dirty: null,
          warning: "GIT_STATUS_UNAVAILABLE"
        });
  }
  return states;
}

export async function inspectContextGitStates(context, {
  runGit = defaultRunGit,
  signal
} = {}) {
  const gitMarkers = await findNearestGitMarkers(
    context.workspaceDir,
    Object.values(context.components).map((item) => item.rootDir)
  );
  return inspectGitStates({ gitMarkers, runGit, signal });
}
