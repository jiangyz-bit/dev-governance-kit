# npm Release and Cross-Platform Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已经通过引导式初始化验收的 CLI 打包为公开的 `dev-governance-kit`，建立 Windows、macOS、Linux 的真实 tarball 门禁和安全发布流程。

**Architecture:** npm 包使用 `files` 白名单只携带运行时资源；CI 在三平台验证源码测试和本地 tarball 用户入口；首次发布由 `coogle` 人工完成，后续由 GitHub Release 触发 OIDC Trusted Publishing。

**Tech Stack:** npm public registry、Node.js 20/22/24、GitHub Actions、npm pack、Node `node:test`。

## Global Constraints

- 本计划依赖 `2026-07-19-guided-init.md` 全部门禁通过。
- npm 包名固定为 `dev-governance-kit`，维护者固定为 `coogle`。
- GitHub 仓库固定为 `jiangyz-bit/dev-governance-kit`。
- 首次公开版本固定为 `0.1.0`。
- Node.js 运行时最低版本为 20。
- 发布包不包含 `tests/`、`docs/superpowers/` 或内部 fixture。
- Windows、macOS、Linux 必须执行真实本地 `.tgz` 烟测。
- MacBook M5 实机验收是首次发布候选版门槛。
- 首次 npm publish 必须由用户在已登录 `coogle`、启用 2FA 的环境中明确执行。
- 后续发布使用 Node.js 24、npm >=11.5.1 和 GitHub OIDC，不保存长期 npm token。
- 实施 CI 时将官方 GitHub Actions 固定到经官方仓库核验的完整 commit SHA；计划片段中的 major tag 仅表示目标主版本。
- 新文件使用 UTF-8。
- 每个任务由独立子智能体实施，并进行规范和质量双重审查。

---

## File Structure

### 修改

- `package.json`：公开包元数据、白名单、发布配置和烟测脚本。
- `package-lock.json`：根包元数据同步。
- `.gitignore`：忽略本地发布候选目录。
- `README.md`：普通用户安装、init/create 场景和三平台用法。
- `tests/package.test.mjs`：发布元数据和包白名单契约。

### 新增

- `tests/package-smoke.test.mjs`：从本地 `.tgz` 执行真实 CLI。
- `tooling/create-smoke-project.mjs`：创建无业务数据的标准三组件测试项目。
- `tooling/package-smoke.mjs`：跨平台 tarball 烟测入口。
- `.github/workflows/ci.yml`：三平台持续集成。
- `tooling/release-evidence.mjs`：创建和校验候选包、提交与文件清单证据。
- `tests/release-evidence.test.mjs`：候选证据篡改和绑定测试。
- `.github/workflows/publish.yml`：Release 触发的可信发布。
- `tooling/verify-release.mjs`：tag、版本、包存在性和元数据门禁。
- `docs/MACOS_RELEASE_TEST.md`：MacBook M5 发布候选验收步骤。

---

