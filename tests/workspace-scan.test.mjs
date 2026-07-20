import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { renameSync, symlinkSync } from "node:fs";
import { access, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import test from "node:test";
import { inspectContextGitStates, inspectGitStates } from "../tooling/lib/git-state.mjs";
import { scanWorkspace } from "../tooling/lib/workspace-scan.mjs";
import {
  createProjectWorkspace,
  resolveGitDir,
  snapshotGitIndex
} from "./helpers/project-workspace.mjs";

const execFile = promisify(execFileCallback);

async function createDirectoryLink(t, target, link) {
  try {
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      t.skip("当前环境不允许创建目录链接，无法进行真实文件系统覆盖");
      return false;
    }
    throw error;
  }
}

function assertLimit(result, limit) {
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.some((item) => (
    item.code === "SCAN_LIMIT_REACHED" && item.limit === limit
  )));
}

async function initializeRepository(repositoryDir) {
  await execFile("git", ["init", "--quiet", repositoryDir]);
  await execFile("git", ["-C", repositoryDir, "config", "user.name", "Governance Test"]);
  await execFile("git", ["-C", repositoryDir, "config", "user.email", "test@example.invalid"]);
  await writeFile(path.join(repositoryDir, "README.md"), "tracked\n", "utf8");
  await execFile("git", ["-C", repositoryDir, "add", "README.md"]);
  await execFile("git", ["-C", repositoryDir, "commit", "--quiet", "-m", "initial"]);
}

test("scans supported markers and skips heavy directories", async (t) => {
  const workspace = await createProjectWorkspace(t, {
    files: {
      "apps/server/pom.xml": "<project/>",
      "apps/admin/package.json": "{}",
      "node_modules/ignored/package.json": "{}"
    }
  });

  const result = await scanWorkspace({ workspaceDir: workspace });
  assert.ok(result.entries.some((entry) => entry.relativePath === "apps/server/pom.xml"));
  assert.ok(result.entries.some((entry) => entry.relativePath === "apps/admin/package.json"));
  assert.ok(!result.entries.some((entry) => entry.relativePath.includes("node_modules")));
});

test("does not follow directory links", async (t) => {
  const workspace = await createProjectWorkspace(t);
  const outside = await createProjectWorkspace(t, {
    files: { "outside-marker/package.json": "{}" }
  });
  const linkedDirectory = path.join(workspace, "linked-outside");
  if (!await createDirectoryLink(t, outside, linkedDirectory)) return;

  const result = await scanWorkspace({ workspaceDir: workspace });
  assert.ok(result.warnings.some((item) => item.code === "LINK_SKIPPED"));
  assert.ok(!result.entries.some((entry) => entry.relativePath.includes("outside-marker")));
});

test("rechecks a queued directory before reading when it becomes a link", async (t) => {
  const workspace = await createProjectWorkspace(t, {
    files: { "a-first/placeholder.txt": "x", "b-target/inside.txt": "safe" }
  });
  const outside = await createProjectWorkspace(t, {
    files: { "outside-marker/package.json": "{}" }
  });
  const target = path.join(workspace, "b-target");
  const replacement = path.join(workspace, "replacement-target");
  const probe = path.join(workspace, "link-capability-probe");
  if (!await createDirectoryLink(t, outside, probe)) return;
  await rm(probe, { recursive: true, force: true });

  let clockCalls = 0;
  let replacementCompleted = false;
  const result = await scanWorkspace({
    workspaceDir: workspace,
    now: () => {
      clockCalls += 1;
      if (clockCalls === 5) {
        renameSync(target, replacement);
        symlinkSync(outside, target, process.platform === "win32" ? "junction" : "dir");
        replacementCompleted = true;
      }
      return 0;
    }
  });

  assert.equal(replacementCompleted, true);
  assert.ok(result.warnings.some((item) => item.code === "LINK_SKIPPED"));
  assert.ok(!result.entries.some((entry) => entry.relativePath.includes("outside-marker")));
});

test("marks results incomplete when limits are reached", async (t) => {
  const workspace = await createProjectWorkspace(t, {
    files: { "one.txt": "1", "two.txt": "2", "three.txt": "3" }
  });
  const result = await scanWorkspace({
    workspaceDir: workspace,
    limits: { maxDepth: 1, maxEntries: 2, maxDurationMs: 10_000 }
  });
  assertLimit(result, "maxEntries");
});

test("enforces each default limit with an injected clock", async (t) => {
  const deepWorkspace = await createProjectWorkspace(t, {
    files: { "one/two/three/four/five/marker.txt": "x" }
  });
  assertLimit(await scanWorkspace({ workspaceDir: deepWorkspace }), "maxDepth");

  const entryWorkspace = await createProjectWorkspace(t);
  for (let index = 0; index < 10_001; index += 1) {
    await writeFile(path.join(entryWorkspace, `item-${index}.txt`), "x", "utf8");
  }
  assertLimit(await scanWorkspace({ workspaceDir: entryWorkspace }), "maxEntries");

  const durationWorkspace = await createProjectWorkspace(t, {
    files: { "marker.txt": "x" }
  });
  let calls = 0;
  const result = await scanWorkspace({
    workspaceDir: durationWorkspace,
    now: () => calls++ === 0 ? 0 : 10_001
  });
  assertLimit(result, "maxDurationMs");
});

