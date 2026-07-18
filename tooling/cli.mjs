#!/usr/bin/env node

import path from "node:path";
import { applyGovernance } from "./lib/apply.mjs";
import { GovernanceError } from "./lib/errors.mjs";
import { validateWorkspace } from "./lib/validate.mjs";

const usage = `用法：
  governance-kit apply --workspace <path> [--dry-run] [--json]
  governance-kit validate --workspace <path> [--json]
  governance-kit --help
`;

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === "--help") {
    return { help: true };
  }
  const command = args[0];
  if (command !== "apply" && command !== "validate") {
    throw usageError(`未知命令：${command ?? "(空)"}`);
  }

  const options = {
    command,
    workspace: process.cwd(),
    dryRun: false,
    json: false
  };
  let workspaceSeen = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--workspace") {
      if (workspaceSeen) {
        throw usageError("--workspace 不能重复");
      }
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw usageError("--workspace 缺少路径");
      }
      workspaceSeen = true;
      options.workspace = path.resolve(value);
      index += 1;
    } else if (argument === "--dry-run") {
      if (command !== "apply") {
        throw usageError("--dry-run 只能用于 apply");
      }
      options.dryRun = true;
    } else if (argument === "--json") {
      options.json = true;
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

function printHuman(command, workspace, ok, report) {
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
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function run(options) {
  let report;
  if (options.command === "apply") {
    try {
      report = await applyGovernance({
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
    report = await validateWorkspace({ workspaceDir: options.workspace });
  }

  const ok = options.command === "apply"
    ? report.conflicts.length === 0 && report.errors.length === 0
    : report.valid;
  const output = {
    command: options.command,
    workspace: options.workspace,
    ok,
    report
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    printHuman(options.command, options.workspace, ok, report);
  }
  return ok ? 0 : 1;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage);
    process.exitCode = 0;
  } else {
    process.exitCode = await run(options);
  }
} catch (error) {
  if (error.exitCode === 2) {
    process.stderr.write(`${error.message}\n${usage}`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