### Task 1: npm 公开包元数据和文件白名单

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`
- Modify: `tests/package.test.mjs`

**Interfaces:**
- Produces npm package `dev-governance-kit@0.1.0`
- Produces primary bin: `dev-governance-kit -> ./tooling/cli.mjs`
- Preserves compatibility bin: `governance-kit -> ./tooling/cli.mjs`

- [ ] **Step 1: 编写失败测试**

```js
test("package metadata is ready for the public npm registry", async () => {
  const pkg = JSON.parse(await readFile(packageUrl, "utf8"));
  assert.equal(pkg.name, "dev-governance-kit");
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.author, "coogle");
  assert.equal(pkg.license, "MIT");
  assert.equal(
    pkg.repository.url,
    "https://github.com/jiangyz-bit/dev-governance-kit.git"
  );
  assert.equal(pkg.publishConfig.access, "public");
  assert.equal(pkg.publishConfig.registry, "https://registry.npmjs.org/");
  assert.deepEqual(pkg.bin, {
    "dev-governance-kit": "./tooling/cli.mjs",
    "governance-kit": "./tooling/cli.mjs"
  });
  assert.deepEqual(pkg.files, [
    "blueprints/",
    "core/",
    "profiles/",
    "schemas/",
    "templates/",
    "tooling/cli.mjs",
    "tooling/index.mjs",
    "tooling/lib/",
    "docs/MANIFEST_REFERENCE.md"
  ]);
});
```

- [ ] **Step 2: 运行并确认失败**

Run:

```powershell
node --test tests/package.test.mjs
```

Expected: FAIL，因为 `private` 仍存在且元数据缺失。

- [ ] **Step 3: 更新 package.json**

目标字段：

```json
{
  "name": "dev-governance-kit",
  "version": "0.1.0",
  "description": "面向 AI Agent 的工程治理 CLI，为已有项目生成统一规则、技术约束与验证机制。",
  "keywords": [
    "ai-agent",
    "agents-md",
    "engineering-governance",
    "developer-tools",
    "cli",
    "monorepo"
  ],
  "author": "coogle",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/jiangyz-bit/dev-governance-kit.git"
  },
  "homepage": "https://github.com/jiangyz-bit/dev-governance-kit#readme",
  "bugs": {
    "url": "https://github.com/jiangyz-bit/dev-governance-kit/issues"
  },
  "files": [
    "blueprints/",
    "core/",
    "profiles/",
    "schemas/",
    "templates/",
    "tooling/cli.mjs",
    "tooling/index.mjs",
    "tooling/lib/",
    "docs/MANIFEST_REFERENCE.md"
  ],
  "bin": {
    "dev-governance-kit": "./tooling/cli.mjs",
    "governance-kit": "./tooling/cli.mjs"
  },
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  }
}
```

删除 `"private": true`，保留现有 `type`、`engines`、scripts 和 dependencies；将现有 bin 扩展为主入口与兼容别名。

- [ ] **Step 4: 同步 lockfile**

Run:

```powershell
npm install --package-lock-only --ignore-scripts
```

Expected: `package-lock.json` 根包记录与 `package.json` 一致。

同时在 `.gitignore` 增加：

```text
.release/
```

- [ ] **Step 5: 验证**

Run:

```powershell
node --test tests/package.test.mjs
npm pack --dry-run --json
npm test
```

Expected: 测试通过，pack 输出不包含 `tests/` 或 `docs/superpowers/`。

- [ ] **Step 6: 提交**

```powershell
git add package.json package-lock.json .gitignore tests/package.test.mjs
git commit -m "build: prepare public npm package"
```

---

### Task 2: 面向普通用户的 README

**Files:**
- Modify: `README.md`
- Modify: `tests/package.test.mjs`

**Interfaces:**
- Documents: `npx dev-governance-kit init`
- Distinguishes: available `init` vs planned `create`

- [ ] **Step 1: 编写 README 契约失败测试**

```js
test("README explains npm init for novice users", async () => {
  const readme = await readFile(readmeUrl, "utf8");
  assert.match(readme, /npx dev-governance-kit init/);
  assert.match(readme, /给已有项目接入工程治理/);
  assert.match(readme, /create.*尚未实现/s);
  assert.match(readme, /不会修改你的业务代码/);
  assert.match(readme, /Windows/);
  assert.match(readme, /macOS/);
  assert.match(readme, /Linux/);
  assert.doesNotMatch(readme, /git clone.*3 分钟快速开始/s);
  assert.ok(readme.split(/\r?\n/).length <= 220, "README 应保持可快速浏览");
});
```

- [ ] **Step 2: 运行并确认失败**

Run:

```powershell
node --test tests/package.test.mjs
```

Expected: FAIL，README 仍以克隆源码为主要安装方式。

- [ ] **Step 3: 重写用户入口**

README 保持简洁并按以下顺序：

```markdown
## 我应该使用哪个命令

| 场景 | 命令 | 状态 |
|---|---|---|
| 给已有项目接入治理 | `init` | 可用 |
| 从空目录创建业务项目 | `create` | 尚未实现 |

## 3 分钟接入已有项目

### Windows
```powershell
cd C:\Projects\demo
npx dev-governance-kit init
```

