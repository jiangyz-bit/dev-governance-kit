# MacBook M5 发布候选版实机验收

当前状态：dev-governance-kit 支持 macOS，但 `0.1.0` 的 MacBook M5 同一
artifact 实机验收尚未完成。本文是发布前验收手册，不是“已经通过”的证明。

这次验收只使用 GitHub Actions 生成的唯一候选包。禁止在 Mac 上重新执行
`npm pack`，否则测到的不是准备发布的那个文件。任何一项失败，都不得发布。

## 开始前需要什么

请先从发布候选版总门禁记录中取得以下四项，逐字复制，不要自己猜：

| 记录项 | 含义 |
|---|---|
| `RUN_ID` | 生成候选包的 GitHub Actions 运行编号 |
| `VERIFIED_COMMIT` | 已验证的 40 位小写 commit SHA |
| `ARTIFACT_NAME` | `dev-governance-kit-<版本>-<完整 commit>` |
| `TARBALL_SHA` | 候选 `.tgz` 的 64 位小写 SHA-256 |

Mac 需要能访问 GitHub，并已安装 `gh`、`git`、Node.js 和 npm。`gh auth status`
必须显示已经登录且可以读取 `jiangyz-bit/dev-governance-kit`。

## 一次执行的安全脚本

下面脚本只会创建本次专用的临时目录。退出时的清理函数会先核对非空路径和
固定前缀，只删除本次 `mktemp` 返回的目录；验收证据保留在用户主目录。

先复制整个代码块到一个新文件，例如 `~/dgk-m5-check.sh`。只填写最上面的
四个值，然后在普通 macOS Terminal 中执行 `bash ~/dgk-m5-check.sh`。
不要使用 `sudo`。脚本中有两个明确的终端操作提示：第一次输入 `N`，第二次
无需手工计时，脚本会向真实子进程发送 `SIGINT`。

