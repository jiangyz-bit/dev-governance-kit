# Guided Init Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为已有项目提供证据驱动、默认面向小白用户、确认前和冲突时不修改工作区的 `governance-kit init`。

**Architecture:** 将初始化拆成扫描、识别、Manifest 推导、内存预演、交互展示和安全执行六个可独立测试的单元。现有 `apply`/`validate` 保持兼容，`init` 在首次写入前完成全量冲突与快照复核，并在每个文件临近提交时再次复核。

**Tech Stack:** Node.js >=20、ES Modules、`node:test`、`yaml`、现有 Ajv Schema、Node 内置 `readline/promises`。

## Global Constraints

- `init` 只接入已有项目；本计划不实现 `create`。
- 默认输出使用普通中文，不要求用户理解 Profile、repositoryMode 或 contract owner。
- 技术详情仅通过 `--verbose`，自动化结果仅通过 `--json`。
- 确认前、取消后、dry-run、识别失败和任一冲突时，目标项目工作区快照不变。
- `--yes` 只能确认无歧义计划，不能替用户回答问题。
- 扫描默认限制为 4 层、10,000 个目录项和 10 秒。
- 不跟随 symlink 或 Windows junction；真实路径不得逃逸工作区。
- 普通用户最多经过三个交互页面并确认一次。
- 保持现有 `apply` 对静态冲突的部分应用语义和 39 项回归测试；新增的并发目标变化会安全失败为 `TARGET_CHANGED_AFTER_PREVIEW`，这是明确记录的安全强化。
- TOCTOU 防护针对正常并发修改；拒绝全部祖先链接并在每个文件临近提交时复核，但不宣称抵御拥有同等文件系统权限、可在系统调用间持续换路的主动攻击者。
- README 中 `init` 与计划中的 `create` 场景说明由后续 `2026-07-19-npm-release.md` Task 2 交付；本计划完成门禁不把该文档项误报为已完成。
- 新文件使用 UTF-8，不增加第三方运行时依赖。
- 每个任务由独立实现子智能体完成，再经过规范审查和代码质量审查。

---

## File Structure

### 新增运行时代码

- `tooling/lib/workspace-scan.mjs`：有界、不跟随链接的只读扫描。
- `tooling/lib/git-state.mjs`：只读检查各 Git 边界是否存在未提交修改。
- `tooling/lib/project-detect.mjs`：从扫描证据识别三个现有 Profile。
- `tooling/lib/init-manifest.mjs`：问题、选择、Manifest 推导和 YAML 渲染。
- `tooling/lib/apply-preview.mjs`：共享分类、快照、TOCTOU 复核和已确认计划执行。
- `tooling/lib/init.mjs`：初始化用例编排。
- `tooling/lib/init-presenter.mjs`：小白与 verbose 人类可读输出；JSON 直接序列化稳定结果对象。
- `tooling/lib/init-prompts.mjs`：最多三个页面的可注入交互层。

### 修改运行时代码

- `tooling/lib/files.mjs`：唯一临时文件、真实路径保护和快照摘要。
- `tooling/lib/manifest.mjs`：支持从内存 Manifest 创建上下文。
- `tooling/lib/apply.mjs`：改用共享预演执行单元，保持原有公开接口。
- `tooling/cli.mjs`：增加 `init` 参数、输出和退出码。
- `tooling/index.mjs`：导出初始化公开接口。

### 新增测试

- `tests/files.test.mjs`
- `tests/workspace-scan.test.mjs`
- `tests/project-detect.test.mjs`
- `tests/init-manifest.test.mjs`
- `tests/apply-preview.test.mjs`
- `tests/init.test.mjs`
- `tests/cli-init.test.mjs`
- `tests/helpers/project-workspace.mjs`

---

### Task 1: 内存 Manifest 上下文与真实路径保护

**Files:**
- Modify: `tooling/lib/files.mjs`
- Modify: `tooling/lib/manifest.mjs`
- Create: `tests/files.test.mjs`
- Modify: `tests/schema-validator.test.mjs`

**Interfaces:**
- Produces: `assertRealPathInside(rootDir, targetPath, { allowMissing })`
- Produces: `snapshotPath(filePath)`
- Produces: `assertSnapshotUnchanged(snapshot)`
- Produces: `preflightWritableTargets(targetPaths)`
- Extends: `writeUtf8Atomic(filePath, content, { expectedSnapshot, signal })`
- Produces: `createProjectContext({ workspaceDir, kitRoot, manifest, requireComponentDirs, signal })`
- Preserves: `loadProjectManifest(workspaceDir, kitRoot, options?)` with optional `signal`

- [ ] **Step 1: 为内存上下文和路径保护写失败测试**

```js
test("creates project context from an in-memory manifest", async () => {
  const context = await createProjectContext({
    workspaceDir,
    kitRoot,
    manifest,
    requireComponentDirs: true
  });
  assert.equal(context.manifest, manifest);
  assert.equal(context.components.server.rootDir, path.join(workspaceDir, "server"));
});

test("rejects a component symlink that resolves outside the workspace", async (t) => {
  await symlink(outsideDir, path.join(workspaceDir, "server"), "junction");
  await assert.rejects(
    assertRealPathInside(workspaceDir, path.join(workspaceDir, "server"), {
      allowMissing: false
    }),
    (error) => error.code === "UNSAFE_REAL_PATH"
  );
});

test("detects a target changed after preview", async () => {
  const snapshot = await snapshotPath(target);
  await writeFile(target, "changed", "utf8");
  await assert.rejects(
    assertSnapshotUnchanged(snapshot),
    (error) => error.code === "TARGET_CHANGED_AFTER_PREVIEW"
  );
});

test("rejects a linked ancestor even when it resolves inside workspace", async (t) => {
  // 分别覆盖 directory symlink、file symlink；Windows 再覆盖 junction。
  await assert.rejects(
    assertRealPathInside(workspaceDir, path.join(linkedInsideDir, "file.txt"), {
      allowMissing: true
    }),
    (error) => error.code === "UNSAFE_REAL_PATH"
  );
});

test("preflights every target parent before any write", async () => {
  await assert.rejects(
    preflightWritableTargets([writableTarget, deniedTarget]),
    (error) => error.code === "TARGET_NOT_WRITABLE"
  );
  assert.deepEqual(await snapshotWorkspace(workspaceDir), before);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
node --test tests/files.test.mjs tests/schema-validator.test.mjs
```

Expected: FAIL，提示导出函数不存在。

- [ ] **Step 3: 实现真实路径和唯一原子临时文件**

`tooling/lib/files.mjs` 增加：

```js
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function assertRealPathInside(rootDir, targetPath, {
  allowMissing = false
} = {}) {
  const rootResolved = path.resolve(rootDir);
  const rootReal = await realpath(rootDir);
  const target = path.resolve(targetPath);
  if (!isInside(rootResolved, target)) {
    throw new GovernanceError("UNSAFE_REAL_PATH", "目标路径逃逸出工作区");
  }
  const relativeParts = path.relative(rootResolved, target).split(path.sep).filter(Boolean);
  let current = rootReal;
  for (const part of relativeParts) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new GovernanceError("UNSAFE_REAL_PATH", `路径包含符号链接：${current}`, {
          root: rootReal,
          target: current
        });
      }
      const targetReal = await realpath(current);
      if (!isInside(rootReal, targetReal)) {
        throw new GovernanceError("UNSAFE_REAL_PATH", `真实路径逃逸出工作区：${current}`, {
          root: rootReal,
          target: targetReal
        });
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!allowMissing) throw error;
      break;
    }
  }
  return target;
}

export async function snapshotPath(filePath) {
  let handle;
  let observedExisting = false;
  try {
    const linkInfo = await lstat(filePath);
    observedExisting = true;
    if (linkInfo.isSymbolicLink()) {
      throw new GovernanceError("UNSAFE_REAL_PATH", `目标是链接：${filePath}`);
    }
    handle = await open(filePath, "r");
    const before = await handle.stat();
    const currentLinkInfo = await lstat(filePath);
    if (
      currentLinkInfo.isSymbolicLink() ||
      currentLinkInfo.dev !== before.dev ||
      currentLinkInfo.ino !== before.ino
    ) {
      throw new GovernanceError("TARGET_CHANGED_DURING_READ", `打开时目标发生变化：${filePath}`);
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new GovernanceError("TARGET_CHANGED_DURING_READ", `读取时目标发生变化：${filePath}`);
    }
    return {
      path: filePath,
      exists: true,
      size: after.size,
      device: after.dev,
      inode: after.ino,
      mtimeMs: after.mtimeMs,
      hash: createHash("sha256").update(content).digest("hex")
    };
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
    actual.exists !== expected.exists ||
    actual.size !== expected.size ||
    actual.device !== expected.device ||
    actual.inode !== expected.inode ||
    actual.mtimeMs !== expected.mtimeMs ||
    actual.hash !== expected.hash
  ) {
    throw new GovernanceError(
      "TARGET_CHANGED_AFTER_PREVIEW",
      `预览后目标文件发生变化：${expected.path}`,
      { expected, actual }
    );
  }
}
```