### macOS / Linux
```bash
cd ~/Projects/demo
npx dev-governance-kit init
```
```

继续保留“会做什么、不会做什么”“冲突怎么办”“交给 AI Agent 使用”“高级参数”“从源码参与开发”和许可证。

`docs/MANIFEST_REFERENCE.md` 使用 GitHub 绝对链接：

```text
https://github.com/jiangyz-bit/dev-governance-kit/blob/main/docs/MANIFEST_REFERENCE.md
```

- [ ] **Step 4: 验证**

Run:

```powershell
node --test tests/package.test.mjs
npm test
```

Expected: 全部通过。

- [ ] **Step 5: 提交**

```powershell
git add README.md tests/package.test.mjs
git commit -m "docs: explain guided npm initialization"
```

---

### Task 3: 本地 tarball 真实用户烟测

**Files:**
- Create: `tooling/create-smoke-project.mjs`
- Create: `tooling/package-smoke.mjs`
- Create: `tests/package-smoke.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces script: `npm run test:package`
- Uses exact tarball from `npm pack --json --pack-destination`

- [ ] **Step 1: 编写失败测试**

```js
test("package smoke script verifies the packed CLI", async () => {
  const result = await runNode(["tooling/package-smoke.mjs"], kitRoot);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.packageVersion, "0.1.0");
  assert.equal(output.initStatus, "applied");
  assert.equal(output.validateStatus, "valid");
  assert.equal(output.secondInitUpdated, 0);
});
```

- [ ] **Step 2: 运行并确认失败**

Run:

```powershell
node --test tests/package-smoke.test.mjs
```

Expected: FAIL，烟测脚本不存在。

- [ ] **Step 3: 实现可复用的标准测试项目**

`tooling/create-smoke-project.mjs` 导出：

```js
export async function createSmokeProject(rootDir) {
  const server = path.join(rootDir, "demo-server");
  const admin = path.join(rootDir, "demo-admin");
  const client = path.join(rootDir, "demo-miniprogram");
  await Promise.all([
    mkdir(server, { recursive: true }),
    mkdir(admin, { recursive: true }),
    mkdir(client, { recursive: true })
  ]);
  await writeFile(path.join(server, "pom.xml"), supportedPomXml, "utf8");
  await writeFile(path.join(admin, "package.json"), JSON.stringify({
    name: "demo-admin",
    dependencies: { react: "19.1.0" },
    devDependencies: { vite: "7.0.0", typescript: "5.8.0" },
    scripts: { dev: "vite" }
  }, null, 2), "utf8");
  await writeFile(path.join(admin, "tsconfig.json"), "{}\n", "utf8");
  await writeFile(path.join(client, "project.config.json"), JSON.stringify({
    appid: "touristappid",
    miniprogramRoot: "./"
  }, null, 2), "utf8");
  await writeFile(path.join(client, "app.json"), "{}\n", "utf8");
  await run("git", ["init", "--quiet", rootDir], { cwd: rootDir });
  return { rootDir, server, admin, client };
}
```

直接执行脚本时，第一个参数是要创建的空目录；目录非空时拒绝执行。fixture 必须初始化真实 Git 根目录，确保仓库边界识别在 Windows、macOS、Linux 上一致。

- [ ] **Step 4: 实现 pack 和清单断言**

`tooling/package-smoke.mjs`：

```js
const root = await mkdtemp(path.join(tmpdir(), "governance-package-smoke-"));
const packDir = path.join(root, "pack");
const projectDir = path.join(root, "用户 项目");
await mkdir(packDir, { recursive: true });
await createSmokeProject(projectDir);

const pack = await run("npm", [
  "pack", "--json", "--pack-destination", packDir
], { cwd: kitRoot });
const [{ filename, files, version }] = JSON.parse(pack.stdout);
const paths = files.map((item) => item.path);
assert.equal(paths.some((item) => item.startsWith("tests/")), false);
assert.equal(paths.some((item) => item.startsWith("docs/superpowers/")), false);
```