test("recognizes both .git directories and worktree .git files", async (t) => {
  const workspace = await createProjectWorkspace(t, {
    files: {
      "directory-repo/.git/HEAD": "ref: refs/heads/main\n",
      "file-worktree/.git": "gitdir: ../metadata/worktree\n"
    }
  });
  const result = await scanWorkspace({ workspaceDir: workspace });
  assert.deepEqual(result.gitMarkers.map(({ type }) => type).sort(), ["directory", "file"]);
});

test("scans special and platform-supported long paths", async (t) => {
  const workspace = await createProjectWorkspace(t);
  const segments = ["中文 空格", "(括号)", "MiXeD-Case", ...Array(8).fill("long-segment-12345")];
  const relativePath = path.join(...segments, "package.json");
  await mkdir(path.join(workspace, ...segments), { recursive: true });
  await writeFile(path.join(workspace, relativePath), "{}", "utf8");

  const result = await scanWorkspace({ workspaceDir: workspace, limits: { maxDepth: 20 } });
  assert.ok(result.entries.some((entry) => entry.relativePath === segments.join("/") + "/package.json"));
});

test("stops scanning with a stable interrupted error", async (t) => {
  const workspace = await createProjectWorkspace(t, { files: { "marker.txt": "x" } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    scanWorkspace({ workspaceDir: workspace, signal: controller.signal }),
    (error) => error.code === "INTERRUPTED"
  );
});

test("reports dirty repositories without modifying Git", async () => {
  const workspace = path.join("C:", "workspace");
  let received;
  const states = await inspectGitStates({
    gitMarkers: [{ rootDir: workspace }],
    runGit: async (args, options) => {
      received = { args, options };
      return { code: 0, stdout: " M README.md\n", stderr: "" };
    }
  });
  assert.deepEqual(states, [{
    rootDir: workspace,
    available: true,
    dirty: true,
    warning: null
  }]);
  assert.deepEqual(received.args, [
    "-C", workspace, "status", "--porcelain", "--untracked-files=normal"
  ]);
  assert.equal(received.options.env.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(
    received.options.env.PATH ?? received.options.env.Path,
    process.env.PATH ?? process.env.Path
  );
});

test("reports unavailable Git status without throwing", async () => {
  const states = await inspectGitStates({
    gitMarkers: [{ rootDir: "C:\\missing" }],
    runGit: async () => ({ code: 1, stdout: "", stderr: "not a repository" })
  });
  assert.deepEqual(states, [{
    rootDir: "C:\\missing",
    available: false,
    dirty: null,
    warning: "GIT_STATUS_UNAVAILABLE"
  }]);
});

test("finds and deduplicates nearest Git markers for context components", async (t) => {
  const workspace = await createProjectWorkspace(t, {
    files: { ".git/HEAD": "ref: refs/heads/main\n", "apps/a/index.js": "", "apps/b/index.js": "" }
  });
  const states = await inspectContextGitStates({
    workspaceDir: workspace,
    components: {
      a: { rootDir: path.join(workspace, "apps", "a") },
      b: { rootDir: path.join(workspace, "apps", "b") }
    }
  }, {
    runGit: async () => ({ code: 0, stdout: "", stderr: "" })
  });
  assert.deepEqual(states, [{ rootDir: workspace, available: true, dirty: false, warning: null }]);
});

test("real Git status does not refresh index or create index.lock", async (t) => {
  const repository = await createProjectWorkspace(t);
  await initializeRepository(repository);
  const before = await snapshotGitIndex(repository);
  const states = await inspectGitStates({ gitMarkers: [{ rootDir: repository }] });
  const after = await snapshotGitIndex(repository);

  assert.equal(states[0].available, true, "默认 Git 命令必须可被当前 Windows 环境发现");
  assert.deepEqual(after, before);
  await assert.rejects(access(path.join(await resolveGitDir(repository), "index.lock")));
});

test("real worktree Git status preserves the resolved worktree index", async (t) => {
  const repository = await createProjectWorkspace(t);
  await initializeRepository(repository);
  const worktree = path.join(repository, "linked-worktree");
  await execFile("git", ["-C", repository, "worktree", "add", "--detach", worktree, "HEAD"]);
  const before = await snapshotGitIndex(worktree);
  const states = await inspectGitStates({ gitMarkers: [{ rootDir: worktree }] });
  const after = await snapshotGitIndex(worktree);

  assert.equal(states[0].available, true);
  assert.deepEqual(after, before);
  await assert.rejects(access(path.join(await resolveGitDir(worktree), "index.lock")));
});
