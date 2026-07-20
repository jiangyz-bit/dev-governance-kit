# dev-governance-kit

给已有项目接入工程治理，让 AI Agent 开发时先读懂统一规则，再修改代码。

它会识别项目里的 Java 后端、React 管理后台和微信小程序，生成 `AGENTS.md`、接口与数据库规则、测试说明和自动检查脚本。你不需要先理解 Profile、Schema 或仓库模式。

## 我该用 `init` 还是 `create`

| 你的情况 | 使用方式 | 当前状态 |
|---|---|---|
| 已经有项目，想加入 AI 开发规则 | `init` | 可用，推荐 |
| 还没有项目，想从空目录创建完整项目 | `create` | 规划中，尚未实现 |

现在请使用 `init`。`create` 只是未来规划，本 README 不提供可执行命令。

## 3 分钟接入已有项目

需要 Node.js 20.3 或更高版本，以及 npm。Windows、macOS、Linux 都可以使用。

打开终端，进入你的项目最外层目录，然后执行：

```text
npx dev-governance-kit init
```

工具会先了解项目、展示准备新增或更新的文件，最后询问是否继续。直接回车等于取消；只有输入 `y` 才会写入。

如果项目结构明确，通常只需要确认一次。识别不清时，工具最多用三个简单页面提问；仍不能确定就安全停止，不会猜着写。

## `init` 会做什么、不会做什么

会做：

- 在本机读取项目结构和技术栈，不上传项目内容。
- 先展示完整计划，再让你确认。
- 生成 AI 开发规则、接口、数据库、测试和发布说明。
- 写入完成后自动检查生成结果。
- 重复运行时识别未变化内容，并保护用户自己改过的文件。

不会做：

- 不会修改你的业务代码。
- 不会覆盖来源不明或由你维护的文件。
- 不会执行 `git init`、`git commit`、`git push`。
- 不会提交、回滚或清理 Git 工作区；未提交修改只会提示。
- 不会安装数据库、框架或业务依赖。

## 常用命令

只看计划，不写文件：

```text
npx dev-governance-kit init --dry-run
```

确认计划无误后，跳过最后的人工确认并正式执行：

```text
npx dev-governance-kit init --yes
```

已有 `governance-kit.yaml` 时，`init` 默认沿用并检查它。只有想重新识别项目并预览配置差异时才使用：

```text
npx dev-governance-kit init --reconfigure
```

也可以指定其他项目目录：

```text
npx dev-governance-kit init --workspace "C:\Projects\demo"
```

macOS 和 Linux 示例：

```text
cd ~/Projects/demo
npx dev-governance-kit init
```

## 冲突或失败怎么办

发现已有用户文件、来源版本不一致或目录不安全时，`init` 会在写入前整体停止，并列出需要处理的文件。先不要删除原文件，可以让 AI Agent 比较内容并提出合并方案。

如果写入过程中被中断或失败，工具会列出本次已写入的文件和恢复建议。它不会自动删除文件或执行 Git 回滚。请先保留现场，再运行：

```text
npx dev-governance-kit init --verbose
```

如果你在失败后编辑过生成文件，工具会保护这些修改并报告冲突。

## 交给 AI Agent

先让 Agent 只预演：

```text
npx --yes dev-governance-kit@0.1.0 init --dry-run --json
```

确认 Agent 报告的组件、文件和冲突无误后再执行：

```text
npx --yes dev-governance-kit@0.1.0 init --yes --json
```

两个 `--yes` 含义不同：

- `npx --yes`：允许 npx 下载这个 npm 包，不再询问安装。
- `init --yes`：确认已经明确且无冲突的治理计划，可以写入。

`--json` 会只输出一个 JSON 文档，适合 AI Agent 或 CI 读取。JSON/非交互环境不会弹出问题；如果信息不足，会返回 `needs_input`，不会替你猜答案。

可以给 AI Agent 这段任务：

> 使用 dev-governance-kit 给当前已有项目接入工程治理。先运行 init --dry-run --json，只报告识别结果、计划和冲突，不写文件。确认无误后再运行 init --yes --json，随后读取各组件的 AGENTS.md，并说明验证结果与剩余风险。不要覆盖用户文件，不要提交或回滚 Git。

## 当前支持

| 项目部分 | 技术范围 |
|---|---|
| 后端服务 | Spring Boot + MyBatis |
| 管理后台 | React + Vite + TypeScript |
| 客户端 | 微信小程序 |

支持单仓库和多个独立仓库组合。其他技术栈会明确提示暂不支持。

完整配置字段见 [governance-kit.yaml 参考文档](https://github.com/jiangyz-bit/dev-governance-kit/blob/main/docs/MANIFEST_REFERENCE.md)。

macOS 受支持；但首次发布候选版的 MacBook M5 尚未完成实机验收（验收必须复用
同一 artifact），因此当前状态仅为待验收。发布前操作见
[MacBook M5 发布候选版实机验收](https://github.com/jiangyz-bit/dev-governance-kit/blob/main/docs/MACOS_RELEASE_TEST.md)。

## 从源码参与开发

下面的命令只适合维护本工具，不是普通用户的安装步骤：

```text
git clone https://github.com/jiangyz-bit/dev-governance-kit.git
cd dev-governance-kit
npm ci
npm test
node tooling/cli.mjs --help
```

项目采用 [MIT License](LICENSE)。你可以用于个人或商业项目，也可以修改和分发；需保留原版权与许可声明。软件按原样提供，不附带担保。