不能只做排除断言。脚本必须从 `package.json.files` 中的允许目录/文件生成期望集合，再加上 npm 自动包含的 `package.json`、README 和 LICENSE，与 `npm pack --json` 的 `files[].path` 做排序后的精确集合比较；两个 bin 目标都必须存在于实际 tarball 清单。任何额外开发脚本、fixture 或遗漏运行时资源都失败。

脚本同时支持 `--tarball <absolute-path> --source <candidate|registry>`：提供 tarball 时不重新 `npm pack`，而是直接复用同一套全新 consumer、init、validate、幂等、版本与 runtime root 断言。registry 验证结果单独写入 `registryVerification`，不得改写候选 evidence 的原始 commit/hash/files。

- [ ] **Step 5: 从全新临时项目安装 tarball 并执行包名入口**

```js
const tarball = path.resolve(packDir, filename);
const consumerDir = path.join(root, "consumer");
await mkdir(consumerDir, { recursive: true });
await run("npm", ["init", "--yes"], { cwd: consumerDir });
await run("npm", ["install", "--no-audit", "--no-fund", tarball], {
  cwd: consumerDir
});

const init = await run("npx", [
  "--no-install", "dev-governance-kit", "init",
  "--workspace", projectDir,
  "--yes", "--json", "--verbose"
], { cwd: consumerDir });

const validate = await run("npx", [
  "--no-install", "dev-governance-kit", "validate",
  "--workspace", projectDir,
  "--json"
], { cwd: consumerDir });
```

依赖安装允许访问 npm registry，避免干净 CI 因本机缓存为空而误报。再次执行 init，断言 `created` 和 `updated` 均为 0；额外执行一次兼容入口 `npx --no-install governance-kit --help`。最终 stdout 只输出一个烟测 JSON，所有临时目录在 `finally` 清理。

verbose JSON 必须报告 CLI 版本和 `runtime.packageRoot`。烟测断言版本等于 tarball 内 `package/package.json`，且 packageRoot 位于 `consumer/node_modules/dev-governance-kit`，不位于源码仓库；这证明运行时模板与 Schema 从已安装包解析。

- [ ] **Step 6: 增加 npm script 并验证**

`package.json`：

```json
{
  "scripts": {
    "test:package": "node --test tests/package-smoke.test.mjs"
  }
}
```

Run:

```powershell
npm run test:package
npm test
```

Expected: 全部通过。

- [ ] **Step 7: 提交**

```powershell
git add tooling/create-smoke-project.mjs tooling/package-smoke.mjs tests/package-smoke.test.mjs package.json package-lock.json
git commit -m "test: verify packed CLI workflows"
```

---

### Task 4: Windows、Ubuntu、macOS 持续集成

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `tooling/release-evidence.mjs`
- Create: `tests/release-evidence.test.mjs`

**Interfaces:**
- Runs source tests on Node 20/22/24.
- Runs tarball smoke on Windows, Ubuntu and macOS.
- On successful `main`, produces one candidate artifact containing `.tgz` and `release-evidence.json`.

- [ ] **Step 1: 创建 CI 工作流**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, ubuntu-latest, macos-latest]
        node: [20, 22, 24]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm audit --omit=dev

  package-smoke:
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, ubuntu-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 24
      - run: npm ci
      - run: npm run test:package

  release-candidate:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    needs: [test, package-smoke]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 24
      - run: npm ci
      - run: mkdir -p .release
      - id: pack
        shell: bash
        run: |
          npm pack --json --pack-destination .release > .release/pack.json
          node tooling/release-evidence.mjs create --commit "$GITHUB_SHA" --pack-json .release/pack.json --directory .release --output .release/release-evidence.json
          VERSION=$(node -p "require('./package.json').version")
          FILENAME=$(node -e "const p=require('./.release/pack.json'); process.stdout.write(p[0].filename)")
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"
          echo "filename=$FILENAME" >> "$GITHUB_OUTPUT"
      - uses: actions/upload-artifact@v4
        with:
          name: dev-governance-kit-${{ steps.pack.outputs.version }}-${{ github.sha }}
          path: |
            .release/${{ steps.pack.outputs.filename }}
            .release/release-evidence.json
          if-no-files-found: error
          retention-days: 90