`snapshotPath()` 只有首次 `lstat` 返回 ENOENT 时才生成 `exists: false`；若对象在 `lstat/open/fstat/read` 之间消失或改变，必须返回 `TARGET_CHANGED_DURING_READ`，不能降级成“不存在”。同内容替换也通过 device/inode/mtime 与 hash 组合识别。

`preflightWritableTargets()` 必须先对所有目标去重，找到每个目标最近存在的父目录，拒绝链接路径段，并用 `access(parent, W_OK)` 做无写入权限预检；任何一项失败时返回结构化 `TARGET_NOT_WRITABLE`，不得创建目录或临时文件。

同时把 `writeUtf8Atomic` 改为接收预期快照和 AbortSignal。临时文件必须用 `open(temporaryPath, "wx")` 排他创建，写入并 `sync()` 后，在最靠近提交的位置再次执行祖先链与快照复核：

```js
const temporaryPath = path.join(
  path.dirname(filePath),
  `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
);
```

新建目标使用同卷 hard-link/等价排他提交，确保目标若在预览后出现则不覆盖；更新目标在原子替换前立即复核预期快照。使用 `try/finally`，且只清理本进程已经成功排他创建、仍可确认属于本次写入的临时文件。检测到 signal 中断时，在下一次写入前停止并返回已写清单。

测试必须覆盖：同内容文件替换、普通文件改链接、目标原先不存在但提交前出现、临时文件预占、原子替换失败、AbortSignal 中断，以及 Windows rename-over-existing 的失败清理。

硬崩溃可能留下 UUID 临时文件；重跑不得把它当目标文件、不得覆盖或自动删除未知文件，而是在 verbose/JSON 中报告 `STALE_TEMP_FILE` 恢复提示。fixture 预置遗留临时文件后重跑，必须证明目标内容正确、遗留文件未被当作可信输入，且用户可按报告路径自行清理。

- [ ] **Step 4: 拆分 Manifest 上下文创建**

`tooling/lib/manifest.mjs` 提供：

```js
export async function createProjectContext({
  workspaceDir,
  kitRoot,
  manifest,
  requireComponentDirs = false,
  signal
}) {
  validateSchema("governance-kit", manifest);
  // 复用现有 catalog、Profile 兼容和 contract owner 校验。
  // requireComponentDirs 为 true 时校验目录存在、是目录并通过真实路径边界。
  return { kitRoot: resolvedKitRoot, workspaceDir: resolvedWorkspace, manifest, catalog, components };
}

export async function loadProjectManifest(
  workspaceDir,
  kitRoot,
  { requireComponentDirs = false, signal } = {}
) {
  const manifest = await readYamlFile(path.join(path.resolve(workspaceDir), "governance-kit.yaml"));
  return createProjectContext({
    workspaceDir,
    kitRoot,
    manifest,
    requireComponentDirs,
    signal
  });
}
```

- [ ] **Step 5: 运行任务测试和完整回归**

Run:

```powershell
node --test tests/files.test.mjs tests/schema-validator.test.mjs
npm test
```

Expected: 新测试通过，完整测试无失败。

- [ ] **Step 6: 提交**

```powershell
git add tooling/lib/files.mjs tooling/lib/manifest.mjs tests/files.test.mjs tests/schema-validator.test.mjs
git commit -m "feat: secure in-memory project contexts"
```

---

### Task 2: 有界工作区扫描

**Files:**
- Create: `tooling/lib/workspace-scan.mjs`
- Create: `tooling/lib/git-state.mjs`
- Create: `tests/workspace-scan.test.mjs`
- Create: `tests/helpers/project-workspace.mjs`

**Interfaces:**
- Produces: `scanWorkspace({ workspaceDir, limits, now, signal })`
- Produces: `inspectGitStates({ gitMarkers, runGit })`
- Produces: `inspectContextGitStates(context, { runGit })`
- Private: `findNearestGitMarkers(workspaceDir, componentRoots)` walks parents only up to the workspace boundary and deduplicates `.git` directory/file roots.
- Returns: `{ entries, gitMarkers, truncated, warnings }`
- Entry: `{ relativePath, absolutePath, type }`
- Git marker: `{ rootDir, markerPath, type: "directory" | "file" }`

- [ ] **Step 1: 编写扫描失败测试**

```js
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
  const result = await scanWorkspace({ workspaceDir: workspace });
  assert.ok(result.warnings.some((item) => item.code === "LINK_SKIPPED"));
  assert.ok(!result.entries.some((entry) => entry.relativePath.includes("outside-marker")));
});

test("marks results incomplete when limits are reached", async (t) => {
  const result = await scanWorkspace({
    workspaceDir: workspace,
    limits: { maxDepth: 1, maxEntries: 2, maxDurationMs: 10_000 }
  });
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.some((item) => item.code === "SCAN_LIMIT_REACHED"));
});

test("enforces each default limit with an injected clock", async (t) => {
  // 分别构造超过 4 层、10,000 项和 now() 超过 10 秒的 fixture。
  // 每种结果都必须 truncated=true，且包含精确的 limit 类型。
});

test("recognizes both .git directories and worktree .git files", async (t) => {
  const result = await scanWorkspace({ workspaceDir: workspace });
  assert.deepEqual(
    result.gitMarkers.map(({ type }) => type).sort(),
    ["directory", "file"]
  );
});

test("reports dirty repositories without modifying Git", async () => {
  const states = await inspectGitStates({
    gitMarkers: [{ rootDir: workspace }],
    runGit: async () => ({ code: 0, stdout: " M README.md\n", stderr: "" })
  });
  assert.deepEqual(states, [{
    rootDir: workspace,
    available: true,
    dirty: true,
    warning: null
  }]);
});

test("real git status does not refresh index or create index.lock", async (t) => {
  const before = await snapshotGitIndex(realRepository);
  await inspectGitStates({ gitMarkers: [{ rootDir: realRepository }] });
  const after = await snapshotGitIndex(realRepository);
  assert.deepEqual(after, before);
  await assert.rejects(access(path.join(realRepository, ".git", "index.lock")));
});
```

- [ ] **Step 2: 运行并确认失败**

Run:

```powershell
node --test tests/workspace-scan.test.mjs
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现扫描器**

核心常量和接口：

```js
const skippedDirectories = new Set([
  ".git", "node_modules", "target", "dist", "build",
  ".next", "coverage", "vendor"
]);

const defaultLimits = {
  maxDepth: 4,
  maxEntries: 10_000,
  maxDurationMs: 10_000
};

export async function scanWorkspace({
  workspaceDir,
  limits = {},
  now = Date.now,
  signal
}) {
  const effectiveLimits = { ...defaultLimits, ...limits };
  const entries = [];
  const gitMarkers = [];
  const warnings = [];
  // 使用 readdir({ withFileTypes: true }) 广度优先遍历。
  // 入队前和实际 readdir 前都用 lstat + assertRealPathInside 复验目录；
  // 任一时刻变成 symlink/junction 或逃逸时记录 LINK_SKIPPED，不读取、不入队。
  // `.git` 记录为 gitMarkers，但不遍历。
  // 每次队列扩展前后检查 signal；中断则抛稳定 INTERRUPTED。
  // 达到任一上限后设置 truncated 并停止扩展。
  return { entries, gitMarkers, truncated, warnings };
}
```

测试还必须覆盖队列中的目录在读取前被替换为链接、中文/空格/括号/大小写路径和平台允许范围内的长路径；无法创建链接的运行环境必须显式 `t.skip()` 并写明 capability 原因，不能用模拟结果冒充真实文件系统覆盖。

- [ ] **Step 4: 实现 Git 只读状态**

`tooling/lib/git-state.mjs`：

```js
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
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
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
```

