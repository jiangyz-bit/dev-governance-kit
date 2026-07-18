# README 中文信息架构优化设计

## 1. 目标

将根目录 `README.md` 重写为开发者和 AI Agent 都能快速理解的中文入口。

用户阅读后应能在 3 分钟内回答：

- 这个项目解决什么问题。
- 当前是否适合自己的项目。
- 需要准备什么文件。
- 应按什么顺序执行命令。
- 工具会创建什么，以及不会覆盖什么。
- 如何让 AI Agent 自动完成接入。

## 2. 首要读者

README 同时服务两类读者：

1. 普通开发者：优先看到用途、快速开始和安全边界。
2. AI Agent 使用者：在主流程之后获得可直接复制的任务提示词。

第一屏优先保证普通开发者能看懂，不用内部架构术语作为开场。

## 3. 信息架构

README 按以下顺序组织：

1. 项目名称和一句话定位。
2. “它能解决什么问题”：用三到五条结果导向描述说明价值。
3. “3 分钟快速开始”：
   - 安装依赖。
   - 创建最小可用 `governance-kit.yaml`。
   - 执行 dry-run。
   - 执行 apply。
   - 执行 validate。
4. “执行后会得到什么”：展示生成文件的简化目录。
5. “已有项目是否安全”：解释用户文件、create-only 文件、版本冲突和 dry-run。
6. “交给 AI Agent 使用”：提供一段可复制的中文提示词。
7. “当前支持范围”：只陈述当前已实现能力。
8. “工作原理”：用一小段概括 Core、Template、Profile、Blueprint 和 Tooling。
9. “进阶文档”和“项目开发验证”。

## 4. 删除和迁移

从 README 删除：

- V1 模板迁移入口。
- 第一阶段、第二阶段、第三阶段等内部路线图。
- “已有项目”和“新项目”之间重复的命令。
- 开篇的五层架构介绍。
- 状态脚本的详细操作流程。
- 过细的 CLI 退出码和内部实现说明。

保留但下沉：

- 完整 Schema 字段继续放在 `docs/MANIFEST_REFERENCE.md`。
- 五层组合方式缩为 README 底部“工作原理”。
- `docs/MIGRATION_FROM_V1_TEMPLATES.md` 暂时保留在仓库，但不再从 README 主入口链接。

## 5. 快速开始边界

快速开始使用当前真实可运行方式：

```powershell
npm install
node tooling/cli.mjs apply --workspace C:\Projects\demo --dry-run
node tooling/cli.mjs apply --workspace C:\Projects\demo
node tooling/cli.mjs validate --workspace C:\Projects\demo
```

README 不宣传尚未实现的 `init`、远程安装或包发布方式。

示例清单继续使用当前完整的 Java + React Admin + 微信小程序多仓库组合，避免示例与 Schema 或测试脱节。

## 6. AI Agent 提示词

提示词必须要求 Agent：

- 先识别组件、技术栈和仓库边界。
- 创建或检查 `governance-kit.yaml`。
- 先执行 dry-run 并报告冲突。
- 未经确认不覆盖用户文件。
- 确认后执行 apply、validate 和项目自身测试。
- 最终报告修改、验证结果和残余风险。

## 7. 写作要求

- 中文为主体，命令、路径、Profile ID、Schema 字段和错误码保留英文。
- 优先使用用户结果语言，减少“组合式”“权威来源”等抽象术语。
- 不重复同一组命令。
- 每个章节只回答一个主要问题。
- 示例必须可复制，不使用未实现命令。
- README 控制在约 150 行以内。

## 8. 验证标准

- README 包含“它能解决什么问题”“3 分钟快速开始”“执行后会得到什么”“交给 AI Agent 使用”。
- 包含 `npm install`、dry-run、apply 和 validate 的真实命令。
- 包含完整且符合当前 Schema 的 `governance-kit.yaml` 示例。
- 不再包含 `V1`、`第一阶段`、`第二阶段`、`第三阶段` 或 `init` 路线图叙述。
- 不再链接 `docs/MIGRATION_FROM_V1_TEMPLATES.md`。
- 不存在 TODO、TBD 或 `{{...}}` 占位符。
- `npm test` 全部通过。
- Markdown 无空白错误，文件使用 UTF-8。