```

artifact 名和 tarball 路径必须从本次 `pack.json` 的实际 version/filename 动态生成，不能把 `0.1.0` 写死到通用 CI。`release-evidence.json` 固定包含 `schemaVersion`、`version`、`commit`、`tarball`、`sha256` 和排序后的 `files`。`release-evidence.mjs verify` 接收 evidence、tarball、expected commit/version，任一不一致非零退出。单元测试覆盖 0.1.1 动态文件名、tarball 篡改、commit 不一致、version 不一致和清单不一致。

- [ ] **Step 2: 本地语法和命令核验**

Run:

```powershell
npm test
npm run test:package
node --test tests/release-evidence.test.mjs
git diff --check
```

Expected: 全部通过；workflow 无制表符和未解析占位符。

- [ ] **Step 3: 提交并推送验证分支**

```powershell
git add .github/workflows/ci.yml tooling/release-evidence.mjs tests/release-evidence.test.mjs
git commit -m "ci: test three operating systems"
git push
```

Expected: GitHub Actions 的 12 个跨平台组合任务全部成功，且 main 的 release-candidate 任务上传唯一候选 artifact。

---

### Task 5: 首次发布版本门禁

**Files:**
- Create: `tooling/verify-release.mjs`
- Create: `tests/release.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run verify:release -- --tag v0.1.0`

- [ ] **Step 1: 编写版本门禁失败测试**

```js
test("accepts a tag matching package version", async () => {
  const result = await verifyRelease({
    tag: "v0.1.0",
    packageJson: pkg,
    publishedVersions: []
  });
  assert.equal(result.version, "0.1.0");
});

test("rejects a mismatched tag", async () => {
  await assert.rejects(
    verifyRelease({
      tag: "v0.2.0",
      packageJson: pkg,
      publishedVersions: []
    }),
    /tag 与 package.json.version 不一致/
  );
});

test("rejects an already published version", async () => {
  await assert.rejects(
    verifyRelease({
      tag: "v0.1.0",
      packageJson: pkg,
      publishedVersions: ["0.1.0"]
    }),
    /版本已存在/
  );
});
```

- [ ] **Step 2: 实现纯版本校验和 CLI**

```js
export function verifyRelease({ tag, packageJson, publishedVersions }) {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(tag);
  if (!match || match[1] !== packageJson.version) {
    throw new Error("Release tag 与 package.json.version 不一致");
  }
  if (publishedVersions.includes(packageJson.version)) {
    throw new Error(`npm 版本已存在：${packageJson.version}`);
  }
  if (packageJson.private !== undefined) {
    throw new Error("package.json 仍包含 private");
  }
  if (packageJson.repository.url !==
      "https://github.com/jiangyz-bit/dev-governance-kit.git") {
    throw new Error("repository.url 不正确");
  }
  return { version: packageJson.version };
}
```

CLI 模式通过：

```powershell
npm view dev-governance-kit versions --json
```

获取已发布版本，包尚不存在时把 npm `E404` 转为空数组。

- [ ] **Step 3: 增加 scripts 并验证**

```json
{
  "scripts": {
    "verify:release": "node tooling/verify-release.mjs"
  }
}
```

Run:

```powershell
node --test tests/release.test.mjs
npm run verify:release -- --tag v0.1.0
```

Expected: 本地包尚未发布时通过；若已发布则明确失败。

- [ ] **Step 4: 提交**

```powershell
git add tooling/verify-release.mjs tests/release.test.mjs package.json package-lock.json
git commit -m "build: verify npm release versions"
```

---

### Task 6: 准备 MacBook M5 实机验收

**Files:**
- Create: `docs/MACOS_RELEASE_TEST.md`
- Modify: `README.md`

**Interfaces:**
- Documents a destructive-free temporary-directory test.
- Produces a fixed, reproducible pass/fail checklist for the release candidate.

- [ ] **Step 1: 编写实机测试文档**

`docs/MACOS_RELEASE_TEST.md` 必须包含：

fixture 创建脚本可以从 verified commit 的源码 checkout 运行，但 CLI 必须只从临时 consumer 中已安装的候选 tarball 执行；源码只负责生成无业务数据测试目录，不能参与 CLI 模块或运行时资源解析。

```bash
uname -m
node --version
npm --version

