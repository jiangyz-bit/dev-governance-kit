import { createInterface } from "node:readline/promises";
import { GovernanceError } from "./errors.mjs";
import { sanitizeTerminalText } from "./init-presenter.mjs";

const confirmationCodes = new Set([
  "PROFILE_ASSUMPTION_UNCONFIRMED",
  "PROFILE_EVIDENCE_MISMATCH",
  "ADMIN_ROLE_UNCLEAR"
]);

const componentNames = {
  server: "后端服务",
  admin: "管理后台",
  client: "微信小程序"
};

function interruptedError() {
  return new GovernanceError("INTERRUPTED", "用户中断初始化");
}

function eofError() {
  return new GovernanceError("INPUT_EOF", "输入流已结束");
}

function renderQuestion(question) {
  const lines = [sanitizeTerminalText(question.message)];
  for (const [index, option] of (question.options ?? []).entries()) {
    lines.push(
      `${index + 1}. ${sanitizeTerminalText(option.label)}：${sanitizeTerminalText(option.impact)}`
    );
  }
  lines.push("请输入序号（输入 0 取消）：");
  return `${lines.join("\n")} `;
}

export function createPromptSession({
  input = process.stdin,
  output = process.stdout,
  signal: externalSignal
} = {}) {
  const readline = createInterface({ input, output });
  const controller = new AbortController();
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal;
  let inputEnded = input.readableEnded === true;
  let intentionallyClosed = false;
  let closed = false;

  const onInputEnd = () => {
    inputEnded = true;
  };
  const onSigint = () => {
    controller.abort();
  };
  const onClose = () => {
    closed = true;
  };
  input.once("end", onInputEnd);
  readline.on("SIGINT", onSigint);
  readline.once("close", onClose);

  async function ask(message) {
    if (signal.aborted) throw interruptedError();
    if (inputEnded || closed) throw eofError();
    let rejectOnInputEnd;
    let rejectOnUnexpectedClose;
    const ended = new Promise((resolve, reject) => {
      rejectOnInputEnd = () => reject(eofError());
      rejectOnUnexpectedClose = () => {
        if (!intentionallyClosed && !signal.aborted) reject(eofError());
      };
      input.once("end", rejectOnInputEnd);
      readline.once("close", rejectOnUnexpectedClose);
    });
    try {
      return await Promise.race([
        readline.question(message, { signal }),
        ended
      ]);
    } catch (error) {
      if (signal.aborted || error?.name === "AbortError") {
        throw interruptedError();
      }
      if (
        inputEnded
        || (!intentionallyClosed && closed)
        || error?.code === "ERR_USE_AFTER_CLOSE"
      ) {
        throw eofError();
      }
      throw error;
    } finally {
      input.removeListener("end", rejectOnInputEnd);
      readline.removeListener("close", rejectOnUnexpectedClose);
    }
  }

  return {
    signal,
    async choose(question) {
      return ask(renderQuestion(question));
    },
    async confirm(message = "是否继续？输入 y 继续，直接回车或输入其他内容取消：(y/N) ") {
      const answer = await ask(`${sanitizeTerminalText(message)} `);
      return /^y(?:es)?$/i.test(answer.trim());
    },
    close() {
      if (intentionallyClosed) return;
      intentionallyClosed = true;
      input.removeListener("end", onInputEnd);
      readline.removeListener("SIGINT", onSigint);
      if (!closed) readline.close();
    }
  };
}

function confirmationText(question) {
  const componentName = componentNames[question.component] ?? "这个项目部分";
  switch (question.code) {
    case "PROFILE_ASSUMPTION_UNCONFIRMED":
      return `- ${componentName}没有检测到数据库升级工具。继续只会添加通用治理说明，不会安装工具或修改数据库。`;
    case "PROFILE_EVIDENCE_MISMATCH":
      return `- ${componentName}与现有配置不完全一致。继续会沿用现有配置，只添加对应的治理文件。`;
    case "ADMIN_ROLE_UNCLEAR":
      return `- ${sanitizeTerminalText(question.path, componentName)} 可能是管理员使用的后台。继续会把它当作管理后台添加治理说明。`;
    default:
      return `- 请确认 ${componentName} 的识别结果。`;
  }
}

