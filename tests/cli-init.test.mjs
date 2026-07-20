import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  executeInitialization,
  planInitialization
} from "../tooling/lib/init.mjs";
import { createProjectWorkspace } from "./helpers/project-workspace.mjs";

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

async function snapshotWorkspace(rootDir, relativeDir = "") {
  const result = {};
  const entries = (await readdir(path.join(rootDir, relativeDir), {
    withFileTypes: true
  })).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(result, await snapshotWorkspace(rootDir, relativePath));
    } else if (entry.isFile()) {
      result[relativePath.replaceAll("\\", "/")] = await readFile(
        path.join(rootDir, relativePath),
        "utf8"
      );
    }
  }
  return result;
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

test("init dry-run emits exactly one JSON document and writes nothing", async (t) => {
  const workspace = await createSupportedWorkspace(t);
  const before = await snapshotWorkspace(workspace);

  const result = await runCli([
    "init", "--workspace", workspace, "--dry-run", "--yes", "--json"
  ]);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).status, "planned");
  assert.equal(result.stdout.trim().split(/\n(?=\{)/).length, 1);
  assert.deepEqual(await snapshotWorkspace(workspace), before);
});

test("JSON and non-TTY execution never create a prompt session", async (t) => {
  const workspace = await createSupportedWorkspace(t, { assumption: false });
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
  assert.deepEqual(await snapshotWorkspace(workspace), {
    "demo-server/pom.xml": (await readFile(
      path.join(workspace, "demo-server", "pom.xml"),
      "utf8"
    ))
  });
});

test("non-TTY requires --yes, while --yes executes only a resolved plan", async (t) => {
  const workspace = await createSupportedWorkspace(t);
  const withoutYes = await runCli(["init", "--workspace", workspace, "--json"]);
  assert.equal(withoutYes.code, 1);
  assert.equal(withoutYes.stderr, "");
  assert.equal(JSON.parse(withoutYes.stdout).status, "needs_input");

  const withYes = await runCli([
    "init", "--workspace", workspace, "--yes", "--json"
  ]);
  assert.equal(withYes.code, 0, withYes.stderr);
  assert.equal(withYes.stderr, "");
  assert.equal(JSON.parse(withYes.stdout).status, "applied");
});

test("plain non-TTY without --yes explains that confirmation is required", async (t) => {
  const workspace = await createSupportedWorkspace(t);
  const result = await runCli(["init", "--workspace", workspace]);

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /需要你确认/);
});

test("human dry-run with --yes shows the prepared result once and writes nothing", async (t) => {
  const workspace = await createSupportedWorkspace(t);
  const before = await snapshotWorkspace(workspace);
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
  assert.deepEqual(await snapshotWorkspace(workspace), before);
});

test("interactive cancellation exits zero and closes the prompt once", async (t) => {
  const workspace = await createSupportedWorkspace(t);
  const before = await snapshotWorkspace(workspace);
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
  assert.deepEqual(await snapshotWorkspace(workspace), before);
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
});

test("abort while the final prompt is pending exits 130 and closes once", async (t) => {
  const workspace = await createSupportedWorkspace(t);
  const before = await snapshotWorkspace(workspace);
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
  assert.deepEqual(await snapshotWorkspace(workspace), before);
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
});

test("init startup failure exits 2 without a business JSON document", async (t) => {
  const workspace = await createSupportedWorkspace(t);
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
});

test("EOF during final confirmation returns needs_input", async (t) => {
  const workspace = await createSupportedWorkspace(t);
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
});

test("Unix and macOS child SIGINT exits 130", {
  skip: process.platform === "win32"
    ? "Windows 使用可注入 AbortSignal 覆盖稳定的 130 行为"
    : false
}, async (t) => {
  const workspace = await createSupportedWorkspace(t);
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
});
