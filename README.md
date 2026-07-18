# dev-governance-kit

面向 AI Agent 产品开发的组合式工程治理底座。

本项目把技术无关规则、组件职责、技术栈差异和项目组合拆成独立层，并提供安全、幂等、可验证的 CLI。它既能为已有项目叠加治理能力，也能为新项目准备统一的工程约束。

## 五层架构

- `core/`：技术无关的权威工程规则。
- `templates/`：server、admin、client 等组件职责模板。
- `profiles/`：Java、React、微信小程序等技术栈命令和变量。
- `blueprints/`：经过维护的组件组合。
- `tooling/`：清单加载、组合规划、`apply` 和 `validate`。

状态注册表继续由后端 `docs/status-enums.json` 统一维护；Markdown 注册表是生成物。

## 环境要求

- Node.js 20 或更高版本
- npm

```powershell
npm install
```

本文使用源码调用形式 `node tooling/cli.mjs`。安装或链接 package bin 后，等价命令是 `governance-kit apply` 和 `governance-kit validate`。

## 项目清单

在目标工作区根目录创建 `governance-kit.yaml`：

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

完整字段说明见 [项目清单参考](docs/MANIFEST_REFERENCE.md)。

## 已有项目

先执行 dry-run，查看将创建、更新或跳过的文件：

```powershell
node tooling/cli.mjs apply --workspace C:\Projects\demo --dry-run
```

确认后应用：

```powershell
node tooling/cli.mjs apply --workspace C:\Projects\demo
node tooling/cli.mjs validate --workspace C:\Projects\demo
```

工具默认不覆盖用户文件。已有 `AGENTS.md`、来源不明文件、不同来源版本文件和已有状态源会进入冲突报告，由用户或 Agent 人工合并。

旧版手工模板迁移见 [V1 模板迁移说明](docs/MIGRATION_FROM_V1_TEMPLATES.md)。

## 新项目

第一阶段不替代 Spring Initializr、Vite 或微信开发者工具。先用成熟脚手架创建组件目录，再创建 `governance-kit.yaml`，执行：

```powershell
node tooling/cli.mjs apply --workspace C:\Projects\demo --dry-run
node tooling/cli.mjs apply --workspace C:\Projects\demo
node tooling/cli.mjs validate --workspace C:\Projects\demo
```

完整 `init` 命令属于第三阶段，将在后续接入上游脚手架。

## JSON 输出

自动化和 AI Agent 可以使用稳定 JSON：

```powershell
node tooling/cli.mjs apply --workspace C:\Projects\demo --dry-run --json
node tooling/cli.mjs validate --workspace C:\Projects\demo --json
```

退出码：

- `0`：成功。
- `1`：存在验证错误或文件冲突。
- `2`：CLI 参数错误。

## 当前支持范围

- `java-springboot-mybatis`
- `react-admin`
- `wechat-miniprogram`
- `monorepo`
- `multi-repo`

Go、Node 后端、Vue、OpenAPI 生成和完整项目脚手架不在第一阶段范围内。

## 状态工作流

后端修改 `docs/status-enums.json` 后，在各组件仓库运行：

```powershell
node scripts/generate-status-registry.mjs
node scripts/check-status-registry.mjs
```

非相邻仓库通过 `SERVER_REPO_DIR` 指定后端目录。

## 开发验证

```powershell
npm ci
npm test
npm audit
node tooling/cli.mjs --help
```
