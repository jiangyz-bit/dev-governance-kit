#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyGovernance } from "./lib/apply.mjs";
import { GovernanceError } from "./lib/errors.mjs";
import {
  executeInitialization,
  needsFinalConfirmationResult,
  planInitialization,
  plannedResult
} from "./lib/init.mjs";
import { formatInitHuman } from "./lib/init-presenter.mjs";
import {
  collectInitAnswers,
  createPromptSession
} from "./lib/init-prompts.mjs";
import { validateWorkspace } from "./lib/validate.mjs";

const usage = `用法：
  governance-kit init --workspace <path> [--dry-run] [--yes] [--verbose] [--json] [--reconfigure]
  governance-kit apply --workspace <path> [--dry-run] [--json]
  governance-kit validate --workspace <path> [--json]
  governance-kit --help
`;
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

async function addRuntimeEvidence(result) {
  const packageJson = JSON.parse(await readFile(
    path.join(packageRoot, "package.json"),
    "utf8"
  ));
  return {
    ...result,
    version: packageJson.version,
    runtime: {
      ...(result.runtime ?? {}),
      packageRoot
    }
  };
}

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

export function parseArgs(args) {
  if (args.length === 1 && args[0] === "--help") {
    return { help: true };
  }
  const command = args[0];
  if (!["init", "apply", "validate"].includes(command)) {
    throw usageError(`未知命令：${command ?? "(空)"}`);
  }

  const options = {
    command,
    workspace: process.cwd(),
    dryRun: false,
    json: false,
    ...(command === "init"
      ? { yes: false, verbose: false, reconfigure: false }
      : {})
  };
  const seen = new Set();
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (seen.has(argument)) {
      throw usageError(`${argument} 不能重复`);
    }
    seen.add(argument);
    if (argument === "--workspace") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw usageError("--workspace 缺少路径");
      }
      options.workspace = path.resolve(value);
      index += 1;
    } else if (argument === "--dry-run") {
      if (command === "validate") {
        throw usageError("--dry-run 只能用于 init 或 apply");
      }
      options.dryRun = true;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--yes") {
      if (command !== "init") throw usageError("--yes 只能用于 init");
      options.yes = true;
    } else if (argument === "--verbose") {
      if (command !== "init") throw usageError("--verbose 只能用于 init");
      options.verbose = true;
    } else if (argument === "--reconfigure") {
      if (command !== "init") {
        throw usageError("--reconfigure 只能用于 init");
      }
      options.reconfigure = true;
    } else if (argument === "--help") {
      throw usageError("--help 必须单独使用");
    } else {
      throw usageError(`未知参数：${argument}`);
    }
  }
  options.workspace = path.resolve(options.workspace);
  return options;
}

function emptyApplyReport(error) {
  return {
    created: [],
    updated: [],
    unchanged: [],
    conflicts: [],
    warnings: [],
    errors: [error]
  };
}

function formatLegacyHuman(command, workspace, ok, report) {
  const lines = [
    `命令：${command}`,
    `工作区：${workspace}`,
    `结果：${ok ? "成功" : "存在问题"}`
  ];
  if (command === "apply") {
    lines.push(
      `创建：${report.created.length}`,
      `更新：${report.updated.length}`,
      `未变化：${report.unchanged.length}`,
      `冲突：${report.conflicts.length}`,
      `警告：${report.warnings.length}`,
      `错误：${report.errors.length}`
    );
  } else {
    lines.push(
      `检查：${report.checks.length}`,
      `警告：${report.warnings.length}`,
      `错误：${report.errors.length}`
    );
  }
  for (const item of [...(report.conflicts ?? []), ...(report.errors ?? [])]) {
    lines.push(`- [${item.code}] ${item.path ?? item.message ?? ""}`);
  }
  return lines.join("\n");
}