默认 `runGit` 使用 `spawn` 执行 `git status`，以 `{ ...process.env, GIT_OPTIONAL_LOCKS: "0" }` 保留 PATH 等完整宿主环境并禁用 optional locks，不得刷新 index、创建 optional lock 或调用 Git 写命令。Windows 真实 Git 黑盒测试必须证明默认 runGit 能找到 Git；三平台比较 `.git/index` 内容、大小与 mtime，且不产生 `.git/index.lock`；worktree `.git` 文件场景解析到实际 gitdir 后执行相同断言。

- [ ] **Step 5: 验证**

Run:

```powershell
node --test tests/workspace-scan.test.mjs
npm test
```

Expected: 全部通过。

- [ ] **Step 6: 提交**

```powershell
git add tooling/lib/workspace-scan.mjs tooling/lib/git-state.mjs tests/workspace-scan.test.mjs tests/helpers/project-workspace.mjs
git commit -m "feat: scan project workspaces safely"
```

---

### Task 3: 三类现有技术栈识别

**Files:**
- Create: `tooling/lib/project-detect.mjs`
- Create: `tests/project-detect.test.mjs`

**Interfaces:**
- Consumes: `scanWorkspace()` 的结果。
- Produces: `detectWorkspace({ workspaceDir, scan, signal })`
- Produces: `validateContextEvidence(context, { signal })`
- Candidate: `{ component, profile, path, confidence, evidence, warnings }`
- Private: `detectComponentAtPath({ component, profile, rootDir })` reuses the same marker rules for an explicitly configured component directory.

- [ ] **Step 1: 编写识别失败测试**

```js
test("detects Maven Spring Boot MyBatis as server", async (t) => {
  const result = await detectWorkspace({ workspaceDir, scan });
  assert.deepEqual(result.candidates[0], {
    component: "server",
    profile: "java-springboot-mybatis",
    path: "demo-server",
    confidence: "high",
    evidence: ["pom.xml", "spring-boot", "mybatis"],
    warnings: ["FLYWAY_NOT_DETECTED"]
  });
});

test("does not silently classify a plain React app as admin", async () => {
  const result = await detectWorkspace({ workspaceDir, scan });
  assert.equal(result.candidates[0].confidence, "medium");
  assert.ok(result.questions.some((item) => item.code === "ADMIN_ROLE_UNCLEAR"));
});

test("detects a WeChat miniprogram from both marker files", async () => {
  assert.ok(result.candidates.some((item) =>
    item.component === "client" &&
    item.profile === "wechat-miniprogram" &&
    item.confidence === "high"
  ));
});

test("turns a missing Profile assumption into a blocking question", async () => {
  const result = await detectWorkspace({ workspaceDir, scan });
  assert.ok(result.questions.some((item) =>
    item.code === "PROFILE_ASSUMPTION_UNCONFIRMED" &&
    item.component === "server" &&
    item.missing.includes("flyway")
  ));
});

test("validates evidence for components from an existing manifest", async () => {
  const result = await validateContextEvidence(context);
  assert.equal(result.status, "needs_input");
  assert.equal(result.questions[0].code, "PROFILE_EVIDENCE_MISMATCH");
});
```

- [ ] **Step 2: 运行并确认失败**

Run:

```powershell
node --test tests/project-detect.test.mjs
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现确定性探测器**

```js
export async function detectWorkspace({ workspaceDir, scan, signal }) {
  const candidates = [];
  const questions = [];
  const warnings = [...scan.warnings];

  // 每轮候选/证据遍历调用 throwIfAborted(signal)。
  // pom.xml：同时匹配 Spring Boot 和 MyBatis 才能成为 server 候选。
  // package.json：解析 dependencies/devDependencies/scripts。
  // React + Vite + tsconfig + admin 路径词提高置信度；
  // React 无角色证据时产生 ADMIN_ROLE_UNCLEAR。
  // project.config.json + app.json 形成高置信度 client。
  // Profile 关键假设缺失时产生阻塞 question，不只产生 warning。
  // 所有路径统一为 `/` 分隔符并按路径排序。

  return {
    projectName: inferProjectName(workspaceDir, scan),
    candidates,
    questions,
    warnings,
    gitMarkers: scan.gitMarkers,
    empty: scan.entries.length === 0,
    incomplete: scan.truncated
  };
}

export async function validateContextEvidence(context, { signal } = {}) {
  const questions = [];
  for (const component of Object.values(context.components)) {
    throwIfAborted(signal);
    const result = await detectComponentAtPath({
      component: component.type,
      profile: component.profile.id,
      rootDir: component.rootDir,
      signal
    });
    if (!result.compatible) {
      questions.push({
        code: "PROFILE_EVIDENCE_MISMATCH",
        component: component.type,
        profile: component.profile.id,
        missing: result.missing
      });
    }
  }
  return {
    status: questions.length === 0 ? "ready" : "needs_input",
    questions
  };
}
```

解析错误必须返回结构化警告，例如 `INVALID_PACKAGE_JSON` 或 `INVALID_POM_XML`，不能让扫描器崩溃。

- [ ] **Step 4: 验证**

Run:

```powershell
node --test tests/project-detect.test.mjs
npm test
```

Expected: 全部通过。

- [ ] **Step 5: 提交**

```powershell
git add tooling/lib/project-detect.mjs tests/project-detect.test.mjs
git commit -m "feat: detect supported project components"
```

---

### Task 4: 仓库模式、问题和 Manifest 推导

**Files:**
- Create: `tooling/lib/init-manifest.mjs`
- Create: `tests/init-manifest.test.mjs`

**Interfaces:**
- Produces: `resolveInitManifest({ workspaceDir, detection, answers })`
- Produces: `renderInitManifest(manifest)`
- Returns: `{ status, manifest, questions, detected, warnings }`
- Private: `inferRepositoryMode(candidates, gitMarkers)` returns `monorepo`, `multi-repo`, or a `REPOSITORY_MODE_UNCLEAR` question.
- Private: `selectContractOwner(components)` returns `server` when present, otherwise the first of `admin`, `client`.
- Private: `resultWithQuestion(code, detection)` returns `status: "needs_input"` with one structured question.

- [ ] **Step 1: 编写失败测试**

```js
test("builds a valid multi-repo manifest from three selected components", () => {
  const result = resolveInitManifest({ workspaceDir, detection, answers: {} });
  assert.equal(result.status, "ready");
  assert.equal(result.manifest.project.repositoryMode, "multi-repo");
  assert.equal(result.manifest.contracts.apiContractOwner, "server");
  assert.equal(result.manifest.contracts.statusRegistryOwner, "server");
  assert.doesNotThrow(() => validateSchema("governance-kit", result.manifest));
});

test("uses the first existing component as contract owner without a server", () => {
  const result = resolveInitManifest({ workspaceDir, detection, answers: {} });
  assert.equal(result.manifest.contracts.apiContractOwner, "admin");
  assert.equal(result.manifest.contracts.statusRegistryOwner, "admin");
});

test("returns needs_input for competing admin candidates", () => {
  const result = resolveInitManifest({ workspaceDir, detection, answers: {} });
  assert.equal(result.status, "needs_input");
  assert.equal(result.questions[0].code, "ADMIN_COMPONENT_UNCLEAR");
});

test("does not let yes bypass an unconfirmed Profile assumption", () => {
  const result = resolveInitManifest({
    workspaceDir,
    detection: detectionWithCompatibilityQuestion,
    answers: {}
  });
  assert.equal(result.status, "needs_input");
  assert.equal(result.questions[0].code, "PROFILE_ASSUMPTION_UNCONFIRMED");
});
```

- [ ] **Step 2: 运行并确认失败**

Run:

```powershell
node --test tests/init-manifest.test.mjs
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现仓库模式和问题模型**

```js
const componentOrder = ["server", "admin", "client"];

export function resolveInitManifest({ workspaceDir, detection, answers = {} }) {
  if (detection.incomplete) {
    return resultWithQuestion("SCAN_INCOMPLETE", detection);
  }
  if (detection.candidates.length === 0) {
    return {
      status: "unsupported",
      code: detection.empty ? "NO_PROJECT_FOUND" : "UNSUPPORTED_PROJECT",
      manifest: null,
      questions: [],
      detected: detection,
      warnings: detection.warnings
    };
  }
  // 以 answers 解决 competing candidates 和混合 Git。
  // detection.questions 中的兼容性问题必须有对应 answers 才能继续。
  // 所有权优先 server，否则按 componentOrder 选择第一个已存在组件。
  // generation.conflictPolicy 固定 report。
  return { status: "ready", manifest, questions: [], detected, warnings };
}

export function renderInitManifest(manifest) {
  return stringify(manifest, { lineWidth: 0 });
}
```

