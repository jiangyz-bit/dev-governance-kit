import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath ?? path.join(
  path.dirname(process.execPath),
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js"
);
const npmCommand = process.platform === "win32" ? process.execPath : "npm";
const npmPrefix = process.platform === "win32" ? [npmCli] : [];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      ...options
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("package exposes the governance CLI and supported Node version", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.type, "module");
  assert.equal(pkg.bin["governance-kit"], "./tooling/cli.mjs");
  assert.equal(pkg.engines.node, ">=20.3.0");
  assert.equal(pkg.scripts.test, "node --test tests/*.test.mjs");
});

test("package metadata is ready for the public npm registry", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.author, "coogle");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.repository.url, "https://github.com/jiangyz-bit/dev-governance-kit.git");
  assert.equal(pkg.homepage, "https://github.com/jiangyz-bit/dev-governance-kit#readme");
  assert.equal(pkg.bugs.url, "https://github.com/jiangyz-bit/dev-governance-kit/issues");
  assert.deepEqual(pkg.publishConfig, {
    access: "public",
    registry: "https://registry.npmjs.org/"
  });
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

test("package exports only the public initialization entry point", async () => {
  const api = await import("../tooling/index.mjs");
  assert.equal(typeof api.initializeGovernance, "function");
  assert.equal("planInitialization" in api, false);
  assert.equal("executeInitialization" in api, false);
});

test("help advertises init but not the unimplemented create command", async () => {
  const source = await readFile(new URL("../tooling/cli.mjs", import.meta.url), "utf8");
  assert.match(source, /governance-kit init/);
  assert.doesNotMatch(source, /governance-kit create/);
});

test("npm package contains runtime files but excludes internal project material", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "governance-pack-list-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packed = await run(
    npmCommand,
    [
      ...npmPrefix,
      "pack",
      "--dry-run",
      "--json",
      "--pack-destination",
      root
    ],
    { cwd: kitRoot }
  );
  assert.equal(packed.code, 0, packed.stderr);
  const metadata = JSON.parse(packed.stdout);
  assert.equal(metadata.length, 1);
  const files = new Set(metadata[0].files.map((entry) => (
    entry.path.replaceAll("\\", "/")
  )));
  assert.equal(files.size, 64, "发布清单变化时必须显式审查");

  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    "tooling/cli.mjs",
    "tooling/index.mjs",
    "tooling/lib/init.mjs",
    "core/rules/agent-workflow.md",
    "schemas/governance-kit.schema.json",
    "templates/server/AGENTS.md",
    "profiles/java-springboot-mybatis/profile.yaml",
    "blueprints/java-react-wechat.yaml",
    "docs/MANIFEST_REFERENCE.md"
  ]) {
    assert.ok(files.has(required), `安装包缺少运行文件：${required}`);
  }

  for (const leaked of files) {
    assert.equal(/^tests\//.test(leaked), false, `不应发布测试：${leaked}`);
    assert.equal(
      /^docs\/superpowers\//.test(leaked),
      false,
      `不应发布内部设计资料：${leaked}`
    );
    assert.equal(
      leaked === "docs/MIGRATION_FROM_V1_TEMPLATES.md",
      false,
      `不应发布废弃迁移资料：${leaked}`
    );
    assert.equal(
      /^\.superpowers\//.test(leaked),
      false,
      `不应发布工作树 scratch：${leaked}`
    );
  }
});

test("packed CLI runs after a clean local install", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "governance-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packed = await run(
    npmCommand,
    [...npmPrefix, "pack", "--pack-destination", root, "--silent"],
    { cwd: kitRoot }
  );
  assert.equal(packed.code, 0, packed.stderr);
  const archive = (await readdir(root)).find((entry) => entry.endsWith(".tgz"));
  assert.ok(archive, "npm pack 应生成安装包");
  const installed = await run(
    npmCommand,
    [
      ...npmPrefix,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      path.join(root, archive)
    ],
    { cwd: root }
  );
  assert.equal(installed.code, 0, installed.stderr);

  const installedPackage = path.join(
    root,
    "node_modules",
    "dev-governance-kit"
  );
  const installedManifest = JSON.parse(await readFile(
    path.join(installedPackage, "package.json"),
    "utf8"
  ));
  const help = await run(process.execPath, [
    path.join(installedPackage, installedManifest.bin["governance-kit"]),
    "--help"
  ], {
    cwd: root
  });
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /governance-kit init/);
  for (const bin of ["dev-governance-kit", "governance-kit"]) {
    assert.equal(installedManifest.bin[bin], "./tooling/cli.mjs");
    const smoke = await run(npmCommand, [
      ...npmPrefix,
      "exec",
      "--no",
      "--",
      bin,
      "--help"
    ], { cwd: root });
    assert.equal(smoke.code, 0, smoke.stderr);
    assert.match(smoke.stdout, /governance-kit init/);
  }
});

