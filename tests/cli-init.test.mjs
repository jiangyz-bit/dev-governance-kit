import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  executeInitialization,
  planInitialization
} from "../tooling/lib/init.mjs";
import {
  createDetectedWorkspace,
  createProjectWorkspace,
  createRealLink,
  changedWorkspacePaths,
  expectedWorkspaceChanges,
  manifestForLinkedServer,
  snapshotWorkspace as snapshotCompleteWorkspace
} from "./helpers/project-workspace.mjs";

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(kitRoot, "tooling", "cli.mjs");

async function createSupportedWorkspace(t, { assumption = true } = {}) {
  return createProjectWorkspace(t, {
    directories: [".git"],
    files: {
      "demo-server/pom.xml": [
        "<project><dependencies>",
        "<dependency><artifactId>spring-boot</artifactId></dependency>",
        "<dependency><artifactId>mybatis</artifactId></dependency>",
        assumption
          ? "<dependency><artifactId>flyway</artifactId></dependency>"
          : "",
        "</dependencies></project>"
      ].join("")
    }
  });
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: kitRoot,
      windowsHide: true
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

async function loadCliModule() {
  return import("../tooling/cli.mjs");
}

function memoryOutput() {
  let value = "";
  return {
    write(chunk) {
      value += chunk;
      return true;
    },
    value() {
      return value;
    }
  };
}

function assertSuccessfulWorkspaceChanges({
  before,
  after,
  workspace,
  result
}) {
  assert.deepEqual(
    [...result.written].map((target) => path.resolve(target)).sort(),
    [...result.plan.writableTargets].map((target) => path.resolve(target)).sort()
  );
  assert.deepEqual(
    changedWorkspacePaths(before, after),
    expectedWorkspaceChanges(before, workspace, result.written)
  );
}

test("init dry-run emits exactly one JSON document and writes nothing", async (t) => {
  const workspace = await createSupportedWorkspace(t);
  const before = await snapshotCompleteWorkspace(workspace);

  const result = await runCli([
    "init", "--workspace", workspace, "--dry-run", "--yes", "--json"
  ]);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).status, "planned");
  assert.equal(result.stdout.trim().split(/\n(?=\{)/).length, 1);
  assert.deepEqual(await snapshotCompleteWorkspace(workspace), before);
});

test("JSON and non-TTY execution never create a prompt session", async (t) => {
  const workspace = await createSupportedWorkspace(t, { assumption: false });
  const before = await snapshotCompleteWorkspace(workspace);
  const { runInitCommand } = await loadCliModule();
  let promptCalls = 0;
  const result = await runInitCommand({
    command: "init",
    workspace,
    dryRun: false,
    yes: true,
    verbose: false,
    json: true,
    reconfigure: false
  }, {
    input: { isTTY: false },
    output: memoryOutput(),
    signal: new AbortController().signal
  }, {
    createPromptSession() {
      promptCalls += 1;
      throw new Error("不应创建 prompt");
    }
  });

  assert.equal(result.status, "needs_input");
  assert.equal(promptCalls, 0);
  assert.deepEqual(
    await snapshotCompleteWorkspace(workspace),
    before
  );
});

test("non-TTY requires --yes, while --yes executes only a resolved plan", async (t) => {
  const workspace = await createSupportedWorkspace(t);
  const before = await snapshotCompleteWorkspace(workspace);
  const withoutYes = await runCli(["init", "--workspace", workspace, "--json"]);
  assert.equal(withoutYes.code, 1);
  assert.equal(withoutYes.stderr, "");
  assert.equal(JSON.parse(withoutYes.stdout).status, "needs_input");
  assert.deepEqual(await snapshotCompleteWorkspace(workspace), before);

  const withYes = await runCli([
    "init", "--workspace", workspace, "--yes", "--json"
  ]);
  assert.equal(withYes.code, 0, withYes.stderr);
  assert.equal(withYes.stderr, "");
  const applied = JSON.parse(withYes.stdout);
  assert.equal(applied.status, "applied");
  assertSuccessfulWorkspaceChanges({
    before,
    after: await snapshotCompleteWorkspace(workspace),
    workspace,
    result: applied
  });
});