YAML 末尾固定保留一个换行，组件键按 `server`、`admin`、`client` 排序。

- [ ] **Step 4: 验证**

Run:

```powershell
node --test tests/init-manifest.test.mjs
npm test
```

Expected: 全部通过。

- [ ] **Step 5: 提交**

```powershell
git add tooling/lib/init-manifest.mjs tests/init-manifest.test.mjs
git commit -m "feat: resolve deterministic init manifests"
```

---

### Task 5: 抽取共享 apply 预演与 TOCTOU 防护

**Files:**
- Create: `tooling/lib/apply-preview.mjs`
- Modify: `tooling/lib/apply.mjs`
- Create: `tests/apply-preview.test.mjs`
- Modify: `tests/apply.test.mjs`

**Interfaces:**
- Produces: `createApplyPreview({ context, signal })`
- Produces: `assertPreviewUnchanged(preview)`
- Produces: `executeApplyPreview(preview, { allowConflicts, signal })`
- Preserves: `applyGovernance({ workspaceDir, kitRoot, dryRun })`；静态冲突语义不变，并发目标变化新增稳定错误。
- Private: `classify(operation, existing)` is moved unchanged from `apply.mjs`.
- Private: `emptyReport()` and `sortReport(report)` are moved unchanged from `apply.mjs`.

- [ ] **Step 1: 编写预演失败测试**

```js
test("classifies all operations without writing", async () => {
  const preview = await createApplyPreview({ context });
  assert.ok(preview.report.created.length > 0);
  await assert.rejects(readFile(firstTarget, "utf8"));
});

test("stops before writing if any previewed target changed", async () => {
  const preview = await createApplyPreview({ context });
  await writeFile(preview.operations[0].operation.targetPath, "user change", "utf8");
  await assert.rejects(
    executeApplyPreview(preview, { allowConflicts: false }),
    (error) => error.code === "TARGET_CHANGED_AFTER_PREVIEW"
  );
  await assert.rejects(readFile(preview.operations[1].operation.targetPath, "utf8"));
});

test("preserves apply partial-write compatibility", async () => {
  const report = await applyGovernance({ workspaceDir });
  assert.ok(report.conflicts.length > 0);
  assert.ok(report.created.length > 0);
  assert.equal(await readFile(nonConflictingTarget, "utf8") !== "", true);
});

test("never overwrites a later target changed after an earlier write", async () => {
  const preview = await createApplyPreview({ context });
  const changedTarget = preview.operations[1].operation.targetPath;
  let caught;
  try {
    await executeApplyPreview(preview, {
      allowConflicts: false,
      writeFile: async (target, content, options) => {
        if (target === preview.operations[0].operation.targetPath) {
          await writeUtf8Atomic(target, content, options);
          await writeFile(changedTarget, "concurrent user change", "utf8");
          return;
        }
        await writeUtf8Atomic(target, content, options);
      }
    });
  } catch (error) {
    caught = error;
  }
  assert.deepEqual(await readFile(changedTarget, "utf8"), "concurrent user change");
  assert.equal(caught.code, "TARGET_CHANGED_AFTER_PREVIEW");
  assert.equal(caught.details.written.length, 1);
});
```

- [ ] **Step 2: 运行并确认失败**

Run:

```powershell
node --test tests/apply-preview.test.mjs tests/apply.test.mjs
```

Expected: FAIL，预演接口不存在。

- [ ] **Step 3: 移动分类逻辑并保存快照**

```js
export async function createApplyPreview({ context, signal }) {
  const plan = await buildApplyPlan(context);
  const report = emptyReport();
  const operations = [];
  for (const operation of plan.operations) {
    throwIfAborted(signal);
    const snapshot = await snapshotPath(operation.targetPath);
    const existing = snapshot.exists
      ? await readFile(operation.targetPath, "utf8")
      : undefined;
    const classification = classify(operation, existing);
    operations.push({ operation, classification, snapshot });
    report[classification.category].push(classification.entry);
  }
  return { context, operations, report: sortReport(report) };
}

export async function assertPreviewUnchanged(preview) {
  for (const item of preview.operations) {
    await assertRealPathInside(
      preview.context.workspaceDir,
      item.operation.targetPath,
      { allowMissing: true }
    );
    await assertSnapshotUnchanged(item.snapshot);
  }
}

export async function executeApplyPreview(preview, {
  allowConflicts = true,
  writeFile = writeUtf8Atomic,
  signal
} = {}) {
  if (!allowConflicts && preview.report.conflicts.length > 0) {
    throw new GovernanceError("INIT_CONFLICT", "初始化计划存在冲突", {
      conflicts: preview.report.conflicts
    });
  }
  await assertPreviewUnchanged(preview);
  const written = [];
  try {
    for (const item of preview.operations) {
      if (item.classification.category === "created" ||
          item.classification.category === "updated") {
        if (signal?.aborted) {
          throw new GovernanceError("INTERRUPTED", "用户中断执行");
        }
        await writeFile(item.operation.targetPath, item.operation.content, {
          expectedSnapshot: item.snapshot,
          rootDir: preview.context.workspaceDir,
          signal
        });
        written.push(item.operation.targetPath);
      }
    }
    return { report: preview.report, written };
  } catch (error) {
    error.details = { ...(error.details ?? {}), written };
    throw error;
  }
}
```

`assertPreviewUnchanged()` 是首次写入前的全量零写入门槛；`writeUtf8Atomic(..., expectedSnapshot)` 是每个文件临近提交的第二层条件复核。若全量门槛后才发生并发变化，已经完成的较早文件不会回滚，但变化目标绝不覆盖，并通过 `written` 精确报告为 `partial_failure`；这与设计“不宣称跨仓库全局事务”一致。

- [ ] **Step 4: 让 apply 复用预演**

`applyGovernance`：

```js
const context = await loadProjectManifest(workspaceDir, kitRoot);
const preview = await createApplyPreview({ context });
if (!dryRun) {
  await executeApplyPreview(preview, { allowConflicts: true });
}
return preview.report;
```

- [ ] **Step 5: 验证**

Run:

```powershell
node --test tests/apply-preview.test.mjs tests/apply.test.mjs
npm test
```

Expected: 全部通过；现有 apply 的普通与静态冲突行为不变，只有预览后并发变化按新增回归断言安全失败且不覆盖用户内容。

- [ ] **Step 6: 提交**

```powershell
git add tooling/lib/apply-preview.mjs tooling/lib/apply.mjs tests/apply-preview.test.mjs tests/apply.test.mjs
git commit -m "refactor: share safe apply previews"
```

---

### Task 6: 初始化编排与 Manifest 状态

**Files:**
- Create: `tooling/lib/init.mjs`
- Modify: `tooling/lib/validate.mjs`
- Create: `tests/init.test.mjs`

**Interfaces:**
- Produces: `planInitialization({ workspaceDir, kitRoot, reconfigure, answers })`
- Produces: `executeInitialization(plan, { signal })`
- Produces: `initializeGovernance(options)`
- Private: `classifyManifestChange(snapshot, candidate, { reconfigure })` implements the five Manifest states from the design.
- Private: `makeInitPlan(input)` merges Manifest and apply reports into a stable plan.
- Private: `resultWithoutPlan(resolved)` maps detection results to `needs_input` or `unsupported` with a stable reason code.
- Private: `resolveEvidenceQuestions(evidence, answers)` keeps unconfirmed compatibility questions blocking.
- Private: result builders `conflictResult`, `appliedResult`, `failedValidationResult`, and `partialFailureResult` return the JSON status schema defined in the design.
- Internal plans use `status: "ready"`; only dry-run public results use `status: "planned"`.

- [ ] **Step 1: 编写初始化状态失败测试**