```bash
#!/usr/bin/env bash
set -euo pipefail

# 必填：从同一次发布候选版总门禁记录复制。
RUN_ID=""
VERIFIED_COMMIT=""
ARTIFACT_NAME=""
TARBALL_SHA=""

VERSION="0.1.0"
REPOSITORY="jiangyz-bit/dev-governance-kit"
TMP_BASE="${TMPDIR:-/tmp}"
TMP_BASE="${TMP_BASE%/}"
[[ -n "$TMP_BASE" ]] || TMP_BASE="/"
TMP_PREFIX="${TMP_BASE%/}/dgk-m5"
SESSION_ROOT=""
ARTIFACT_ROOT=""

fail() {
  printf '失败：%s\n' "$*" >&2
  exit 1
}

cleanup() {
  local target
  for target in "$SESSION_ROOT" "$ARTIFACT_ROOT"; do
    if [[ -n "$target" && "$target" == "$TMP_PREFIX"-*.?????? ]]; then
      rm -rf -- "$target"
    elif [[ -n "$target" ]]; then
      printf '安全提醒：未删除不符合本次临时目录规则的路径：%s\n' "$target" >&2
    fi
  done
}
trap cleanup EXIT

for tool in gh node npm git shasum; do
  command -v "$tool" >/dev/null 2>&1 || fail "缺少命令：$tool"
done

[[ "$RUN_ID" =~ ^[0-9]+$ ]] || fail "RUN_ID 必须是纯数字"
[[ "$VERIFIED_COMMIT" =~ ^[0-9a-f]{40}$ ]] \
  || fail "VERIFIED_COMMIT 必须是 40 位小写 SHA"
[[ "$TARBALL_SHA" =~ ^[0-9a-f]{64}$ ]] \
  || fail "TARBALL_SHA 必须是 64 位小写 SHA-256"
EXPECTED_ARTIFACT="dev-governance-kit-${VERSION}-${VERIFIED_COMMIT}"
[[ "$ARTIFACT_NAME" == "$EXPECTED_ARTIFACT" ]] \
  || fail "ARTIFACT_NAME 与版本、commit 不一致"

ARCH="$(uname -m)"
[[ "$ARCH" == "arm64" ]] || fail "本验收要求 uname -m 为 arm64，实际为 $ARCH"
node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 3)) process.exit(1);
' || fail "Node.js 必须为 20.3 或更高版本"

gh auth status >/dev/null 2>&1 || fail "gh 尚未登录"
printf '架构：%s\nNode.js：%s\nnpm：%s\nGit：%s\n' \
  "$ARCH" "$(node --version)" "$(npm --version)" "$(git --version)"

SESSION_ROOT="$(mktemp -d "$TMP_PREFIX-session.XXXXXX")"
ARTIFACT_ROOT="$(mktemp -d "$TMP_PREFIX-artifact.XXXXXX")"
EVIDENCE_ROOT="$HOME/dgk-m5-evidence-${RUN_ID}-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$EVIDENCE_ROOT"
printf '%s\n' "$RUN_ID" > "$EVIDENCE_ROOT/RUN_ID.txt"
printf '%s\n' "$VERIFIED_COMMIT" > "$EVIDENCE_ROOT/VERIFIED_COMMIT.txt"
printf '%s\n' "$ARTIFACT_NAME" > "$EVIDENCE_ROOT/ARTIFACT_NAME.txt"
printf '%s\n' "$TARBALL_SHA" > "$EVIDENCE_ROOT/TARBALL_SHA.txt"

run_record() {
  local label="$1"
  shift
  local stdout_file="$EVIDENCE_ROOT/${label}.stdout"
  local stderr_file="$EVIDENCE_ROOT/${label}.stderr"
  local exit_file="$EVIDENCE_ROOT/${label}.exit-code"
  local code
  if "$@" > >(tee "$stdout_file") 2> >(tee "$stderr_file" >&2); then
    code=0
  else
    code=$?
  fi
  wait || true
  printf '%s\n' "$code" > "$exit_file"
  return "$code"
}

run_ok() {
  local label="$1"
  shift
  run_record "$label" "$@" || fail "$label 失败，见 $EVIDENCE_ROOT"
}

run_expect_nonzero() {
  local label="$1"
  shift
  local code
  if run_record "$label" "$@"; then
    fail "$label 本应拒绝操作，却返回成功"
  else
    code=$?
  fi
  [[ "$code" -ne 0 ]] || fail "$label 没有返回非零退出码"
}

run_ok run-view gh run view "$RUN_ID" \
  --repo "$REPOSITORY" \
  --json headSha,conclusion
run_ok run-binding node -e '
  const fs = require("fs");
  const [file, commit] = process.argv.slice(1);
  const run = JSON.parse(fs.readFileSync(file, "utf8"));
  if (run.headSha !== commit || run.conclusion !== "success") process.exit(1);
' "$EVIDENCE_ROOT/run-view.stdout" "$VERIFIED_COMMIT"

run_ok artifact-download gh run download "$RUN_ID" \
  --repo "$REPOSITORY" \
  --name "$ARTIFACT_NAME" \
  --dir "$ARTIFACT_ROOT"

TARBALL="$ARTIFACT_ROOT/dev-governance-kit-${VERSION}.tgz"
EVIDENCE="$ARTIFACT_ROOT/release-evidence.json"
[[ -f "$TARBALL" && ! -L "$TARBALL" ]] || fail "artifact 缺少普通 tgz 文件"
[[ -f "$EVIDENCE" && ! -L "$EVIDENCE" ]] || fail "artifact 缺少普通 evidence 文件"

run_ok tarball-sha shasum -a 256 "$TARBALL"
ACTUAL_SHA="$(awk '{print $1}' "$EVIDENCE_ROOT/tarball-sha.stdout")"
[[ "$ACTUAL_SHA" == "$TARBALL_SHA" ]] \
  || fail "候选包 SHA-256 与总门禁记录不一致"
printf '%s\n' "$ACTUAL_SHA" > "$EVIDENCE_ROOT/ACTUAL_TARBALL_SHA.txt"

# 源码 checkout 只提供 evidence 校验器和无业务数据 fixture 创建器。
SOURCE_ROOT="$SESSION_ROOT/source"
run_ok source-clone git clone --quiet --no-checkout \
  "https://github.com/${REPOSITORY}.git" "$SOURCE_ROOT"
run_ok source-checkout git -C "$SOURCE_ROOT" checkout \
  --quiet --detach "$VERIFIED_COMMIT"
run_ok source-commit git -C "$SOURCE_ROOT" rev-parse HEAD
[[ "$(tr -d '\r\n' < "$EVIDENCE_ROOT/source-commit.stdout")" == "$VERIFIED_COMMIT" ]] \
  || fail "源码 checkout 与 VERIFIED_COMMIT 不一致"
REPO_ROOT="$(cd "$SOURCE_ROOT" && pwd -P)"

run_ok evidence-verify node "$REPO_ROOT/tooling/release-evidence.mjs" verify \
  --evidence "$EVIDENCE" \
  --tarball "$TARBALL" \
  --expected-commit "$VERIFIED_COMMIT" \
  --expected-version "$VERSION"

# 此后所有 dev-governance-kit CLI/runtime 都来自 consumer 安装的同一 tgz。
CONSUMER_ROOT="$SESSION_ROOT/consumer"
mkdir -p "$CONSUMER_ROOT"
cd "$CONSUMER_ROOT"
run_ok npm-init npm init --yes
run_ok npm-install npm install \
  --ignore-scripts \
  --no-audit \
  --no-fund \
  "$TARBALL"
cd "$CONSUMER_ROOT"

run_ok help-long npx --no-install dev-governance-kit --help
run_ok help-short npx --no-install governance-kit --help

SNAPSHOT_SCRIPT="$SESSION_ROOT/snapshot.mjs"
cat > "$SNAPSHOT_SCRIPT" <<'SNAPSHOT'
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2]);
const rows = [];
async function visit(target, relative = ".") {
  const info = await lstat(target);
  const mode = info.mode.toString(8);
  if (info.isSymbolicLink()) {
    rows.push({ path: relative, type: "link", mode, target: await readlink(target) });
    return;
  }
  if (info.isDirectory()) {
    rows.push({ path: relative, type: "directory", mode });
    for (const name of (await readdir(target)).sort()) {
      await visit(path.join(target, name), relative === "." ? name : `${relative}/${name}`);
    }
    return;
  }
  if (info.isFile()) {
    const content = await readFile(target);
    rows.push({
      path: relative,
      type: "file",
      mode,
      size: content.length,
      sha256: createHash("sha256").update(content).digest("hex")
    });
    return;
  }
  rows.push({ path: relative, type: "other", mode });
}
await visit(root);
process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
SNAPSHOT

snapshot() {
  node "$SNAPSHOT_SCRIPT" "$1" > "$2"
}

assert_same_snapshot() {
  cmp -s "$1" "$2" || fail "工作区或外部目录发生了意外变化"
}

TEST_ROOT="$SESSION_ROOT/验收 空间/用户 项目"
run_ok fixture-main node "$REPO_ROOT/tooling/create-smoke-project.mjs" "$TEST_ROOT"

snapshot "$TEST_ROOT" "$EVIDENCE_ROOT/before-interactive.snapshot.json"
printf '\n现在进入默认小白交互。看到“是否继续”时输入 N，再按回车。\n'
run_ok interactive-cancel npx --no-install dev-governance-kit init \
  --workspace "$TEST_ROOT"
snapshot "$TEST_ROOT" "$EVIDENCE_ROOT/after-interactive.snapshot.json"
assert_same_snapshot \
  "$EVIDENCE_ROOT/before-interactive.snapshot.json" \
  "$EVIDENCE_ROOT/after-interactive.snapshot.json"

snapshot "$TEST_ROOT" "$EVIDENCE_ROOT/before-dry-run.snapshot.json"
run_ok init-dry-run npx --no-install dev-governance-kit init \
  --workspace "$TEST_ROOT" --dry-run --json
snapshot "$TEST_ROOT" "$EVIDENCE_ROOT/after-dry-run.snapshot.json"
assert_same_snapshot \
  "$EVIDENCE_ROOT/before-dry-run.snapshot.json" \
  "$EVIDENCE_ROOT/after-dry-run.snapshot.json"

run_ok init-apply npx --no-install dev-governance-kit init \
  --workspace "$TEST_ROOT" --yes --json --verbose
run_ok init-assert node -e '
  const fs = require("fs");
  const path = require("path");
  const [file, consumer] = process.argv.slice(1);
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  const expected = path.resolve(consumer, "node_modules/dev-governance-kit");
  if (value.status !== "applied" || value.valid !== true) process.exit(1);
  if (path.resolve(value.runtime?.packageRoot ?? "") !== expected) process.exit(1);
' "$EVIDENCE_ROOT/init-apply.stdout" "$CONSUMER_ROOT"

run_ok validate npx --no-install dev-governance-kit validate \
  --workspace "$TEST_ROOT" --json
run_ok validate-assert node -e '
  const fs = require("fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (
    value.command !== "validate"
    || value.ok !== true
    || value.report?.valid !== true
  ) process.exit(1);
' "$EVIDENCE_ROOT/validate.stdout"

run_ok init-second npx --no-install dev-governance-kit init \
  --workspace "$TEST_ROOT" --yes --json
run_ok init-second-assert node -e '
  const fs = require("fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.status !== "applied") process.exit(1);
  if (value.report?.created?.length !== 0 || value.report?.updated?.length !== 0) {
    process.exit(1);
  }
' "$EVIDENCE_ROOT/init-second.stdout"

# 真实 child 收到 SIGINT，必须退出 130，且工作区完整快照不变。
SIGINT_ROOT="$SESSION_ROOT/SIGINT 用户 项目"
run_ok fixture-sigint node "$REPO_ROOT/tooling/create-smoke-project.mjs" "$SIGINT_ROOT"
snapshot "$SIGINT_ROOT" "$EVIDENCE_ROOT/before-sigint.snapshot.json"
SIGINT_HARNESS="$SESSION_ROOT/sigint-child.mjs"
cat > "$SIGINT_HARNESS" <<'SIGINT'
import { spawn } from "node:child_process";
import path from "node:path";

const [cliPath, workspace] = process.argv.slice(2);
const source = `
  import { pathToFileURL } from "node:url";
  const cli = await import(pathToFileURL(process.argv[1]));
  const code = await cli.main(["init", "--workspace", process.argv[2]], {
    input: { isTTY: true },
    output: process.stdout,
    error: process.stderr
  }, {
    createPromptSession({ signal }) {
      return {
        signal,
        async confirm() {
          process.stdout.write("__READY__\\n");
          await new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            }, { once: true });
          });
        },
        close() {}
      };
    }
  });
  process.exitCode = code;