test("plain non-TTY without --yes explains that confirmation is required", async (t) => {
  const workspace = await createSupportedWorkspace(t);
  const before = await snapshotCompleteWorkspace(workspace);
  const result = await runCli(["init", "--workspace", workspace]);

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /需要你确认/);
  assert.deepEqual(await snapshotCompleteWorkspace(workspace), before);
});

test("human dry-run with --yes shows the prepared result once and writes nothing", async (t) => {
  const workspace = await createSupportedWorkspace(t);
  const before = await snapshotCompleteWorkspace(workspace);
  const { main } = await loadCliModule();
  const output = memoryOutput();
  const error = memoryOutput();

  const code = await main([
    "init", "--workspace", workspace, "--dry-run", "--yes"
  ], {
    input: { isTTY: true },
    output,
    error
  });

  assert.equal(code, 0);
  assert.equal(error.value(), "");
  assert.equal(
    (output.value().match(/已完成检查，准备为这个项目添加开发治理基础/g) ?? []).length,
    1
  );
  assert.deepEqual(await snapshotCompleteWorkspace(workspace), before);
});

test("interactive cancellation exits zero and closes the prompt once", async (t) => {
  const workspace = await createSupportedWorkspace(t);
  const before = await snapshotCompleteWorkspace(workspace);
  const { main } = await loadCliModule();
  const output = memoryOutput();
  let closeCalls = 0;

  const code = await main(["init", "--workspace", workspace], {
    input: { isTTY: true },
    output,
    error: memoryOutput()
  }, {
    createPromptSession() {
      return {
        signal: new AbortController().signal,
        async confirm() { return false; },
        close() { closeCalls += 1; }
      };
    }
  });

  assert.equal(code, 0);
  assert.match(output.value(), /已经取消/);
  assert.equal(closeCalls, 1);
  assert.deepEqual(await snapshotCompleteWorkspace(workspace), before);
});

test("interactive answers are replanned before the final confirmation", async (t) => {
  const workspace = await createSupportedWorkspace(t, { assumption: false });
  const { main } = await loadCliModule();
  const output = memoryOutput();
  let confirmations = 0;
  let closeCalls = 0;

  const code = await main(["init", "--workspace", workspace], {
    input: { isTTY: true },
    output,
    error: memoryOutput()
  }, {
    createPromptSession({ signal }) {
      return {
        signal,
        async confirm(message) {
          confirmations += 1;
          output.write(`${message}\n`);
          return true;
        },
        close() { closeCalls += 1; }
      };
    }
  });

  assert.equal(code, 0);
  assert.equal(confirmations, 2);
  assert.equal(closeCalls, 1);
  assert.match(output.value(), /请复核下面的识别结果/);
  assert.match(output.value(), /已完成检查，准备为这个项目添加开发治理基础/);
  assert.match(output.value(), /项目治理配置已完成/);
});

test("prompt pages are capped across replanning", async () => {
  const { runInitCommand } = await loadCliModule();
  let planCalls = 0;
  let collectCalls = 0;
  let closeCalls = 0;
  const result = await runInitCommand({
    command: "init",
    workspace: process.cwd(),
    dryRun: false,
    yes: false,
    verbose: false,
    json: false,
    reconfigure: false
  }, {
    input: { isTTY: true },
    output: memoryOutput(),
    signal: new AbortController().signal
  }, {
    async planInitialization() {
      planCalls += 1;
      return {
        command: "init",
        workspace: process.cwd(),
        status: "needs_input",
        questions: [{ code: `Q${planCalls}` }]
      };
    },
    async collectInitAnswers({ promptSession }) {
      collectCalls += 1;
      await promptSession.choose({});
      await promptSession.confirm();
      return { status: "answered", answers: {}, pagesUsed: 2 };
    },
    createPromptSession() {
      return {
        signal: new AbortController().signal,
        async choose() { return "1"; },
        async confirm() { return true; },
        close() { closeCalls += 1; }
      };
    }
  });

  assert.equal(result.status, "needs_input");
  assert.equal(result.code, "PROMPT_PAGE_LIMIT");
  assert.equal(collectCalls, 2);
  assert.equal(closeCalls, 1);
});