```js
test("plans an absent manifest without writing it", async (t) => {
  const plan = await planInitialization({ workspaceDir, kitRoot });
  assert.equal(plan.status, "ready");
  assert.equal(plan.manifestChange.category, "created");
  await assert.rejects(readFile(path.join(workspaceDir, "governance-kit.yaml"), "utf8"));
});

test("uses an existing valid manifest without re-detecting", async () => {
  const plan = await planInitialization({ workspaceDir, kitRoot });
  assert.equal(plan.manifestChange.category, "unchanged");
  assert.equal(plan.source, "existing-manifest");
});

test("shows a manifest diff only with reconfigure", async () => {
  const plan = await planInitialization({
    workspaceDir,
    kitRoot,
    reconfigure: true,
    answers
  });
  assert.equal(plan.manifestChange.category, "updated");
  assert.match(plan.manifestChange.diff, /^[-+]/m);
});

test("does not write anything when a governance target conflicts", async () => {
  const before = await snapshotWorkspace(workspaceDir);
  const result = await initializeGovernance({
    workspaceDir,
    kitRoot,
    yes: true
  });
  assert.equal(result.status, "conflict");
  assert.deepEqual(await snapshotWorkspace(workspaceDir), before);
});

test("permission preflight failure leaves every target unchanged", async () => {
  const before = await snapshotWorkspace(workspaceDir);
  const result = await planInitialization({
    workspaceDir,
    kitRoot,
    preflightTargets: async () => {
      throw new GovernanceError("TARGET_NOT_WRITABLE", "无写入权限");
    }
  });
  assert.equal(result.status, "conflict");
  assert.equal(result.code, "TARGET_NOT_WRITABLE");
  assert.deepEqual(await snapshotWorkspace(workspaceDir), before);
});
```

- [ ] **Step 2: 运行并确认失败**

Run:

```powershell
node --test tests/init.test.mjs
```

Expected: FAIL，初始化模块不存在。

- [ ] **Step 3: 实现计划分支**

```js
async function planInitializationUnsafe({
  workspaceDir,
  kitRoot = defaultKitRoot,
  reconfigure = false,
  answers = {},
  preflightTargets = preflightWritableTargets,
  signal
}) {
  throwIfAborted(signal);
  const manifestPath = path.join(path.resolve(workspaceDir), "governance-kit.yaml");
  let manifestSnapshot;
  try {
    await assertRealPathInside(workspaceDir, manifestPath, { allowMissing: true });
    manifestSnapshot = await snapshotPath(manifestPath);
    throwIfAborted(signal);
  } catch (error) {
    if (error.code === "INTERRUPTED") throw error;
    return planningConflictResult(workspaceDir, normalizeExecutionError(error));
  }

  let existingContext;
  if (manifestSnapshot.exists) {
    try {
      existingContext = await loadProjectManifest(workspaceDir, kitRoot, {
        requireComponentDirs: true,
        signal
      });
    } catch (error) {
      if (error.code === "INTERRUPTED") throw error;
      return invalidManifestResult(workspaceDir, normalizeManifestError(error));
    }
    throwIfAborted(signal);
  }

  if (manifestSnapshot.exists && !reconfigure) {
    const context = existingContext;
    const evidence = resolveEvidenceQuestions(
      await validateContextEvidence(context, { signal }),
      answers
    );
    if (evidence.status !== "ready") {
      return resultWithoutPlan(evidence);
    }
    throwIfAborted(signal);
    const applyPreview = await createApplyPreview({ context, signal });
    throwIfAborted(signal);
    const preflight = await preflightInitTargets({
      manifestPath,
      manifestChange: { category: "unchanged", snapshot: manifestSnapshot },
      applyPreview,
      preflightTargets,
      signal
    });
    if (preflight) return preflight;
    return makeInitPlan({
      source: "existing-manifest",
      workspaceDir: path.resolve(workspaceDir),
      kitRoot,
      manifestPath,
      manifestContent: null,
      manifestChange: { category: "unchanged", snapshot: manifestSnapshot },
      gitStates: await inspectContextGitStates(context, { signal }),
      applyPreview
    });
  }

  if (signal?.aborted) return interruptedResultForPlanning(workspaceDir);
  const scan = await scanWorkspace({ workspaceDir, signal });
  const gitStates = await inspectGitStates({
    gitMarkers: scan.gitMarkers,
    signal
  });
  if (signal?.aborted) return interruptedResultForPlanning(workspaceDir);
  throwIfAborted(signal);
  const detection = await detectWorkspace({ workspaceDir, scan, signal });
  throwIfAborted(signal);
  const resolved = resolveInitManifest({ workspaceDir, detection, answers });
  throwIfAborted(signal);
  if (resolved.status !== "ready") return resultWithoutPlan(resolved);

  const manifestContent = renderInitManifest(resolved.manifest);
  const context = await createProjectContext({
    workspaceDir,
    kitRoot,
    manifest: resolved.manifest,
    requireComponentDirs: true,
    signal
  });
  throwIfAborted(signal);
  const applyPreview = await createApplyPreview({ context, signal });
  throwIfAborted(signal);
  const manifestChange = classifyManifestChange(
    manifestSnapshot,
    manifestContent,
    { reconfigure }
  );
  const preflight = await preflightInitTargets({
    manifestPath,
    manifestChange,
    applyPreview,
    preflightTargets,
    signal
  });
  if (preflight) return preflight;
  return makeInitPlan({
    source: reconfigure ? "reconfigure" : "detected",
    workspaceDir: path.resolve(workspaceDir),
    kitRoot,
    gitStates,
    manifestPath,
    manifestContent,
    manifestChange,
    applyPreview
  });
}
```

公开的 `planInitialization(options)` 包装 `planInitializationUnsafe(options)`：捕获 `INTERRUPTED` 并返回 `interruptedResultForPlanning`；捕获 `UNSAFE_REAL_PATH`、`TARGET_CHANGED_DURING_READ`、`TARGET_CHANGED_AFTER_PREVIEW`、`TARGET_NOT_WRITABLE` 等可预期预写错误并返回结构化 `conflict`；只让无法构造业务结果的启动级错误继续抛出。这样 JSON、非 TTY 和 dry-run 在规划中断/路径异常时也保持单一结果协议。

统一的 `throwIfAborted(signal)` 在每个规划阶段前后调用；`scanWorkspace`、`inspectGitStates`、`detectWorkspace`、`validateContextEvidence`、`createProjectContext`、`createApplyPreview` 和 `preflightInitTargets` 的内部遍历也在每轮检查 signal。测试通过注入 detector/preview hook 在执行中 abort，断言 dry-run 返回 `interrupted`、CLI 退出 130、stdout/stderr 协议正确且工作区零写入。

另建已有有效 Manifest fixture，在 Manifest 快照完成后、`loadProjectManifest` 和 `validateContextEvidence` 期间分别触发 abort；三种情况都必须返回 `interrupted`/130，而不是 conflict 或 `INVALID_MANIFEST`，且 stdout 为单一 JSON、stderr 为空、工作区快照不变。

`normalizeManifestError()` 必须把 YAML 语法错误、Schema 错误和可预期读取错误统一包装为不泄漏堆栈的 `INVALID_MANIFEST`；测试同时覆盖非法 YAML（例如未闭合 flow sequence）与 Schema 不兼容。`preflightInitTargets()` 收集 Manifest（仅 created/updated）和 apply preview 中全部 created/updated 目标，在一次无写入检查中调用 `preflightWritableTargets()`；任一失败返回 `status: "conflict"` 和原始稳定 code。

- [ ] **Step 4: 实现任何写入前复核和执行**

```js
export async function executeInitialization(plan, {
  writeFile = writeUtf8Atomic,
  executePreview = executeApplyPreview,
  validate = validateWorkspace,
  signal
} = {}) {
  if (plan.status !== "ready") return plan;
  if (plan.report.conflicts.length > 0) return conflictResult(plan);

  const written = [];
  try {
    await preflightWritableTargets(plan.writableTargets);
    await assertRealPathInside(
      plan.workspaceDir,
      plan.manifestPath,
      { allowMissing: true }
    );
    await assertSnapshotUnchanged(plan.manifestChange.snapshot);
    await assertPreviewUnchanged(plan.applyPreview);
    if (signal?.aborted) throw new GovernanceError("INTERRUPTED", "用户中断执行");

    if (plan.manifestChange.category === "created" ||
        plan.manifestChange.category === "updated") {
      await writeFile(plan.manifestPath, plan.manifestContent, {
        expectedSnapshot: plan.manifestChange.snapshot,
        rootDir: plan.workspaceDir,
        signal
      });
      written.push(plan.manifestPath);
    }
    const applied = await executePreview(plan.applyPreview, {
      allowConflicts: false,
      signal
    });
    written.push(...applied.written);
    const validation = await validate({
      workspaceDir: plan.workspaceDir,
      kitRoot: plan.kitRoot,
      signal
    });
    if (signal?.aborted) {
      return interruptedResult(plan, new GovernanceError(
        "INTERRUPTED",
        "用户在验证阶段中断"
      ), written);
    }
    return validation.valid
      ? appliedResult(plan, validation, written)
      : failedValidationResult(plan, validation, written);
  } catch (error) {
    written.push(...(error.details?.written ?? []));
    if (error.code === "INTERRUPTED") {
      return interruptedResult(plan, error, written);
    }
    if (written.length === 0) {
      return prewriteConflictResult(plan, normalizeExecutionError(error));
    }
    return partialFailureResult(plan, error, written);
  }
}
```