# 从 Task 7 记录的同一 GitHub Actions run 下载，禁止在 Mac 重新 npm pack。
gh run download "<run-id>" \
  --name "dev-governance-kit-0.1.0-<verified-commit>" \
  --dir "$HOME/dgk-release-candidate"
node tooling/release-evidence.mjs verify \
  --evidence "$HOME/dgk-release-candidate/release-evidence.json" \
  --tarball "$HOME/dgk-release-candidate/dev-governance-kit-0.1.0.tgz" \
  --commit "<verified-commit>" \
  --version 0.1.0

TEST_ROOT="$(mktemp -d)"
node tooling/create-smoke-project.mjs "$TEST_ROOT"

# 在全新 consumer 项目安装上述已验证 tarball。
CONSUMER_ROOT="$(mktemp -d)"
cd "$CONSUMER_ROOT"
npm init --yes
npm install --no-audit --no-fund "$HOME/dgk-release-candidate/dev-governance-kit-0.1.0.tgz"
npx --no-install dev-governance-kit init --workspace "$TEST_ROOT" --dry-run --json
```

然后使用仓库提供的标准 fixture 创建脚本准备受支持项目，执行：

```bash
npx --no-install dev-governance-kit init --workspace "$TEST_ROOT" --yes --json
npx --no-install dev-governance-kit validate --workspace "$TEST_ROOT" --json
```

记录：

- `uname -m` 为 Apple Silicon 架构。
- 默认小白交互和取消。
- 中文、空格路径。
- symlink 越界拒绝。
- 第二次 init 幂等。
- 测试目录清理。

- [ ] **Step 2: README 增加发布状态边界**

README 只说明 macOS 受支持，不声称 MacBook M5 已验证，直到实机步骤完成。完成后可以增加：

```text
发布候选版本已在 Apple Silicon MacBook 上完成 tarball 实机验收。
```

- [ ] **Step 3: 固化实机验收交接边界**

本任务只固化文档和脚本，不提前重新打包或执行实机验收。实机执行必须等待 Task 7 生成并记录唯一发布候选 tarball 后进行；由主智能体连接 Mac 环境执行，或由用户运行固定命令并回传完整 stdout、stderr 和退出码。

Expected:

- dry-run 工作区快照不变。
- init 返回 `status: "applied"`。
- validate 返回有效。
- 第二次 init 无创建和更新。
- symlink 越界返回非零且工作区不变。

- [ ] **Step 4: 提交验收文档**

```bash
git add docs/MACOS_RELEASE_TEST.md README.md
git commit -m "docs: add Apple Silicon release verification"
```

---

### Task 7: 发布候选版总门禁

**Files:**
- No source changes unless verification exposes a scoped defect.

**Interfaces:**
- Produces a publishable local `.tgz`.

- [ ] **Step 1: 干净安装**

Run:

```powershell
npm ci
```

Expected: exit 0。

- [ ] **Step 2: 完整测试**

Run:

```powershell
npm test
npm run test:package
npm audit --omit=dev
```

Expected: 全部 exit 0，0 个生产依赖漏洞。

- [ ] **Step 3: 检查包内容**

Run:

```powershell
npm pack --dry-run --json
npm publish --dry-run --access public
```

Expected:

- 包名和版本为 `dev-governance-kit@0.1.0`。
- 不包含 `tests/`、`docs/superpowers/`。
- 包含所有 runtime 目录、README 和 LICENSE。

- [ ] **Step 4: 检查 Git 和 CI**

Run:

```powershell
git fetch --prune origin
$dirty = git status --porcelain
if ($dirty) { throw "Worktree is not clean" }
$head = git rev-parse HEAD
$remote = git rev-parse origin/main
if ($head -ne $remote) { throw "HEAD is not origin/main" }
$run = gh run list --workflow CI --branch main --commit $head --status success --limit 1 --json databaseId,headSha,conclusion | ConvertFrom-Json
if (-not $run -or $run[0].headSha -ne $head -or $run[0].conclusion -ne "success") {
  throw "No successful CI run for HEAD"
}
```

Expected: 工作树干净，`HEAD == origin/main`，且查询到 `headSha` 精确等于 HEAD 的成功 CI。

- [ ] **Step 5: 下载 CI 生成的唯一发布候选**

Run:

```powershell
New-Item -ItemType Directory -Force .release | Out-Null
$head = git rev-parse HEAD
$run = gh run list --workflow CI --branch main --commit $head --status success --limit 1 --json databaseId,headSha,conclusion | ConvertFrom-Json
gh run download $run[0].databaseId --name "dev-governance-kit-0.1.0-$head" --dir .release
node tooling/release-evidence.mjs verify `
  --evidence .release/release-evidence.json `
  --tarball .release/dev-governance-kit-0.1.0.tgz `
  --commit $head `
  --version 0.1.0