test("an injected abort maps to interrupted and exit code 130", async (t) => {
  const workspace = await createSupportedWorkspace(t);
  const before = await snapshotCompleteWorkspace(workspace);
  const { exitCodeFor, runInitCommand } = await loadCliModule();
  const controller = new AbortController();
  controller.abort();

  const result = await runInitCommand({
    command: "init",
    workspace,
    dryRun: false,
    yes: true,
    verbose: false,
    json: false,
    reconfigure: false
  }, {
    input: { isTTY: true },
    output: memoryOutput(),
    signal: controller.signal
  });

  assert.equal(result.status, "interrupted");
  assert.equal(exitCodeFor(result), 130);
  assert.deepEqual(await snapshotCompleteWorkspace(workspace), before);
});

test("abort while the final prompt is pending exits 130 and closes once", async (t) => {
  const workspace = await createSupportedWorkspace(t);
  const before = await snapshotCompleteWorkspace(workspace);
  const { main } = await loadCliModule();
  const controller = new AbortController();
  const output = memoryOutput();
  const error = memoryOutput();
  let closeCalls = 0;
  let promptStartedResolve;
  const promptStarted = new Promise((resolve) => {
    promptStartedResolve = resolve;
  });

  const running = main(["init", "--workspace", workspace], {
    input: { isTTY: true },
    output,
    error,
    signal: controller.signal
  }, {
    createPromptSession({ signal }) {
      return {
        signal,
        async confirm() {
          promptStartedResolve();
          await new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => {
              const aborted = new Error("aborted");
              aborted.name = "AbortError";
              reject(aborted);
            }, { once: true });
          });
        },
        close() { closeCalls += 1; }
      };
    }
  });

  await promptStarted;
  controller.abort();
  const code = await running;

  assert.equal(code, 130);
  assert.equal(error.value(), "");
  assert.match(output.value(), /操作已中断/);
  assert.equal(closeCalls, 1);
  assert.deepEqual(await snapshotCompleteWorkspace(workspace), before);
});

test("fixed business statuses map to stable exit codes", async () => {
  const { exitCodeFor } = await loadCliModule();
  for (const status of ["planned", "cancelled", "applied"]) {
    assert.equal(exitCodeFor({ status }), 0);
  }
  for (const status of [
    "needs_input",
    "conflict",
    "failed_validation",
    "partial_failure",
    "unsupported"
  ]) {
    assert.equal(exitCodeFor({ status }), 1);
  }
  assert.equal(exitCodeFor({ status: "interrupted" }), 130);
});

test("a target changed after preview becomes conflict without overwrite", async (t) => {
  const workspace = await createSupportedWorkspace(t);
  const before = await snapshotCompleteWorkspace(workspace);
  const { runInitCommand } = await loadCliModule();
  let changedTarget;

  const result = await runInitCommand({
    command: "init",
    workspace,
    dryRun: false,
    yes: true,
    verbose: false,
    json: true,
    reconfigure: false
  }, {
    input: { isTTY: false },
    output: memoryOutput(),
    signal: new AbortController().signal
  }, {
    async executeInitialization(plan, options) {
      changedTarget = plan.writableTargets.find((target) => (
        path.basename(target) === "AGENTS.md"
      ));
      await writeFile(changedTarget, "用户刚刚写入\n", "utf8");
      return executeInitialization(plan, options);
    }
  });

  assert.equal(result.status, "conflict");
  assert.equal(result.code, "TARGET_CHANGED_AFTER_PREVIEW");
  assert.equal(await readFile(changedTarget, "utf8"), "用户刚刚写入\n");
  await assert.rejects(
    readFile(path.join(workspace, "governance-kit.yaml"), "utf8"),
    (error) => error.code === "ENOENT"
  );
  assert.deepEqual(
    changedWorkspacePaths(
      before,
      await snapshotCompleteWorkspace(workspace)
    ),
    [path.relative(workspace, changedTarget).replaceAll("\\", "/")]
  );
});

test("unknown arguments and flag scope are stable usage errors", async () => {
  for (const args of [
    ["unknown"],
    ["validate", "--yes"],
    ["apply", "--reconfigure"],
    ["apply", "--verbose"],
    ["validate", "--dry-run"]
  ]) {
    const result = await runCli(args);
    assert.equal(result.code, 2, args.join(" "));
    assert.match(result.stderr, /用法：/);
  }
});