`executeInitialization` 不能再次调用 `applyGovernance`，避免重新读取 Manifest 和重新规划。

`partialFailureResult` 只能在 `written.length > 0` 时使用。其 `recovery.safeToRerun` 不是无条件常量：结果构造器必须核对已写文件仍为本计划期望内容后才为 `true`；即使用户随后修改，下一次 init 也必须转为 conflict 且不覆盖。验证返回无效时必须固定为 `status: "failed_validation"`、`applied: true`、`valid: false`，不得误入 partial failure。

`validateWorkspace({ ..., signal })` 在各文件/规则遍历边界检查 signal，并以 `INTERRUPTED` 停止；不传 signal 时保持现有调用完全兼容。测试注入“扫描中 abort、dry-run 规划中 abort、验证中 abort”，分别断言 status/exit code、stdout/stderr 和工作区快照；验证阶段中断若已有写入，结果必须带准确 `written` 和恢复信息。

- [ ] **Step 5: 实现无交互用例入口**

```js
export async function initializeGovernance({
  workspaceDir,
  kitRoot = defaultKitRoot,
  reconfigure = false,
  answers = {},
  dryRun = false,
  yes = false,
  signal
}) {
  const plan = await planInitialization({
    workspaceDir,
    kitRoot,
    reconfigure,
    answers,
    signal
  });
  if (plan.status !== "ready") return plan;
  if (dryRun) return plannedResult(plan);
  if (!yes) return needsFinalConfirmationResult(plan);
  return executeInitialization(plan, { signal });
}
```

交互层只负责收集 `answers` 和最终确认；核心用例不直接读取 stdin。

- [ ] **Step 6: 增加取消、失败恢复和幂等测试**

```js
test("returns a safe rerun command after a caught partial failure", async () => {
  const result = await executeInitialization(planWithInjectedWriteFailure);
  assert.equal(result.status, "partial_failure");
  assert.equal(result.recovery.safeToRerun, true);
  assert.equal(result.recovery.nextCommand, "npx dev-governance-kit init --verbose");
});

test("a user edit after partial failure is never overwritten on rerun", async () => {
  const first = await executeInitialization(planWithInjectedWriteFailure);
  await writeFile(first.written[0], "user edit", "utf8");
  const before = await snapshotWorkspace(workspaceDir);
  const rerun = await initializeGovernance({ workspaceDir, kitRoot, yes: true });
  assert.equal(rerun.status, "conflict");
  assert.deepEqual(await snapshotWorkspace(workspaceDir), before);
});

test("validation failure reports applied true and valid false", async () => {
  const result = await executeInitialization(plan, {
    validate: async () => ({ valid: false, errors: [{ code: "INJECTED" }] })
  });
  assert.equal(result.status, "failed_validation");
  assert.equal(result.applied, true);
  assert.equal(result.valid, false);
});

test("a second initialization is unchanged and valid", async () => {
  assert.equal((await initializeGovernance({ workspaceDir, yes: true })).status, "applied");
  const second = await initializeGovernance({ workspaceDir, yes: true });
  assert.equal(second.status, "applied");
  assert.equal(second.report.created.length, 0);
  assert.equal(second.report.updated.length, 0);
});
```

- [ ] **Step 7: 验证**

Run:

```powershell
node --test tests/init.test.mjs
npm test
```

Expected: 全部通过。

- [ ] **Step 8: 提交**

```powershell
git add tooling/lib/init.mjs tooling/lib/validate.mjs tests/init.test.mjs
git commit -m "feat: orchestrate safe governance initialization"
```

---

### Task 7: 小白人类展示与最多三个交互页面

**Files:**
- Create: `tooling/lib/init-presenter.mjs`
- Create: `tooling/lib/init-prompts.mjs`
- Modify: `tests/init.test.mjs`

**Interfaces:**
- Produces: `formatInitHuman(result, { verbose })`
- Produces: `createPromptSession({ input, output })`
- Produces: `collectInitAnswers({ plan, promptSession })`
- Private: novice formatters render component purpose, relative paths, safety promises and next actions.
- Private: verbose formatters add Profile IDs, evidence, warnings, absolute paths and internal codes.

- [ ] **Step 1: 编写小白输出失败测试**

```js
test("default output explains components without internal terms", () => {
  const output = formatInitHuman(plannedResult, { verbose: false });
  assert.match(output, /找到后端服务/);
  assert.match(output, /处理业务、数据和接口/);
  assert.match(output, /不会修改你的业务代码/);
  assert.match(output, /存在未提交修改.*不会提交、回滚或清理/s);
  assert.doesNotMatch(output, /Profile|repositoryMode|contract owner|confidence/);
});

test("verbose output includes evidence and internal codes", () => {
  const output = formatInitHuman(plannedResult, { verbose: true });
  assert.match(output, /java-springboot-mybatis/);
  assert.match(output, /pom.xml/);
});

test("empty confirmation defaults to cancelled", async () => {
  const answers = await collectInitAnswers({
    plan,
    promptSession: scriptedPrompt([""])
  });
  assert.equal(answers.status, "cancelled");
});
```

- [ ] **Step 2: 运行并确认失败**

Run:

```powershell
node --test tests/init.test.mjs
```

Expected: FAIL，展示和交互模块不存在。

- [ ] **Step 3: 实现三层输出**

```js
export function formatInitHuman(result, { verbose = false } = {}) {
  if (result.status === "planned") {
    return verbose ? formatVerbosePlan(result) : formatNovicePlan(result);
  }
  if (result.status === "conflict") {
    return verbose ? formatVerboseConflict(result) : formatNoviceConflict(result);
  }
  return verbose ? formatVerboseResult(result) : formatNoviceResult(result);
}
```

默认冲突输出必须显示相对路径；绝对路径和错误码只在 verbose 中显示。

- [ ] **Step 4: 实现可注入交互**

```js
export function createPromptSession({ input, output, signal: externalSignal }) {
  const rl = createInterface({ input, output });
  const controller = new AbortController();
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal;
  rl.on("SIGINT", () => controller.abort());

  async function ask(message) {
    try {
      return await rl.question(message, { signal });
    } catch (error) {
      if (signal.aborted) {
        throw new GovernanceError("INTERRUPTED", "用户中断初始化");
      }
      if (error.code === "ERR_USE_AFTER_CLOSE") {
        throw new GovernanceError("INPUT_EOF", "输入流已结束");
      }
      throw error;
    }
  }

  return {
    signal,
    async choose(question) {
      return ask(renderQuestion(question));
    },
    async confirm() {
      const answer = await ask("是否继续？(y/N) ");
      return /^y(es)?$/i.test(answer.trim());
    },
    close() {
      rl.close();
    }
  };
}
```

`collectInitAnswers` 把多个低风险字段合并到同一复核页，最多三个页面；超过上限返回 `needs_input`，不猜测。

进程级 `AbortController` 生命周期覆盖“扫描、提问、确认、写入、验证”整个命令，而不是只覆盖 `rl.question()`；signal 必须一路传入 `executeInitialization` 和每次文件提交。单元测试在第一个文件写入后触发 abort，断言后续文件未写、已写清单准确；Unix 黑盒测试还要比较中断前后工作区快照或明确的已写集合。

- [ ] **Step 5: 验证**

Run:

```powershell
node --test tests/init.test.mjs
npm test
```

Expected: 全部通过。

- [ ] **Step 6: 提交**

```powershell
git add tooling/lib/init-presenter.mjs tooling/lib/init-prompts.mjs tests/init.test.mjs
git commit -m "feat: guide novice users through init"
```

---

### Task 8: CLI、JSON 和退出码