`;
const child = spawn(process.execPath, [
  "--input-type=module", "--eval", source, path.resolve(cliPath), workspace
]);
let sent = false;
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  if (!sent && chunk.toString().includes("__READY__")) {
    sent = true;
    child.kill("SIGINT");
  }
});
child.stderr.pipe(process.stderr);
child.on("close", (code) => process.exit(code ?? 1));
SIGINT
CLI_PATH="$CONSUMER_ROOT/node_modules/dev-governance-kit/tooling/cli.mjs"
if run_record sigint-child node "$SIGINT_HARNESS" "$CLI_PATH" "$SIGINT_ROOT"; then
  SIGINT_CODE=0
else
  SIGINT_CODE=$?
fi
[[ "$SIGINT_CODE" -eq 130 ]] || fail "真实 child SIGINT 退出码不是 130"
snapshot "$SIGINT_ROOT" "$EVIDENCE_ROOT/after-sigint.snapshot.json"
assert_same_snapshot \
  "$EVIDENCE_ROOT/before-sigint.snapshot.json" \
  "$EVIDENCE_ROOT/after-sigint.snapshot.json"

# 三种真实 macOS symlink 越界都用独立 fixture，不能 skip。
OUTSIDE_ROOT="$SESSION_ROOT/outside"
mkdir -p "$OUTSIDE_ROOT"
printf '外部内容不得改变\n' > "$OUTSIDE_ROOT/keep.txt"

DIR_LINK_ROOT="$SESSION_ROOT/目录 symlink"
ln -s "$OUTSIDE_ROOT" "$DIR_LINK_ROOT"
snapshot "$DIR_LINK_ROOT" "$EVIDENCE_ROOT/before-dir-link.snapshot.json"
snapshot "$OUTSIDE_ROOT" "$EVIDENCE_ROOT/before-dir-link-outside.snapshot.json"
run_expect_nonzero dir-symlink npx --no-install dev-governance-kit init \
  --workspace "$DIR_LINK_ROOT" --yes --json
snapshot "$DIR_LINK_ROOT" "$EVIDENCE_ROOT/after-dir-link.snapshot.json"
snapshot "$OUTSIDE_ROOT" "$EVIDENCE_ROOT/after-dir-link-outside.snapshot.json"
assert_same_snapshot \
  "$EVIDENCE_ROOT/before-dir-link.snapshot.json" \
  "$EVIDENCE_ROOT/after-dir-link.snapshot.json"
assert_same_snapshot \
  "$EVIDENCE_ROOT/before-dir-link-outside.snapshot.json" \
  "$EVIDENCE_ROOT/after-dir-link-outside.snapshot.json"

FILE_LINK_ROOT="$SESSION_ROOT/文件 symlink 项目"
run_ok fixture-file-link node \
  "$REPO_ROOT/tooling/create-smoke-project.mjs" "$FILE_LINK_ROOT"
ln -s "$OUTSIDE_ROOT/keep.txt" "$FILE_LINK_ROOT/AGENTS.md"
snapshot "$FILE_LINK_ROOT" "$EVIDENCE_ROOT/before-file-link.snapshot.json"
snapshot "$OUTSIDE_ROOT" "$EVIDENCE_ROOT/before-file-link-outside.snapshot.json"
run_expect_nonzero file-symlink npx --no-install dev-governance-kit init \
  --workspace "$FILE_LINK_ROOT" --yes --json
snapshot "$FILE_LINK_ROOT" "$EVIDENCE_ROOT/after-file-link.snapshot.json"
snapshot "$OUTSIDE_ROOT" "$EVIDENCE_ROOT/after-file-link-outside.snapshot.json"
assert_same_snapshot \
  "$EVIDENCE_ROOT/before-file-link.snapshot.json" \
  "$EVIDENCE_ROOT/after-file-link.snapshot.json"
assert_same_snapshot \
  "$EVIDENCE_ROOT/before-file-link-outside.snapshot.json" \
  "$EVIDENCE_ROOT/after-file-link-outside.snapshot.json"

MANIFEST_LINK_ROOT="$SESSION_ROOT/Manifest symlink 项目"
run_ok fixture-manifest-link node \
  "$REPO_ROOT/tooling/create-smoke-project.mjs" "$MANIFEST_LINK_ROOT"
printf 'version: 1\n' > "$OUTSIDE_ROOT/governance-kit.yaml"
ln -s "$OUTSIDE_ROOT/governance-kit.yaml" \
  "$MANIFEST_LINK_ROOT/governance-kit.yaml"
snapshot "$MANIFEST_LINK_ROOT" "$EVIDENCE_ROOT/before-manifest-link.snapshot.json"
snapshot "$OUTSIDE_ROOT" "$EVIDENCE_ROOT/before-manifest-link-outside.snapshot.json"
run_expect_nonzero manifest-symlink npx --no-install dev-governance-kit init \
  --workspace "$MANIFEST_LINK_ROOT" --yes --json
snapshot "$MANIFEST_LINK_ROOT" "$EVIDENCE_ROOT/after-manifest-link.snapshot.json"
snapshot "$OUTSIDE_ROOT" "$EVIDENCE_ROOT/after-manifest-link-outside.snapshot.json"
assert_same_snapshot \
  "$EVIDENCE_ROOT/before-manifest-link.snapshot.json" \
  "$EVIDENCE_ROOT/after-manifest-link.snapshot.json"
assert_same_snapshot \
  "$EVIDENCE_ROOT/before-manifest-link-outside.snapshot.json" \
  "$EVIDENCE_ROOT/after-manifest-link-outside.snapshot.json"

printf '通过：MacBook M5 同一 artifact 实机验收完成。\n'
printf '证据目录（不会自动删除）：%s\n' "$EVIDENCE_ROOT"
```