test("JSON serialization failure writes no partial JSON and exits 2", async (t) => {
  const workspace = await createSupportedWorkspace(t);
  const before = await snapshotCompleteWorkspace(workspace);
  const { main } = await loadCliModule();
  const output = memoryOutput();
  const error = memoryOutput();

  const code = await main([
    "init", "--workspace", workspace, "--dry-run", "--json"
  ], {
    input: { isTTY: false },
    output,
    error
  }, {
    stringify() {
      throw new TypeError("serialization failed");
    }
  });

  assert.equal(code, 2);
  assert.equal(output.value(), "");
  assert.match(error.value(), /serialization failed/);
  assert.deepEqual(await snapshotCompleteWorkspace(workspace), before);
});

test("init startup failure exits 2 without a business JSON document", async (t) => {
  const workspace = await createSupportedWorkspace(t);
  const before = await snapshotCompleteWorkspace(workspace);
  const { main } = await loadCliModule();
  const output = memoryOutput();
  const error = memoryOutput();
  const code = await main([
    "init", "--workspace", workspace, "--json"
  ], {
    input: { isTTY: false },
    output,
    error
  }, {
    async planInitialization() {
      throw new Error("startup failed");
    }
  });

  assert.equal(code, 2);
  assert.equal(output.value(), "");
  assert.match(error.value(), /startup failed/);
  assert.deepEqual(await snapshotCompleteWorkspace(workspace), before);
});

test("EOF during final confirmation returns needs_input", async (t) => {
  const workspace = await createSupportedWorkspace(t);
  const before = await snapshotCompleteWorkspace(workspace);
  const { runInitCommand } = await loadCliModule();
  let closeCalls = 0;
  const input = new PassThrough();
  input.isTTY = true;
  const result = await runInitCommand({
    command: "init",
    workspace,
    dryRun: false,
    yes: false,
    verbose: false,
    json: false,
    reconfigure: false
  }, {
    input,
    output: memoryOutput(),
    signal: new AbortController().signal
  }, {
    createPromptSession() {
      return {
        signal: new AbortController().signal,
        async confirm() {
          throw Object.assign(new Error("EOF"), { code: "INPUT_EOF" });
        },
        close() { closeCalls += 1; }
      };
    }
  });

  assert.equal(result.status, "needs_input");
  assert.equal(result.code, "INPUT_REQUIRED");
  assert.equal(closeCalls, 1);
  assert.deepEqual(await snapshotCompleteWorkspace(workspace), before);
});