$evidence = Get-Content .release/release-evidence.json -Encoding UTF8 -Raw | ConvertFrom-Json
if ($evidence.commit -ne (git rev-parse origin/main)) { throw "Evidence is not origin/main" }
```

Expected: `.release/dev-governance-kit-0.1.0.tgz` 与 `release-evidence.json` 同时存在且校验通过。唯一候选来源是成功 main CI 的 artifact；Windows 和 Mac 均禁止重新运行 `npm pack` 替换它。

- [ ] **Step 6: 使用同一候选包完成 MacBook M5 验收**

在 MacBook M5 使用 `gh run download <同一 run id> --name dev-governance-kit-0.1.0-<evidence.commit>` 下载同一 artifact，先运行 `release-evidence.mjs verify`，再执行 `docs/MACOS_RELEASE_TEST.md`。记录 artifact 名称、run id、commit、下载 SHA-256、完整命令、stdout、stderr 和退出码。严禁在 Mac 重新打包。Expected:

- dry-run 工作区快照不变。
- init 返回 `status: "applied"`。
- validate 返回有效。
- 第二次 init 无创建和更新。
- symlink 越界返回非零且工作区不变。
- Mac 上计算出的 tarball SHA-256 与 Windows/CI 记录值一致。

- [ ] **Step 7: 等待首次发布授权条件**

发布前必须由用户完成或确认：

```powershell
npm login
npm whoami
```

Expected: `npm whoami` 精确输出 `coogle`，并确认 npm 账号已启用 2FA。

不得在未满足上述条件时执行真实 `npm publish` 或创建 GitHub Release。

---

## First Publish Completion Gate

满足用户登录和明确发布授权后执行：

```powershell
$evidence = Get-Content .release/release-evidence.json -Encoding UTF8 -Raw | ConvertFrom-Json
$dirty = git status --porcelain
if ($dirty) { throw "Worktree is not clean" }
git fetch --prune origin
if ((git rev-parse HEAD) -ne $evidence.commit) { throw "HEAD differs from candidate" }
if ((git rev-parse origin/main) -ne $evidence.commit) { throw "origin/main differs from candidate" }
node tooling/release-evidence.mjs verify --evidence .release/release-evidence.json --tarball .release/dev-governance-kit-0.1.0.tgz --commit $evidence.commit --version 0.1.0
npm publish .release/dev-governance-kit-0.1.0.tgz --access public
npm view dev-governance-kit@0.1.0 version repository maintainers
npx --yes dev-governance-kit@0.1.0 --help
$registryProject = Join-Path $env:TEMP ("dgk-registry-npx-" + [guid]::NewGuid())
node tooling/create-smoke-project.mjs $registryProject
npx --yes dev-governance-kit@0.1.0 init --workspace $registryProject --yes --json
npx --yes dev-governance-kit@0.1.0 validate --workspace $registryProject --json
npx --yes dev-governance-kit@0.1.0 init --workspace $registryProject --yes --json
```

发布后从 registry 下载并进行字节级核对：

```powershell
$url = npm view dev-governance-kit@0.1.0 dist.tarball
Invoke-WebRequest -Uri $url -OutFile .release/registry-dev-governance-kit-0.1.0.tgz
$registryHash = (Get-FileHash -Algorithm SHA256 .release/registry-dev-governance-kit-0.1.0.tgz).Hash.ToLowerInvariant()
if ($registryHash -ne $evidence.sha256) { throw "Registry tarball differs from candidate" }
node tooling/package-smoke.mjs `
  --tarball .release/registry-dev-governance-kit-0.1.0.tgz `
  --source registry > .release/registry-verification.json
