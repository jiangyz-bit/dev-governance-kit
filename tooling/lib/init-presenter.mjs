import path from "node:path";

const ansiEscapePattern = /\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g;
const terminalControlPattern = /[\u0000-\u001f\u007f-\u009f]/g;
const permissionConflictCodes = new Set([
  "TARGET_NOT_WRITABLE",
  "EACCES",
  "EPERM",
  "EROFS"
]);
const pathConflictCodes = new Set([
  "UNSAFE_REAL_PATH",
  "TARGET_CHANGED_AFTER_PREVIEW",
  "TARGET_CHANGED_DURING_READ"
]);

export function sanitizeTerminalText(value, fallback = "") {
  return String(value ?? fallback)
    .replace(ansiEscapePattern, "")
    .replace(terminalControlPattern, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const componentCopy = {
  server: {
    name: "后端服务",
    purpose: "处理业务、数据和接口"
  },
  admin: {
    name: "管理后台",
    purpose: "供运营或管理员在浏览器中管理内容和数据"
  },
  client: {
    name: "微信小程序",
    purpose: "供最终用户在微信中使用"
  }
};

function workspaceOf(result) {
  return typeof result?.workspace === "string"
    ? path.resolve(result.workspace)
    : process.cwd();
}

function relativePath(result, value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const workspace = workspaceOf(result);
  const candidate = path.isAbsolute(value)
    ? path.relative(workspace, value)
    : value;
  const normalized = candidate.replaceAll("\\", "/");
  if (
    normalized === ""
    || normalized === "."
  ) return ".";
  if (
    path.isAbsolute(normalized)
    || normalized === ".."
    || normalized.startsWith("../")
  ) return sanitizeTerminalText(path.basename(value));
  return sanitizeTerminalText(normalized);
}

function candidatesOf(result) {
  if (Array.isArray(result?.detected)) return result.detected;
  if (Array.isArray(result?.detected?.candidates)) {
    return result.detected.candidates;
  }
  return [];
}

function reportOf(result) {
  return result?.report ?? {
    created: [],
    updated: [],
    unchanged: [],
    conflicts: [],
    warnings: [],
    errors: []
  };
}

function fileLines(result, entries) {
  return (entries ?? [])
    .map((entry) => relativePath(result, entry?.path))
    .filter(Boolean)
    .map((item) => `  - ${item}`);
}

function componentLines(result) {
  const seen = new Set();
  const lines = [];
  for (const candidate of candidatesOf(result)) {
    if (seen.has(candidate.component)) continue;
    seen.add(candidate.component);
    const copy = componentCopy[candidate.component] ?? {
      name: "项目组成部分",
      purpose: "承载项目的一部分功能"
    };
    const componentPath = relativePath(result, candidate.path) ?? ".";
    lines.push(
      `- 找到${copy.name}：${componentPath}，它主要用来${copy.purpose}。`
    );
  }
  return lines;
}

function dirtyGitLines(result) {
  const states = result?.gitStates ?? result?.plan?.gitStates ?? [];
  if (states.some((state) => state?.dirty === true)) {
    return [
      "发现项目存在未提交修改；本工具不会提交、回滚或清理这些修改。"
    ];
  }
  if (states.some((state) => state?.available === false)) {
    return [
      "暂时无法确认项目是否有未提交修改；继续前请自行检查并保留重要内容。"
    ];
  }
  return [];
}

function staleWarningLines(result) {
  return (reportOf(result).warnings ?? [])
    .filter((warning) => warning?.code === "STALE_TEMP_FILE")
    .map((warning) => {
      const warningPath = relativePath(result, warning.path) ?? "一个未知位置";
      return `- 上次运行可能留下了临时文件 ${warningPath}。本工具不会自动删除，请确认内容后再自行处理。`;
    });
}

function safetyLines(result) {
  return [
    "安全说明：治理只会添加或更新治理文件，不会修改你的业务代码。",
    ...dirtyGitLines(result),
    ...staleWarningLines(result)
  ];
}

function plannedLines(result) {
  const report = reportOf(result);
  const created = fileLines(result, report.created);
  const updated = fileLines(result, report.updated);
  const lines = [
    "已完成检查，准备为这个项目添加开发治理基础。",
    "",
    "发现了什么：",
    ...(componentLines(result).length > 0
      ? componentLines(result)
      : ["- 已找到可以接入治理的项目目录。"]),
    ""
  ];
  if (created.length > 0) {
    lines.push("准备添加：", ...created, "");
  }
  if (updated.length > 0) {
    lines.push("准备更新：", ...updated, "");
  }
  if (created.length === 0 && updated.length === 0) {
    lines.push("现有治理文件已经是最新状态，不需要改动。", "");
  }
  lines.push(
    ...safetyLines(result),
    "",
    "当前还没有修改任何文件。",
    "下一步：确认以上内容无误后再继续；如果有疑问，可以先取消。"
  );
  return lines;
}

function conflictLines(result) {
  const conflicts = fileLines(result, reportOf(result).conflicts);
  const code = result?.code ?? result?.failed?.code;
  let summary;
  let action;
  if (code === "INVALID_MANIFEST") {
    summary = "项目里的治理配置文件内容有误，因此已经停止。";
    action = "下一步：先备份并修正 governance-kit.yaml；不确定时不要删除或覆盖它，然后重新运行。";
  } else if (permissionConflictCodes.has(code)) {
    summary = "准备写入治理文件时发现目录或文件没有足够的读写权限，因此已经停止。";
    action = "下一步：检查提示目录的读写权限，确认它允许当前用户写入后重新运行。";
  } else if (pathConflictCodes.has(code)) {
    summary = code === "UNSAFE_REAL_PATH"
      ? "发现目标路径可能经过链接或离开项目目录，为保护文件已经停止。"
      : "检查完成后目标文件又被其他程序修改，为避免覆盖已经停止。";
    action = code === "UNSAFE_REAL_PATH"
      ? "下一步：确认治理文件所在路径都是真实的项目内目录，不要使用指向其他位置的链接，然后重试。"
      : "下一步：关闭正在修改这些文件的其他程序，确认内容无误后重新运行。";
  } else if (code === "INIT_CONFLICT" || conflicts.length > 0) {
    summary = "发现你已有的文件与准备添加的治理内容冲突，因此已经停止。";
    action = "下一步：保留你自己的内容，比较并解决冲突后重新运行。";
  } else {
    summary = "准备治理文件时发现无法安全继续的问题，因此已经停止。";
    action = "下一步：先检查项目目录和文件权限；需要更多线索时使用详细模式。";
  }
  return [
    summary,
    ...(conflicts.length > 0
      ? ["需要你先检查这些文件：", ...conflicts]
      : []),
    "",
    ...safetyLines(result),
    "没有修改任何文件。",
    action
  ];
}

function needsInputLines(result) {
  const components = componentLines(result);
  const code = result?.code ?? result?.questions?.[0]?.code;
  let summary = "已经找到项目，但有一处信息无法安全判断，需要你确认。";
  let action = "下一步：根据屏幕上的中文提示选择；不确定时可以取消。";
  if (code === "INVALID_ANSWER") {
    summary = "刚才的输入不是有效序号，因此没有采用任何选择。";
    action = "下一步：重新选择屏幕列出的有效序号；不确定时输入 0 取消。";
  } else if (code === "PROMPT_PAGE_LIMIT") {
    summary = "需要确认的信息较多，超过了本次最多三个页面的安全限制。";
    action = "下一步：使用详细模式查看待确认内容，先明确项目目录关系后再重新运行；本工具不会替你猜。";
  } else if (code === "UNSUPPORTED_QUESTION") {
    summary = "识别过程中遇到当前版本还不能处理的问题，已经安全停止。";
    action = "下一步：使用详细模式保存诊断信息并反馈问题；不要随意选择或修改现有文件。";
  }
  return [
    summary,
    ...(components.length > 0 ? ["", "目前发现：", ...components] : []),
    "",
    ...safetyLines(result),
    "现在不会修改任何文件。",
    action
  ];
}

function cancelledLines(result) {
  return [
    "已经取消，本次没有修改任何文件。",
    ...dirtyGitLines(result),
    "下一步：准备好后可以重新运行初始化。"
  ];
}

function appliedLines(result) {
  const written = fileLines(
    result,
    (result?.written ?? []).map((item) => ({ path: item }))
  );
  return [
    "项目治理配置已完成，并且检查通过。",
    ...(written.length > 0 ? ["已写入：", ...written] : []),
    ...safetyLines(result),
    "下一步：可以让 AI Agent 按照新生成的治理说明继续开发项目。"
  ];
}

function failedValidationLines(result) {
  const written = fileLines(
    result,
    (result?.written ?? []).map((item) => ({ path: item }))
  );
  return [
    "治理文件已经写入，但最后的完整检查没有通过。",
    ...(written.length > 0 ? ["已经写入：", ...written] : []),
    ...safetyLines(result),
    "下一步：请保留当前文件，使用详细模式查看原因，修复后重新检查。"
  ];
}

function partialFailureLines(result) {
  const written = fileLines(
    result,
    (result?.written ?? []).map((item) => ({ path: item }))
  );
  const safe = result?.recovery?.safeToRerun === true;
  return [
    "初始化只完成了一部分，已经安全停止。",
    ...(written.length > 0 ? ["已经写入：", ...written] : []),
    ...safetyLines(result),
    safe
      ? "下一步：请不要手动覆盖上述文件，可以直接重新运行初始化。"
      : "下一步：请先检查已经写入的文件，确认自己的修改没有被混入后再重试。"
  ];
}

function interruptedLines(result) {
  const wrote = (result?.written ?? []).length > 0;
  const written = fileLines(
    result,
    (result?.written ?? []).map((item) => ({ path: item }))
  );
  const safeToRerun = result?.recovery?.safeToRerun === true;
  return [
    `操作已中断，${wrote ? "中断前已有部分治理文件写入。" : "没有修改任何文件。"}`,
    ...(written.length > 0 ? ["已经写入：", ...written] : []),
    ...safetyLines(result),
    wrote && safeToRerun
      ? "下一步：已写入内容仍与本次计划一致，可以直接重新运行初始化。"
      : wrote
        ? "下一步：请先检查已经写入的文件，确认没有混入其他修改后再重新运行。"
      : "下一步：需要时可以重新运行初始化。"
  ];
}

function unsupportedLines(result) {
  return [
    "暂时没有找到可以自动识别的项目结构。",
    ...safetyLines(result),
    "没有修改任何文件。",
    "下一步：请确认你在项目根目录运行，或使用详细模式查看识别信息。"
  ];
}

function noviceLines(result) {
  switch (result?.status) {
    case "planned":
      return plannedLines(result);
    case "conflict":
      return conflictLines(result);
    case "needs_input":
      return needsInputLines(result);
    case "cancelled":
      return cancelledLines(result);
    case "applied":
      return appliedLines(result);
    case "failed_validation":
      return failedValidationLines(result);
    case "partial_failure":
      return partialFailureLines(result);
    case "interrupted":
      return interruptedLines(result);
    case "unsupported":
      return unsupportedLines(result);
    default:
      return [
        "初始化没有完成。",
        "下一步：请使用详细模式查看原因后再重试。"
      ];
  }
}

function diagnosticLines(result) {
  const candidates = candidatesOf(result);
  const report = reportOf(result);
  const lines = [
    "",
    "详细诊断：",
    `- workspace: ${sanitizeTerminalText(result?.workspace)}`,
    `- status: ${sanitizeTerminalText(result?.status)}`,
    `- code: ${sanitizeTerminalText(result?.code, "(none)")}`
  ];
  for (const candidate of candidates) {
    lines.push(
      `- component=${sanitizeTerminalText(candidate.component)}; Profile=${sanitizeTerminalText(candidate.profile)}; confidence=${sanitizeTerminalText(candidate.confidence, "(unknown)")}; path=${sanitizeTerminalText(candidate.path, ".")}`
    );
    if ((candidate.evidence ?? []).length > 0) {
      lines.push(
        `  evidence: ${candidate.evidence.map((item) => sanitizeTerminalText(item)).join(", ")}`
      );
    }
  }
  const warnings = [
    ...(report.warnings ?? []),
    ...(result?.warnings ?? [])
  ];
  for (const warning of warnings) {
    lines.push(
      `- warning=${sanitizeTerminalText(warning.code, "(unknown)")}; path=${sanitizeTerminalText(warning.path, "(none)")}`
    );
    if (warning.targetPath) {
      lines.push(`  targetPath=${sanitizeTerminalText(warning.targetPath)}`);
    }
  }
  for (const conflict of report.conflicts ?? []) {
    lines.push(
      `- conflict=${sanitizeTerminalText(conflict.code, "(unknown)")}; path=${sanitizeTerminalText(conflict.path, "(none)")}`
    );
  }
  if (result?.failed) {
    lines.push(
      `- failed=${sanitizeTerminalText(result.failed.code, "(unknown)")}: ${sanitizeTerminalText(result.failed.message)}`
    );
  }
  return lines;
}

export function formatInitHuman(result, { verbose = false } = {}) {
  const lines = noviceLines(result);
  if (verbose) lines.push(...diagnosticLines(result));
  return lines.filter((line, index, values) => (
    line !== "" || values[index - 1] !== ""
  )).join("\n");
}