test("Unix and macOS child SIGINT exits 130", {
  skip: process.platform === "win32"
    ? "Windows 使用可注入 AbortSignal 覆盖稳定的 130 行为"
    : false
}, async (t) => {
  const workspace = await createSupportedWorkspace(t);
  const before = await snapshotCompleteWorkspace(workspace);
  const script = `
    import { pathToFileURL } from "node:url";
    const cli = await import(pathToFileURL(process.argv[1]));
    const workspace = process.argv[2];
    const code = await cli.main(["init", "--workspace", workspace], {
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

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      script,
      cliPath,
      workspace
    ], {
      cwd: kitRoot,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let interrupted = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!interrupted && stdout.includes("__READY__")) {
        interrupted = true;
        child.kill("SIGINT");
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

  assert.equal(result.code, 130, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /操作已中断/);
  assert.deepEqual(await snapshotCompleteWorkspace(workspace), before);
});

for (const mode of ["monorepo", "multi-repo"]) {
  test(`${mode} init then validate succeeds through the public CLI`, async (t) => {
    const workspace = await createDetectedWorkspace(t, mode);
    const before = await snapshotCompleteWorkspace(workspace);

    const initialized = await runCli([
      "init", "--workspace", workspace, "--yes", "--json"
    ]);
    assert.equal(initialized.code, 0, initialized.stderr);
    assert.equal(initialized.stderr, "");
    const initResult = JSON.parse(initialized.stdout);
    assert.equal(initResult.status, "applied");
    assert.equal(initResult.valid, true);
    const manifest = parse(await readFile(
      path.join(workspace, "governance-kit.yaml"),
      "utf8"
    ));
    assert.equal(manifest.project.repositoryMode, mode);
    const expectedGitRoots = mode === "monorepo"
      ? [path.resolve(workspace)]
      : ["admin", "miniprogram", "server"].map((component) => (
          path.resolve(workspace, component)
        ));
    assert.deepEqual(
      initResult.gitStates.map(({ rootDir }) => path.resolve(rootDir)).sort(),
      expectedGitRoots.sort()
    );
    assert.ok(initResult.gitStates.every(({ available }) => available === true));
    assert.ok(initResult.gitStates.every(({ dirty }) => dirty === true));
    assert.ok(initResult.gitStates.every(({ warning }) => warning === null));
    const afterInit = await snapshotCompleteWorkspace(workspace);
    assertSuccessfulWorkspaceChanges({
      before,
      after: afterInit,
      workspace,
      result: initResult
    });

    const beforeValidate = await snapshotCompleteWorkspace(workspace);
    const validated = await runCli([
      "validate", "--workspace", workspace, "--json"
    ]);
    assert.equal(validated.code, 0, validated.stderr);
    assert.equal(validated.stderr, "");
    assert.equal(JSON.parse(validated.stdout).report.valid, true);
    assert.deepEqual(
      await snapshotCompleteWorkspace(workspace),
      beforeValidate
    );
  });
}

test("complete snapshots record hidden temporary empty and linked entries without following escapes", async (t) => {
  const workspace = await createProjectWorkspace(t, {
    directories: ["empty-dir"],
    files: {
      ".hidden-file": "hidden",
      ".governance-kit.test.tmp": "temporary"
    }
  });
  const outside = await mkdtemp(path.join(tmpdir(), "governance-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "outside.txt"), "outside-content", "utf8");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  const linked = await createRealLink(t, {
    target: outside,
    linkPath: path.join(workspace, "linked-outside"),
    type: linkType
  });
  if (!linked.supported) return;

  const workspaceSnapshot = await snapshotCompleteWorkspace(workspace);
  const outsideSnapshot = await snapshotCompleteWorkspace(outside);

  assert.deepEqual(workspaceSnapshot["empty-dir/"], { type: "directory" });
  assert.equal(workspaceSnapshot[".hidden-file"].type, "file");
  assert.equal(
    workspaceSnapshot[".hidden-file"].content.toString("utf8"),
    "hidden"
  );
  assert.equal(workspaceSnapshot[".governance-kit.test.tmp"].type, "file");
  assert.equal(workspaceSnapshot["linked-outside"].type, "link");
  assert.equal(typeof workspaceSnapshot["linked-outside"].device, "number");
  assert.equal(typeof workspaceSnapshot["linked-outside"].inode, "number");
  assert.equal("linked-outside/outside.txt" in workspaceSnapshot, false);
  assert.equal(
    outsideSnapshot["outside.txt"].content.toString("utf8"),
    "outside-content"
  );
});

for (const conflict of [
  {
    name: "user AGENTS.md",
    relativePath: "server/AGENTS.md",
    content: "# 用户自己的规则\n",
    expectedCode: "USER_FILE_CONFLICT"
  },
  {
    name: "business status-enums.json",
    relativePath: "server/docs/status-enums.json",
    content: JSON.stringify({ owner: "business" }),
    expectedCode: "CREATE_ONLY_EXISTS"
  }
]) {
  test(`${conflict.name} conflict leaves the complete workspace unchanged`, async (t) => {
    const workspace = await createDetectedWorkspace(t, "monorepo", {
      files: { [conflict.relativePath]: conflict.content }
    });
    const before = await snapshotCompleteWorkspace(workspace);

    const result = await runCli([
      "init", "--workspace", workspace, "--yes", "--json"
    ]);

    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "conflict");
    assert.ok(output.report.conflicts.some((item) => (
      path.resolve(item.path) === path.resolve(workspace, conflict.relativePath)
      && item.code === conflict.expectedCode
    )));
    assert.deepEqual(await snapshotCompleteWorkspace(workspace), before);
  });
}

for (const linkType of [
  { name: "directory symlink", type: "dir" },
  { name: "Windows junction", type: "junction", windowsOnly: true }
]) {
  test(`${linkType.name} component escape is one structured zero-write conflict`, {
    skip: linkType.windowsOnly && process.platform !== "win32"
      ? "junction 是 Windows 专属真实文件系统门禁"
      : false
  }, async (t) => {
    const workspace = await createProjectWorkspace(t, {
      directories: [".git"],
      files: {
        "governance-kit.yaml": manifestForLinkedServer()
      }
    });
    const outside = await mkdtemp(path.join(tmpdir(), "governance-outside-"));
    t.after(() => rm(outside, { recursive: true, force: true }));
    await writeFile(
      path.join(outside, "pom.xml"),
      "<project>spring-boot mybatis flyway</project>",
      "utf8"
    );
    const linked = await createRealLink(t, {
      target: outside,
      linkPath: path.join(workspace, "server"),
      type: linkType.type
    });
    if (!linked.supported) return;
    const beforeWorkspace = await snapshotCompleteWorkspace(workspace);
    const beforeOutside = await snapshotCompleteWorkspace(outside);

    const result = await runCli([
      "init", "--workspace", workspace, "--yes", "--json"
    ]);

    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "conflict");
    assert.equal(output.code, "UNSAFE_REAL_PATH");
    assert.deepEqual(await snapshotCompleteWorkspace(workspace), beforeWorkspace);
    assert.deepEqual(await snapshotCompleteWorkspace(outside), beforeOutside);
  });
}

test("file symlink marker escape is one structured zero-write conflict", async (t) => {
  const workspace = await createProjectWorkspace(t, {
    directories: [".git", "server"],
    files: {
      "governance-kit.yaml": manifestForLinkedServer()
    }
  });
  const outside = await mkdtemp(path.join(tmpdir(), "governance-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const outsidePom = path.join(outside, "pom.xml");
  await writeFile(
    outsidePom,
    "<project>spring-boot mybatis flyway</project>",
    "utf8"
  );
  const linked = await createRealLink(t, {
    target: outsidePom,
    linkPath: path.join(workspace, "server", "pom.xml"),
    type: "file"
  });
  if (!linked.supported) return;
  const beforeWorkspace = await snapshotCompleteWorkspace(workspace);
  const beforeOutside = await snapshotCompleteWorkspace(outside);

  const result = await runCli([
    "init", "--workspace", workspace, "--yes", "--json"
  ]);

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "conflict");
  assert.equal(output.code, "UNSAFE_REAL_PATH");
  assert.deepEqual(await snapshotCompleteWorkspace(workspace), beforeWorkspace);
  assert.deepEqual(await snapshotCompleteWorkspace(outside), beforeOutside);
});

test("manifest file symlink returns one structured conflict without touching either side", async (t) => {
  const workspace = await createProjectWorkspace(t, {
    directories: [".git"],
    files: {
      "server/pom.xml": "<project>spring-boot mybatis flyway</project>"
    }
  });
  const outside = await mkdtemp(path.join(tmpdir(), "governance-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const outsideManifest = path.join(outside, "governance-kit.yaml");
  await writeFile(outsideManifest, manifestForLinkedServer(), "utf8");
  const linked = await createRealLink(t, {
    target: outsideManifest,
    linkPath: path.join(workspace, "governance-kit.yaml"),
    type: "file"
  });
  if (!linked.supported) return;
  const beforeWorkspace = await snapshotCompleteWorkspace(workspace);
  const beforeOutside = await snapshotCompleteWorkspace(outside);

  const result = await runCli([
    "init", "--workspace", workspace, "--yes", "--json"
  ]);

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "conflict");
  assert.equal(output.code, "UNSAFE_REAL_PATH");
  assert.equal(output.report, null);
  assert.deepEqual(await snapshotCompleteWorkspace(workspace), beforeWorkspace);
  assert.deepEqual(await snapshotCompleteWorkspace(outside), beforeOutside);
});

test("Chinese and spaced workspace paths initialize and validate", async (t) => {
  const workspace = await createDetectedWorkspace(t, "monorepo", {
    prefix: "治理 项目-"
  });
  const before = await snapshotCompleteWorkspace(workspace);

  const initialized = await runCli([
    "init", "--workspace", workspace, "--yes", "--json"
  ]);
  assert.equal(initialized.code, 0, initialized.stderr);
  assert.equal(initialized.stderr, "");
  const initResult = JSON.parse(initialized.stdout);
  assert.equal(initResult.status, "applied");
  assertSuccessfulWorkspaceChanges({
    before,
    after: await snapshotCompleteWorkspace(workspace),
    workspace,
    result: initResult
  });

  const beforeValidate = await snapshotCompleteWorkspace(workspace);
  const validated = await runCli([
    "validate", "--workspace", workspace, "--json"
  ]);
  assert.equal(validated.code, 0, validated.stderr);
  assert.equal(JSON.parse(validated.stdout).report.valid, true);
  assert.deepEqual(
    await snapshotCompleteWorkspace(workspace),
    beforeValidate
  );
});

for (const invalid of [
  { name: "invalid YAML", content: "components: [unterminated\n" },
  { name: "schema-invalid YAML", content: "schemaVersion: broken\n" }
]) {
  for (const reconfigure of [false, true]) {
    test(`${invalid.name} manifest is never overwritten${reconfigure ? " by reconfigure" : ""}`, async (t) => {
      const workspace = await createDetectedWorkspace(t, "monorepo", {
        files: { "governance-kit.yaml": invalid.content }
      });
      const before = await snapshotCompleteWorkspace(workspace);
      const args = ["init", "--workspace", workspace];
      if (reconfigure) args.push("--reconfigure");
      args.push("--yes", "--json");

      const result = await runCli(args);

      assert.equal(result.code, 1);
      assert.equal(result.stderr, "");
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, "conflict");
      assert.equal(output.code, "INVALID_MANIFEST");
      assert.deepEqual(await snapshotCompleteWorkspace(workspace), before);
    });
  }
}

test("reconfigure dry-run exposes a diff, writes nothing, then yes applies it", async (t) => {
  const workspace = await createDetectedWorkspace(t, "monorepo");
  const initialized = await runCli([
    "init", "--workspace", workspace, "--yes", "--json"
  ]);
  assert.equal(initialized.code, 0, initialized.stderr);
  const manifestPath = path.join(workspace, "governance-kit.yaml");
  const original = await readFile(manifestPath, "utf8");
  await writeFile(
    manifestPath,
    original.replace(
      `name: ${path.basename(workspace)}`,
      "name: legacy-project-name"
    ),
    "utf8"
  );
  const beforeDryRun = await snapshotCompleteWorkspace(workspace);

  const dryRun = await runCli([
    "init", "--workspace", workspace,
    "--reconfigure", "--dry-run", "--json"
  ]);

  assert.equal(dryRun.code, 0, dryRun.stderr);
  const dryRunOutput = JSON.parse(dryRun.stdout);
  assert.equal(dryRunOutput.status, "planned");
  assert.equal(dryRunOutput.manifestChange.category, "updated");
  assert.match(dryRunOutput.manifestChange.diff, /^[-+]/m);
  assert.deepEqual(await snapshotCompleteWorkspace(workspace), beforeDryRun);

  const applied = await runCli([
    "init", "--workspace", workspace,
    "--reconfigure", "--yes", "--json"
  ]);
  assert.equal(applied.code, 0, applied.stderr);
  const appliedOutput = JSON.parse(applied.stdout);
  assert.equal(appliedOutput.status, "applied");
  assert.equal(await readFile(manifestPath, "utf8"), original);
  assertSuccessfulWorkspaceChanges({
    before: beforeDryRun,
    after: await snapshotCompleteWorkspace(workspace),
    workspace,
    result: appliedOutput
  });
});

for (const fixture of [
  {
    name: "empty workspace",
    expectedCode: "NO_PROJECT_FOUND",
    files: {}
  },
  {
    name: "unsupported project",
    expectedCode: "UNSUPPORTED_PROJECT",
    files: { "README.md": "# existing unsupported project\n" }
  }
]) {
  test(`${fixture.name} returns a stable unsupported reason and writes nothing`, async (t) => {
    const workspace = await createProjectWorkspace(t, {
      directories: [".git"],
      files: fixture.files
    });
    const before = await snapshotCompleteWorkspace(workspace);

    const result = await runCli([
      "init", "--workspace", workspace, "--yes", "--json"
    ]);

    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "unsupported");
    assert.equal(output.code, fixture.expectedCode);
    assert.deepEqual(await snapshotCompleteWorkspace(workspace), before);
  });
}