## 怎么判断通过

脚本只有在以下项目全部满足时才打印“通过”：

- `uname -m` 是 `arm64`，Node.js 不低于 20.3。
- `RUN_ID` 成功且绑定 `VERIFIED_COMMIT`，下载的 `ARTIFACT_NAME` 完全一致。
- `TARBALL_SHA`、`release-evidence.json`、tarball 清单、commit 和版本全部吻合。
- 两个 bin 的 `--help` 都能从临时 consumer 中运行。
- 默认小白交互输入 `N` 后显示取消，完整快照和 hash 零修改。
- dry-run 前后完整快照和 hash 不变。
- 正式 init 的 `status` 为 `applied`、`valid` 为 `true`，且
  `runtime.packageRoot` 是 consumer 中的安装根。
- validate 的状态为 `valid`。
- 第二次 init 的 `created` 和 `updated` 都是 `0`。
- 真实 child 收到 `SIGINT` 后退出码为 `130`，工作区不变。
- 目录 symlink、文件 symlink、Manifest symlink 三种越界都被非零退出拒绝，
  对应 workspace 和 outside 的完整快照都不变。

每条验收命令分别保存 `.stdout`、`.stderr` 和 `.exit-code`；快照、四项人工
输入和实际 tarball SHA 也都在证据目录。请把整个证据目录交给发布负责人审查。

## 失败时怎么办

不要删除或手改候选包，也不要重新打包。保留终端输出和证据目录，记录失败步骤，
回到源码修复并让 GitHub Actions 生成新的 run、artifact、commit 和 SHA。
四项输入只要有一项改变，就必须从头执行本验收。

只有脚本打印“通过”、证据齐全且发布负责人复核后，README 才能改为“MacBook M5
实机验收已通过”。在那之前，状态始终是“尚未完成实机验收”。