**Files:**
- Modify: `tooling/cli.mjs`
- Modify: `tooling/index.mjs`
- Create: `tests/cli-init.test.mjs`
- Modify: `tests/package.test.mjs`

**Interfaces:**
- Consumes: `initializeGovernance()`、`formatInitHuman()`、prompt session。
- Produces CLI: `init --workspace --dry-run --yes --verbose --json --reconfigure`
- Private: `runInitCommand(options, io)` plans first, collects answers only in interactive mode, then calls `executeInitialization` after explicit confirmation.
- Private: `exitCodeFor(result)` maps the fixed status enum to `0`, `1`, `2`, or `130`.

- [ ] **Step 1: 编写 CLI 失败测试**

```js
test("init dry-run emits one JSON document and writes nothing", async (t) => {
  const result = await runCli([
    "init", "--workspace", workspace, "--dry-run", "--json"
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "planned");
  assert.deepEqual(await snapshotWorkspace(workspace), before);
});

test("interactive --dry-run --yes still writes nothing", async () => {
  const before = await snapshotWorkspace(workspace);
  const result = await runInteractiveCli([
    "init", "--workspace", workspace, "--dry-run", "--yes"
  ], "");
  assert.equal(result.code, 0);
  assert.deepEqual(await snapshotWorkspace(workspace), before);
  assert.equal((result.stdout.match(/准备完成项目治理配置/g) ?? []).length, 1);
});

test("json never prompts and returns needs_input", async () => {
  const result = await runCli([
    "init", "--workspace", ambiguousWorkspace, "--json"
  ]);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).status, "needs_input");
});

test("explicit N exits zero as cancelled", async () => {
  const result = await runInteractiveCli(["init", "--workspace", workspace], "N\n");
  assert.equal(result.code, 0);
  assert.match(result.stdout, /没有修改/);
});

test("Ctrl+C exits 130", async () => {
  const before = await snapshotWorkspace(workspace);
  const result = await interruptInteractiveCli(["init", "--workspace", workspace]);
  assert.equal(result.code, 130);
  assert.deepEqual(await snapshotWorkspace(workspace), before);
});

test("interactive answers are used to replan before final confirmation", async () => {
  const result = await runInteractiveCli(
    ["init", "--workspace", ambiguousWorkspace],
    "1\ny\n"
  );
  assert.equal(result.code, 0);
  assert.match(result.stdout, /哪一个是管理员使用的后台/);
  assert.match(result.stdout, /准备完成项目治理配置/);
  assert.match(result.stdout, /项目治理配置已完成/);
});

test("non-TTY without yes returns needs_input instead of planned", async () => {
  const result = await runCliWithoutTty([
    "init", "--workspace", workspace
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /需要确认/);
});
```

`Ctrl+C` 测试分两层：Windows 使用注入的 AbortSignal 验证 prompt 返回 `interrupted` 且 `exitCodeFor` 为 `130`；Ubuntu/macOS 再用 `child.kill("SIGINT")` 做真实子进程黑盒测试，避免依赖 Windows PTY 的不稳定控制事件行为。

组合测试还必须覆盖 `--json --yes`、`--json --dry-run --yes`、普通非 TTY、非 TTY `--yes`、EOF、未知参数退出码 2、预览后外部修改，以及 JSON 序列化失败的启动级错误。每个 JSON 业务结果都断言 stdout 恰好可解析为一个 JSON 文档、stderr 为空；每个零写入结果比较完整工作区快照。

- [ ] **Step 2: 运行并确认失败**

Run:

```powershell
node --test tests/cli-init.test.mjs
```

Expected: FAIL，`init` 仍是未知命令。

- [ ] **Step 3: 扩展参数解析**

`parseArgs` 对 `init` 接受：

```js
{
  command: "init",
  workspace: process.cwd(),
  dryRun: false,
  yes: false,
  verbose: false,
  json: false,
  reconfigure: false
}
```

约束：

- `--reconfigure`、`--yes`、`--verbose` 仅用于 `init`。
- `--dry-run` 可用于 `init` 和 `apply`。
- `--json` 模式不得创建 readline。
- 非 TTY 且需要回答时立即返回 `needs_input`。

- [ ] **Step 4: 接入运行和退出码**

```js
async function runInitCommand(options, io) {
  const answers = {};
  let pages = 0;
  let plan = await planInitialization({
    ...options,
    answers,
    signal: io.signal
  });

  if (options.json || !io.input.isTTY) {
    if (plan.status !== "ready") return plan;
    if (options.dryRun) return plannedResult(plan);
    if (options.yes) {
      return executeInitialization(plan, { signal: io.signal });
    }
    return needsFinalConfirmationResult(plan);
  }

  const prompts = createPromptSession({ ...io, signal: io.signal });
  try {
    while (plan.status === "needs_input") {
      if (pages >= 3) return plan;
      const page = await collectInitAnswers({
        plan,
        promptSession: prompts
      });
      if (page.status === "cancelled" || page.status === "interrupted") {
        return page;
      }
      Object.assign(answers, page.answers);
      pages += 1;
      plan = await planInitialization({
        ...options,
        answers,
        signal: prompts.signal
      });
    }
    if (plan.status !== "ready") return plan;
    if (options.dryRun) return plannedResult(plan);
    if (options.yes) {
      return executeInitialization(plan, { signal: prompts.signal });
    }

    io.output.write(`${formatInitHuman(plannedResult(plan), {
      verbose: options.verbose
    })}\n`);

    const confirmed = await prompts.confirm();
    if (!confirmed) {
      return {
        command: "init",
        workspace: options.workspace,
        ok: true,
        status: "cancelled",
        applied: false
      };
    }
    return executeInitialization(plan, { signal: prompts.signal });
  } catch (error) {
    if (error.code === "INTERRUPTED") {
      return {
        command: "init",
        workspace: options.workspace,
        ok: false,
        status: "interrupted",
        applied: false
      };
    }
    if (error.code === "INPUT_EOF") {
      return {
        command: "init",
        workspace: options.workspace,
        ok: false,
        status: "needs_input",
        applied: false,
        questions: [{
          code: "INPUT_REQUIRED",
          message: "输入流已结束"
        }]
      };
    }
    throw error;
  } finally {
    prompts.close();
  }
}

function exitCodeFor(result) {
  if (result.status === "interrupted") return 130;
  if (result.status === "cancelled") return 0;
  if (result.ok) return 0;
  return 1;
}

if (options.command === "init") {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  const result = await runInitCommand(options, {
    input: process.stdin,
    output: process.stdout,
    signal: controller.signal
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatInitHuman(result, {
      verbose: options.verbose
    })}\n`);
  }
  process.exitCode = exitCodeFor(result);
  process.removeListener("SIGINT", onSigint);
}
```

正常结构化业务结果 stderr 为空。

- [ ] **Step 5: 导出公开接口并更新帮助测试**

`tooling/index.mjs` 增加：

```js
export {
  initializeGovernance
} from "./lib/init.mjs";
```

`planInitialization` 和 `executeInitialization` 仅作为内部模块测试接口，不从包主入口公开，避免把内部 `ready` 状态当成 CLI 协议。帮助文本必须展示 `init`，不能展示尚未实现的 `create`。

- [ ] **Step 6: 验证**

Run:

```powershell
node --test tests/cli-init.test.mjs tests/package.test.mjs
npm test
```

Expected: 全部通过。

- [ ] **Step 7: 提交**

```powershell
git add tooling/cli.mjs tooling/index.mjs tests/cli-init.test.mjs tests/package.test.mjs
git commit -m "feat: expose guided init CLI"
```

---

### Task 9: 三种仓库、安全边界和恢复端到端门禁

**Files:**
- Modify: `tests/cli-init.test.mjs`
- Modify: `tests/init.test.mjs`
- Modify: `tests/helpers/project-workspace.mjs`

**Interfaces:**
- Verifies all public `init` behavior from the design.

- [ ] **Step 1: 增加 monorepo 与 multi-repo 黑盒测试**

```js
for (const fixture of ["detected-monorepo", "detected-multi-repo"]) {
  test(`${fixture} init then validate succeeds`, async (t) => {
    const workspace = await createDetectedWorkspace(t, fixture);
    const initialized = await runCli([
      "init", "--workspace", workspace, "--yes", "--json"
    ]);
    assert.equal(initialized.code, 0);
    assert.equal(JSON.parse(initialized.stdout).status, "applied");
    const validated = await runCli([
      "validate", "--workspace", workspace, "--json"
    ]);
    assert.equal(validated.code, 0);
  });
}
```

- [ ] **Step 2: 增加工作区快照和冲突门禁**

```js
test("user AGENTS.md conflict leaves the entire workspace unchanged", async (t) => {
  const before = await snapshotWorkspace(workspace);
  const result = await runCli([
    "init", "--workspace", workspace, "--yes", "--json"
  ]);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).status, "conflict");
  assert.deepEqual(await snapshotWorkspace(workspace), before);
});