async function runLegacyCommand(options, dependencies = {}) {
  const apply = dependencies.applyGovernance ?? applyGovernance;
  const validate = dependencies.validateWorkspace ?? validateWorkspace;
  let report;
  if (options.command === "apply") {
    try {
      report = await apply({
        workspaceDir: options.workspace,
        dryRun: options.dryRun
      });
    } catch (error) {
      if (error instanceof GovernanceError) {
        report = emptyApplyReport(error.toJSON());
      } else {
        throw error;
      }
    }
  } else {
    report = await validate({ workspaceDir: options.workspace });
  }

  const ok = options.command === "apply"
    ? report.conflicts.length === 0 && report.errors.length === 0
    : report.valid;
  return {
    command: options.command,
    workspace: options.workspace,
    ok,
    report
  };
}

function interruptedResult(workspace, written = []) {
  return {
    command: "init",
    workspace: path.resolve(workspace),
    ok: false,
    status: "interrupted",
    code: "INTERRUPTED",
    applied: written.length > 0,
    valid: false,
    written
  };
}

function inputRequiredResult(plan, code = "INPUT_REQUIRED", pagesUsed = 0) {
  return {
    ...plan,
    command: "init",
    ok: false,
    status: "needs_input",
    code,
    applied: false,
    valid: false,
    written: [],
    pagesUsed,
    questions: code === "PROMPT_PAGE_LIMIT"
      ? (plan?.questions ?? [])
      : [{
          code: "INPUT_REQUIRED",
          message: "输入流已结束"
        }]
  };
}

function cancelledResult(plan) {
  return {
    ...plannedResult(plan),
    ok: true,
    status: "cancelled",
    applied: false,
    valid: false,
    written: []
  };
}

function mergeAnswers(target, additions) {
  for (const [key, value] of Object.entries(additions ?? {})) {
    if (
      value
      && typeof value === "object"
      && !Array.isArray(value)
      && target[key]
      && typeof target[key] === "object"
      && !Array.isArray(target[key])
    ) {
      target[key] = { ...target[key], ...value };
    } else {
      target[key] = value;
    }
  }
}

function pageLimitedSession(session, state) {
  async function usePage(method, ...args) {
    if (state.pagesUsed >= 3) {
      const error = new GovernanceError(
        "PROMPT_PAGE_LIMIT",
        "本次交互已达到三个页面的安全限制"
      );
      throw error;
    }
    state.pagesUsed += 1;
    return session[method](...args);
  }
  return {
    signal: session.signal,
    choose: (...args) => usePage("choose", ...args),
    confirm: (...args) => usePage("confirm", ...args),
    close: () => session.close()
  };
}