test("README explains npm init for novice users", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /npx dev-governance-kit init/);
  assert.match(readme, /给已有项目接入工程治理/);
  assert.match(readme, /create.*尚未实现/s);
  assert.match(readme, /不会修改你的业务代码/);
  assert.match(readme, /Windows/);
  assert.match(readme, /macOS/);
  assert.match(readme, /Linux/);
  assert.match(readme, /npx --yes dev-governance-kit@0\.1\.0 init --yes --json/);
  assert.match(readme, /https:\/\/github\.com\/jiangyz-bit\/dev-governance-kit\/blob\/main\/docs\/MANIFEST_REFERENCE\.md/);
  assert.doesNotMatch(readme, /git clone.*3 分钟快速开始/s);
  assert.ok(readme.split(/\r?\n/).length <= 220, "README 应保持可快速浏览");
});

test("MacBook release guide preserves the verified-artifact safety boundary", async () => {
  const guide = await readFile(
    new URL("../docs/MACOS_RELEASE_TEST.md", import.meta.url),
    "utf8"
  );
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

  assert.match(guide, /RUN_ID/);
  assert.match(guide, /VERIFIED_COMMIT/);
  assert.match(guide, /ARTIFACT_NAME/);
  assert.match(guide, /TARBALL_SHA/);
  assert.match(guide, /set -euo pipefail/);
  assert.match(guide, /for tool in gh node npm git/);
  assert.match(guide, /uname -m.*arm64/s);
  assert.match(guide, /Node\.js.*20\.3/);
  assert.match(guide, /gh run download "\$RUN_ID"/);
  assert.match(guide, /release-evidence\.mjs" verify/);
  assert.match(guide, /--expected-commit "\$VERIFIED_COMMIT"/);
  assert.match(guide, /--expected-version "\$VERSION"/);
  assert.doesNotMatch(
    guide,
    /release-evidence\.mjs" verify[\s\S]*?--commit "\$VERIFIED_COMMIT"/
  );
  assert.doesNotMatch(
    guide,
    /release-evidence\.mjs" verify[\s\S]*?--version "\$VERSION"/
  );
  assert.ok(
    guide.indexOf("release-evidence.mjs\" verify")
      < guide.indexOf("npm install"),
    "必须先验证发布证据，再安装候选 tarball"
  );
  assert.doesNotMatch(guide, /^\s*npm pack\b/m);
  assert.match(guide, /REPO_ROOT=.*pwd/);
  assert.match(guide, /用户 项目/);
  assert.match(guide, /trap cleanup EXIT/);
  assert.match(guide, /dry-run[\s\S]*快照[\s\S]*不变/);
  assert.match(guide, /默认.*交互[\s\S]*输入 `N`[\s\S]*零修改/);
  assert.match(guide, /status.*applied/);
  assert.match(
    guide,
    /value\.command !== "validate"[\s\S]*value\.ok !== true[\s\S]*value\.report\?\.valid !== true/
  );
  assert.doesNotMatch(
    guide,
    /value\.status !== "valid" \|\| value\.valid !== true/
  );
  assert.match(guide, /created.*0[\s\S]*updated.*0/);
  assert.match(guide, /runtime\.packageRoot/);
  assert.match(guide, /SIGINT[\s\S]*130/);
  assert.match(guide, /目录 symlink/);
  assert.match(guide, /文件 symlink/);
  assert.match(guide, /Manifest symlink/);
  assert.match(guide, /stdout/);
  assert.match(guide, /stderr/);
  assert.match(guide, /退出码/);
  assert.match(guide, /任何一项失败[\s\S]*不得发布/);

  const absoluteGuideUrl =
    "https://github.com/jiangyz-bit/dev-governance-kit/blob/main/docs/MACOS_RELEASE_TEST.md";
  assert.match(readme, new RegExp(absoluteGuideUrl.replaceAll(".", "\\.")));
  assert.match(readme, /macOS 受支持/);
  assert.match(readme, /MacBook M5.*尚未完成实机验收/);
  assert.doesNotMatch(readme, /MacBook M5.*已通过/);
});