test("business status-enums.json conflict leaves the entire workspace unchanged", async (t) => {
  await writeFile(
    path.join(workspace, "status-enums.json"),
    JSON.stringify({ owner: "business" }),
    "utf8"
  );
  const before = await snapshotWorkspace(workspace);
  const result = await runCli([
    "init", "--workspace", workspace, "--yes", "--json"
  ]);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).status, "conflict");
  assert.deepEqual(await snapshotWorkspace(workspace), before);
});
```

- [ ] **Step 3: 增加路径和恢复测试**

```js
test("rejects symlink and junction escapes", async (t) => {
  const { workspace, outside } = await createLinkedComponentWorkspace(t);
  const before = await snapshotWorkspace(workspace);
  const result = await runCli([
    "init", "--workspace", workspace, "--yes", "--json"
  ]);
  assert.equal(result.code, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "conflict");
  assert.ok(output.report.conflicts.some((item) =>
    item.code === "UNSAFE_REAL_PATH"
  ));
  assert.deepEqual(await snapshotWorkspace(workspace), before);
  assert.deepEqual(await snapshotWorkspace(outside), {});
});

// Fixture 必须分别创建 directory symlink、file symlink 和 Windows junction；
// capability 不足时显式 t.skip() 并写明原因，不能用模拟代替真实文件系统。

test("manifest file symlink returns one structured conflict", async (t) => {
  const { workspace, outsideManifest } = await createManifestLinkWorkspace(t);
  const beforeWorkspace = await snapshotWorkspace(workspace);
  const beforeOutside = await readFile(outsideManifest, "utf8");
  const result = await runCli([
    "init", "--workspace", workspace, "--yes", "--json"
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "conflict");
  assert.equal(output.code, "UNSAFE_REAL_PATH");
  assert.deepEqual(await snapshotWorkspace(workspace), beforeWorkspace);
  assert.equal(await readFile(outsideManifest, "utf8"), beforeOutside);
});

test("supports Chinese and spaced workspace paths", async (t) => {
  const workspace = await createDetectedWorkspace(
    t,
    "detected-monorepo",
    { prefix: "治理 项目-" }
  );
  const result = await runCli([
    "init", "--workspace", workspace, "--yes", "--json"
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "applied");
});

test("reports partial_failure and safely reruns", async (t) => {
  const workspace = await createDetectedWorkspace(t, "detected-monorepo");
  const plan = await planInitialization({ workspaceDir: workspace, kitRoot });
  let writes = 0;
  const first = await executeInitialization(plan, {
    executePreview: async (preview, options) =>
      executeApplyPreview(preview, {
        ...options,
        writeFile: async (target, content, writeOptions) => {
          writes += 1;
          if (writes === 2) throw new Error("injected write failure");
          await writeUtf8Atomic(target, content, writeOptions);
        }
      })
  });
  assert.equal(first.status, "partial_failure");
  assert.ok(first.written.length >= 1);
  assert.equal(first.recovery.safeToRerun, true);
  const rerun = await initializeGovernance({
    workspaceDir: workspace,
    kitRoot,
    yes: true
  });
  assert.equal(rerun.status, "applied");
});

test("existing invalid manifest is never overwritten", async (t) => {
  const workspace = await createDetectedWorkspace(t, "detected-monorepo");
  const manifestPath = path.join(workspace, "governance-kit.yaml");
  await writeFile(manifestPath, "schemaVersion: broken\n", "utf8");
  const before = await snapshotWorkspace(workspace);
  const result = await runCli([
    "init", "--workspace", workspace, "--yes", "--json"
  ]);
  assert.equal(result.code, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "conflict");
  assert.equal(output.code, "INVALID_MANIFEST");
  assert.deepEqual(await snapshotWorkspace(workspace), before);
});

test("syntactically invalid YAML returns one structured conflict", async (t) => {
  const workspace = await createDetectedWorkspace(t, "detected-monorepo");
  await writeFile(
    path.join(workspace, "governance-kit.yaml"),
    "components: [unterminated\n",
    "utf8"
  );
  const before = await snapshotWorkspace(workspace);
  const result = await runCli([
    "init", "--workspace", workspace, "--yes", "--json"
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "conflict");
  assert.equal(output.code, "INVALID_MANIFEST");
  assert.deepEqual(await snapshotWorkspace(workspace), before);
});

for (const [kind, invalidContent] of [
  ["yaml", "components: [unterminated\n"],
  ["schema", "schemaVersion: broken\n"]
]) {
  test(`reconfigure never overwrites an invalid ${kind} manifest`, async (t) => {
    const workspace = await createDetectedWorkspace(t, "detected-monorepo");
    await writeFile(
      path.join(workspace, "governance-kit.yaml"),
      invalidContent,
      "utf8"
    );
    const before = await snapshotWorkspace(workspace);
    const result = await runCli([
      "init", "--workspace", workspace,
      "--reconfigure", "--yes", "--json"
    ]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).code, "INVALID_MANIFEST");
    assert.deepEqual(await snapshotWorkspace(workspace), before);
  });
}

test("reconfigure updates only after showing a diff and confirmation", async (t) => {
  const workspace = await createInitializedWorkspace(t);
  const before = await readFile(
    path.join(workspace, "governance-kit.yaml"),
    "utf8"
  );
  const dryRun = await runCli([
    "init", "--workspace", workspace, "--reconfigure", "--dry-run", "--json"
  ]);
  assert.equal(dryRun.code, 0);
  assert.match(JSON.parse(dryRun.stdout).manifestChange.diff, /^[-+]/m);
  assert.equal(
    await readFile(path.join(workspace, "governance-kit.yaml"), "utf8"),
    before
  );
  const applied = await runCli([
    "init", "--workspace", workspace, "--reconfigure", "--yes", "--json"
  ]);
  assert.equal(applied.code, 0);
  assert.notEqual(
    await readFile(path.join(workspace, "governance-kit.yaml"), "utf8"),
    before
  );
});

test("empty workspace returns unsupported with no-project reason", async (t) => {
  const workspace = await createEmptyWorkspace(t);
  const before = await snapshotWorkspace(workspace);
  const result = await runCli([
    "init", "--workspace", workspace, "--yes", "--json"
  ]);
  assert.equal(result.code, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "unsupported");
  assert.equal(output.code, "NO_PROJECT_FOUND");
  assert.deepEqual(await snapshotWorkspace(workspace), before);
});

test("unsupported project leaves the workspace unchanged", async (t) => {
  const workspace = await createUnsupportedWorkspace(t);
  const before = await snapshotWorkspace(workspace);
  const result = await runCli([
    "init", "--workspace", workspace, "--yes", "--json"
  ]);
  assert.equal(result.code, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "unsupported");
  assert.equal(output.code, "UNSUPPORTED_PROJECT");
  assert.deepEqual(await snapshotWorkspace(workspace), before);
});
```

每个测试必须比较执行前后工作区快照，或明确断言预期的托管文件集合。

- [ ] **Step 4: 运行完整测试两次**

Run:

```powershell
npm test
npm test
```

Expected: 两次均全部通过，无随机失败。

- [ ] **Step 5: 提交**

```powershell
git add tests/cli-init.test.mjs tests/init.test.mjs tests/helpers/project-workspace.mjs
git commit -m "test: harden guided init workflows"
```

---

## Plan Completion Gate

- [ ] `npm test` 全部通过。
- [ ] `node tooling/cli.mjs --help` 只展示已实现命令。
- [ ] 标准 monorepo 和 multi-repo 执行 `init --yes --json` 后直接 `validate`。
- [ ] 冲突、取消、dry-run 和识别失败时工作区快照不变。
- [ ] 默认输出不包含内部术语。
- [ ] `--verbose` 和 `--json` 保留完整诊断。
- [ ] Windows 下完成源码 CLI 黑盒测试。
- [ ] 工作树只包含本计划内变更。

完成本计划后，继续执行：

`docs/superpowers/plans/2026-07-19-npm-release.md`
