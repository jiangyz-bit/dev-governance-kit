import path from "node:path";

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
  ) return path.basename(value);
  return normalized;
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
  return [
    "发现现有文件与准备添加的治理内容冲突，因此已经停止。",
    ...(conflicts.length > 0
      ? ["需要你先检查这些文件：", ...conflicts]
      : ["需要你先检查项目目录和文件权限。"]),
    "",
    ...safetyLines(result),
    "没有修改任何文件。",
    "下一步：保留并确认你自己的内容，解决冲突后重新运行。"
  ];
}

function needsInputLines(result) {
  const components = componentLines(result);
  return [
    "已经找到项目，但有一处信息无法安全判断，需要你确认。",
    ...(components.length > 0 ? ["", "目前发现：", ...components] : []),
    "",
    ...safetyLines(result),
    "现在不会修改任何文件。",
    "下一步：根据屏幕上的中文提示选择；不确定时可以取消。"
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
  return [
    "治理文件已经写入，但最后的完整检查没有通过。",
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
  return [
    `操作已中断，${wrote ? "中断前已有部分治理文件写入。" : "没有修改任何文件。"}`,
    ...safetyLines(result),
    wrote
      ? "下一步：请先查看已经写入的文件，再按提示重新运行。"
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
    `- workspace: ${result?.workspace ?? ""}`,
    `- status: ${result?.status ?? ""}`,
    `- code: ${result?.code ?? "(none)"}`
  ];
  for (const candidate of candidates) {
    lines.push(
      `- component=${candidate.component}; Profile=${candidate.profile}; confidence=${candidate.confidence ?? "(unknown)"}; path=${candidate.path ?? "."}`
    );
    if ((candidate.evidence ?? []).length > 0) {
      lines.push(`  evidence: ${candidate.evidence.join(", ")}`);
    }
  }
  const warnings = [
    ...(report.warnings ?? []),
    ...(result?.warnings ?? [])
  ];
  for (const warning of warnings) {
    lines.push(
      `- warning=${warning.code ?? "(unknown)"}; path=${warning.path ?? "(none)"}`
    );
    if (warning.targetPath) lines.push(`  targetPath=${warning.targetPath}`);
  }
  for (const conflict of report.conflicts ?? []) {
    lines.push(
      `- conflict=${conflict.code ?? "(unknown)"}; path=${conflict.path ?? "(none)"}`
    );
  }
  if (result?.failed) {
    lines.push(
      `- failed=${result.failed.code ?? "(unknown)"}: ${result.failed.message ?? ""}`
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
