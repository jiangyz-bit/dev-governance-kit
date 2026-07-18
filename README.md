# dev-governance-kit

让 AI Agent 按统一工程规则开发项目，而不是每次从零猜测目录、状态、API、数据库和发布要求。

它可以把 `AGENTS.md`、工程规则、状态注册表和验证脚本安全地接入单仓库或多仓库项目。

## 它能解决什么问题

- 给 AI Agent 一套明确、可执行的项目规则，减少随意分层和无关重构。
- 统一后端、管理端和客户端对 API、状态、权限及数据库的理解。
- 自动生成仓库内的治理文档和检查脚本，避免只靠口头约定。
- 接入已有项目时先预览冲突，不直接覆盖用户文件。
- 重复执行结果一致，并能检查占位符、配置和状态注册表是否漂移。

## 3 分钟快速开始

### 1. 安装

需要 Node.js 20 或更高版本。

```powershell
git clone https://github.com/jiangyz-bit/dev-governance-kit.git
cd dev-governance-kit
npm install
```

### 2. 描述你的项目

在产品工作区根目录创建 `governance-kit.yaml`：

```yaml
schemaVersion: 1
project:
  name: demo
  repositoryMode: multi-repo
components:
  server:
    profile: java-springboot-mybatis
    path: demo-server
  admin:
    profile: react-admin
    path: demo-admin
  client:
    profile: wechat-miniprogram
    path: demo-miniprogram
contracts:
  statusRegistryOwner: server
  apiContractOwner: server
generation:
  conflictPolicy: report
```

对应目录：

```text
demo/
  governance-kit.yaml
  demo-server/
  demo-admin/
  demo-miniprogram/
```

### 3. 先预览，再应用

```powershell
node tooling/cli.mjs apply --workspace C:\Projects\demo --dry-run
node tooling/cli.mjs apply --workspace C:\Projects\demo
```

### 4. 验证

```powershell
node tooling/cli.mjs validate --workspace C:\Projects\demo
```

安装或链接 package bin 后，也可以使用 `governance-kit apply` 和 `governance-kit validate`。

## 执行后会得到什么

每个组件会按职责获得对应文件，例如：

```text
demo-server/
  AGENTS.md
  docs/
    governance/
    API_RULES.md
    DATABASE_RULES.md
    LOCAL_RUNBOOK.md
    RELEASE_CHECKLIST.md
    status-enums.json
    STATUS_ENUM_REGISTRY.md
  scripts/

demo-admin/
  AGENTS.md
  docs/
  scripts/

demo-miniprogram/
  AGENTS.md
  docs/
  scripts/
```

后端负责业务事实、API 契约和状态注册表；前端和客户端使用后端定义的稳定状态 code。

## 已有项目是否安全

安全。工具默认使用 `report` 冲突策略：

| 情况 | 处理方式 |
|---|---|
| 文件不存在 | 创建 |
| 工具托管且版本一致 | 安全更新 |
| 内容没有变化 | 跳过 |
| 用户文件或来源不明 | 报告冲突，不覆盖 |
| 已有 `status-enums.json` | 保留并报告，不覆盖业务状态 |
| 来源版本不一致 | 停止更新该文件并报告 |

建议始终先运行 `--dry-run`。存在冲突时，先人工确认或让 Agent 给出合并建议，再执行正式应用。

## 交给 AI Agent 使用

可以直接复制下面这段提示词：

> 使用 dev-governance-kit 给当前项目接入工程治理。先读取 README、当前 AGENTS.md 和相关 docs，识别组件、技术栈、Git 仓库边界以及真实启动/测试命令。创建或检查 governance-kit.yaml，先执行 apply --dry-run，并向我报告将创建的文件和全部冲突。不要覆盖用户文件。确认无误后执行 apply、validate 和项目自身测试，最后说明修改内容、验证结果与剩余风险。

Agent 需要把 `--workspace` 指向产品工作区，而不是本工具仓库。

## 当前支持范围

| 组件 | Profile |
|---|---|
| Java 后端 | `java-springboot-mybatis` |
| React 管理端 | `react-admin` |
| 微信小程序 | `wechat-miniprogram` |

支持 `monorepo` 和 `multi-repo`。多仓库模式下，工作区根目录不需要是 Git 仓库，各组件可以维护独立 `.git`。

## 工作原理

Core 定义通用工程规则，Template 定义组件职责，Profile 提供技术栈命令和变量，Blueprint 描述推荐组合，Tooling 负责安全应用和验证。每条规则只保留一个权威来源，再生成到具体项目中。

## 进阶文档

- [governance-kit.yaml 字段说明](docs/MANIFEST_REFERENCE.md)
- [组合式 AI 工程技术底座设计](docs/superpowers/specs/2026-07-18-composable-ai-engineering-foundation-design.md)

## 项目开发验证

```powershell
npm ci
npm test
npm audit
node tooling/cli.mjs --help
```