function componentChoice(question) {
  const componentName = question.component === "admin"
    ? "管理员使用的后台"
    : (componentNames[question.component] ?? "项目部分");
  return {
    message: `检测到多个可能的${componentName}，请选择正确目录。这个选择只决定治理文件放在哪个目录，不会移动或修改业务代码。`,
    options: (question.candidates ?? []).map((candidate) => ({
      value: candidate.path,
      label: sanitizeTerminalText(candidate.path),
      impact: "选择后只在这个目录准备治理文件"
    }))
  };
}

function repositoryChoice() {
  return {
    message: "这些项目代码是怎样保存的？这个选择只影响治理配置如何描述目录关系，不会改变 Git 仓库。",
    options: [
      {
        value: "monorepo",
        label: "放在同一个代码仓库",
        impact: "所有目录由同一个 Git 仓库管理"
      },
      {
        value: "multi-repo",
        label: "每个目录各自一个代码仓库",
        impact: "每个目录由独立 Git 仓库管理"
      }
    ]
  };
}

function questionPage(question) {
  if (/_COMPONENT_UNCLEAR$/.test(question.code ?? "")) {
    const prompt = componentChoice(question);
    return {
      kind: "choice",
      question,
      prompt,
      apply(answers, option) {
        answers.components ??= {};
        answers.components[question.component] = { path: option.value };
      }
    };
  }
  if (question.code === "REPOSITORY_MODE_UNCLEAR") {
    const prompt = repositoryChoice();
    return {
      kind: "choice",
      question,
      prompt,
      apply(answers, option) {
        answers.repositoryMode = option.value;
      }
    };
  }
  return null;
}

function needsInputResult(plan, reason, pagesUsed = 0) {
  return {
    status: "needs_input",
    code: reason,
    questions: plan?.questions ?? [],
    answers: {},
    pagesUsed
  };
}

export async function collectInitAnswers({ plan, promptSession }) {
  if (plan?.status !== "needs_input") {
    return { status: "answered", answers: {}, pagesUsed: 0 };
  }
  const questions = plan.questions ?? [];
  const confirmations = questions.filter((question) => (
    confirmationCodes.has(question.code)
  ));
  const pages = [];
  for (const question of questions) {
    if (confirmationCodes.has(question.code)) continue;
    const page = questionPage(question);
    if (!page) return needsInputResult(plan, "UNSUPPORTED_QUESTION");
    pages.push(page);
  }
  if (confirmations.length > 0) {
    pages.push({ kind: "confirmations", questions: confirmations });
  }
  if (pages.length === 0) return needsInputResult(plan, "INPUT_REQUIRED");
  if (pages.length > 3) return needsInputResult(plan, "PROMPT_PAGE_LIMIT");

  const answers = {};
  let pagesUsed = 0;
  for (const page of pages) {
    if (page.kind === "confirmations") {
      const message = [
        "请复核下面的识别结果：",
        ...page.questions.map(confirmationText),
        "确认无误后输入 y 继续；直接回车或输入其他内容取消：(y/N) "
      ].join("\n");
      const confirmed = await promptSession.confirm(message);
      pagesUsed += 1;
      if (!confirmed) {
        return { status: "cancelled", answers: {}, pagesUsed };
      }
      answers.questions ??= {};
      for (const question of page.questions) {
        const key = question.component
          ? `${question.code}:${question.component}`
          : question.code;
        answers.questions[key] = { confirmed: true };
      }
      continue;
    }

    const raw = await promptSession.choose(page.prompt);
    pagesUsed += 1;
    const trimmed = String(raw ?? "").trim();
    if (trimmed === "0" || /^q(?:uit)?$/i.test(trimmed)) {
      return { status: "cancelled", answers: {}, pagesUsed };
    }
    const selectedIndex = Number.parseInt(trimmed, 10) - 1;
    const option = page.prompt.options[selectedIndex];
    if (!option || String(selectedIndex + 1) !== trimmed) {
      return needsInputResult(plan, "INVALID_ANSWER", pagesUsed);
    }
    page.apply(answers, option);
  }
  return { status: "answered", answers, pagesUsed };
}