```

真实 `npx` 三次输出必须依次为 applied、valid、第二次 created/updated 均为 0；registry tarball consumer 烟测必须复用 Task 3 的完整断言。把 registry URL、hash、真实 npx 输出/退出码和 `registry-verification.json` 作为发布记录追加项，不覆盖 CI 生成的原始 evidence。

GitHub Release 必须显式绑定已经通过 CI 与 Mac 实机验收的提交：

```powershell
$verifiedSha = $evidence.commit
gh release create v0.1.0 --target $verifiedSha --title "v0.1.0" --generate-notes `
  .release/release-evidence.json `
  .release/dev-governance-kit-0.1.0.tgz
$tagSha = git rev-list -n 1 v0.1.0
if ($tagSha -ne $verifiedSha) { throw "Release tag does not point to verified commit" }
```

记录 `verifiedSha`、候选 tarball SHA-256、npm 版本和 GitHub tag SHA，四者必须对应同一次发布。

首次发布和 `v0.1.0` GitHub Release 完成时，仓库中还不能存在会自动发布同一版本的 `publish.yml`，避免首次人工发布后被 Release 事件重复触发。

---

### Task 8: 首发后启用 Trusted Publishing

**Files:**
- Create: `.github/workflows/publish.yml`

**Interfaces:**
- Workflow trigger: future GitHub Release `published`
- Publishes: versions after `0.1.0`

- [ ] **Step 1: 创建发布工作流**

```yaml
name: Publish npm

on:
  release:
    types: [published]

permissions:
  contents: read
  id-token: write

concurrency:
  group: npm-${{ github.event.release.tag_name }}
  cancel-in-progress: false

jobs:
  publish:
    runs-on: ubuntu-latest
    environment: npm-production
    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ github.event.release.tag_name }}
          fetch-depth: 0
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
          package-manager-cache: false
      - run: npm install --global npm@^11.5.1
      - name: Verify release tag and npm version
        shell: bash
        run: |
          test "$(git rev-parse HEAD)" = "$(git rev-list -n 1 "${{ github.event.release.tag_name }}")"
          node -e 'const v=require("node:child_process").execFileSync("npm",["--version"],{encoding:"utf8"}).trim(); const [a,b,c]=v.split(".").map(Number); if (a<11 || (a===11 && b<5) || (a===11 && b===5 && c<1)) process.exit(1)'
      - run: npm ci
      - run: npm test
      - run: npm run test:package
      - run: npm run verify:release -- --tag "${{ github.event.release.tag_name }}"
      - run: npm publish
```

- [ ] **Step 2: 提交工作流**

```powershell
git add .github/workflows/publish.yml
git commit -m "ci: publish npm releases with OIDC"
git push
```

- [ ] **Step 3: 配置可信发布者**

在 npm 包设置中绑定：

- GitHub owner：`jiangyz-bit`
- Repository：`dev-governance-kit`
- Workflow：`publish.yml`
- Environment：`npm-production`
- Allowed action：`npm publish`

- [ ] **Step 4: 用下一个补丁版本验证**

下一个版本按 `0.1.1` 或实际 SemVer 版本发布 GitHub Release，验证 OIDC、版本门禁和 concurrency。发布后运行 npm 官方 provenance 查询/验证命令，保存 package version、registry integrity、provenance 中的 GitHub repository/workflow/commit 与 Actions run URL；这些值必须和 Release tag commit 一致。验证成功后启用 “Require 2FA and disallow tokens”，撤销不再使用的发布 token。重复触发同一 tag 时，registry 的版本已存在拒绝属于预期安全失败，日志必须明确标注而不是再次发布。