export async function runInitCommand(options, io, dependencies = {}) {
  const plan = dependencies.planInitialization ?? planInitialization;
  const execute = dependencies.executeInitialization ?? executeInitialization;
  const collect = dependencies.collectInitAnswers ?? collectInitAnswers;
  const makePrompts = dependencies.createPromptSession ?? createPromptSession;
  const answers = {};
  let current = await plan({
    workspaceDir: options.workspace,
    reconfigure: options.reconfigure,
    answers,
    signal: io.signal
  });

  if (options.json || io.input?.isTTY !== true) {
    if (current.status !== "ready") return current;
    if (options.dryRun) return plannedResult(current);
    if (!options.yes) return needsFinalConfirmationResult(current);
    return execute(current, { signal: io.signal });
  }

  if (
    current.status === "ready"
    && (current.report?.conflicts?.length ?? 0) > 0
  ) {
    return plannedResult(current);
  }

  let prompts;
  const pageState = { pagesUsed: 0 };
  try {
    while (current.status === "needs_input") {
      if (pageState.pagesUsed >= 3) {
        return inputRequiredResult(
          current,
          "PROMPT_PAGE_LIMIT",
          pageState.pagesUsed
        );
      }
      prompts ??= pageLimitedSession(makePrompts({
        input: io.input,
        output: io.output,
        signal: io.signal
      }), pageState);
      const pagesBefore = pageState.pagesUsed;
      const response = await collect({
        plan: current,
        promptSession: prompts
      });
      if (pageState.pagesUsed === pagesBefore) {
        pageState.pagesUsed += response.pagesUsed ?? 0;
      }
      if (pageState.pagesUsed > 3) {
        return inputRequiredResult(current, "PROMPT_PAGE_LIMIT", 3);
      }
      if (response.status === "cancelled") return {
        command: "init",
        workspace: options.workspace,
        ok: true,
        status: "cancelled",
        applied: false,
        valid: false,
        written: []
      };
      if (response.status === "interrupted") return interruptedResult(
        options.workspace
      );
      if (response.status !== "answered") {
        return inputRequiredResult(
          { ...current, questions: response.questions ?? current.questions },
          response.code ?? "INPUT_REQUIRED",
          pageState.pagesUsed
        );
      }
      mergeAnswers(answers, response.answers);
      current = await plan({
        workspaceDir: options.workspace,
        reconfigure: options.reconfigure,
        answers,
        signal: io.signal
      });
    }

    if (current.status !== "ready") return current;
    if (options.dryRun) return plannedResult(current);
    if (options.yes) return execute(current, {
      signal: io.signal
    });

    io.output.write(`${formatInitHuman(plannedResult(current), {
      verbose: options.verbose
    })}\n`);
    prompts ??= pageLimitedSession(makePrompts({
      input: io.input,
      output: io.output,
      signal: io.signal
    }), pageState);
    const confirmed = await prompts.confirm();
    if (!confirmed) return cancelledResult(current);
    return execute(current, { signal: io.signal });
  } catch (error) {
    if (
      io.signal?.aborted
      || error?.code === "INTERRUPTED"
      || error?.name === "AbortError"
    ) {
      return interruptedResult(options.workspace);
    }
    if (error?.code === "INPUT_EOF") {
      return inputRequiredResult(current, "INPUT_REQUIRED", pageState.pagesUsed);
    }
    if (error?.code === "PROMPT_PAGE_LIMIT") {
      return inputRequiredResult(
        current,
        "PROMPT_PAGE_LIMIT",
        pageState.pagesUsed
      );
    }
    throw error;
  } finally {
    prompts?.close();
  }
}

export function exitCodeFor(result) {
  if (result?.status === "interrupted") return 130;
  if (["planned", "cancelled", "applied"].includes(result?.status)) return 0;
  if (result?.ok === true) return 0;
  return 1;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

export async function main(
  args = process.argv.slice(2),
  io = {
    input: process.stdin,
    output: process.stdout,
    error: process.stderr
  },
  dependencies = {}
) {
  let controller;
  let onSigint;
  let options;
  try {
    options = parseArgs(args);
    if (options.help) {
      io.output.write(usage);
      return 0;
    }

    let result;
    if (options.command === "init") {
      controller = new AbortController();
      const signal = io.signal
        ? AbortSignal.any([io.signal, controller.signal])
        : controller.signal;
      onSigint = () => controller.abort();
      process.once("SIGINT", onSigint);
      result = await runInitCommand(options, {
        input: io.input,
        output: io.output,
        signal
      }, dependencies);
    } else {
      result = await runLegacyCommand(options, dependencies);
    }

    if (options.json) {
      if (options.command === "init" && options.verbose) {
        result = await addRuntimeEvidence(result);
      }
      let serialized;
      try {
        serialized = (dependencies.stringify ?? JSON.stringify)(
          result,
          null,
          2
        );
      } catch (error) {
        error.exitCode = 2;
        throw error;
      }
      io.output.write(`${serialized}\n`);
    } else if (options.command === "init") {
      io.output.write(`${formatInitHuman(result, {
        verbose: options.verbose
      })}\n`);
    } else {
      io.output.write(
        `${formatLegacyHuman(options.command, options.workspace, result.ok, result.report)}\n`
      );
    }
    return options.command === "init"
      ? exitCodeFor(result)
      : (result.ok ? 0 : 1);
  } catch (error) {
    if (error.exitCode === 2) {
      io.error.write(`${error.message}\n${usage}`);
      return 2;
    }
    io.error.write(`${error.stack ?? error.message}\n`);
    return options?.command === "init" ? 2 : 1;
  } finally {
    if (onSigint) process.removeListener("SIGINT", onSigint);
  }
}

if (isDirectExecution()) {
  process.exitCode = await main();
}
