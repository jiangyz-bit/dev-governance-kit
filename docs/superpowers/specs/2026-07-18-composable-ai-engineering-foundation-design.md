# 组合式 AI 工程技术底座设计

## 1. 背景

`dev-governance-kit` 当前已经具备一组面向 AI 辅助开发的可执行治理模板：

- 后端、管理端和微信小程序的仓库级 `AGENTS.md`。
- API、数据库、本地运行、UI 和发布检查文档。
- 后端统一维护的状态注册表。
- 状态文档生成和一致性检查脚本。
- Java Spring Boot、React 管理端和微信小程序技术栈说明。

`TECH_FRAMEWORK_REFERENCE.md` 补充了更完整的技术无关工程原则，包括分层架构、模块边界、API 契约、迁移、事务、幂等、环境隔离、安全、测试、Agent 工作约束和常见反模式。

两者适合融合，但不能直接拼接为单一长文档。直接合并会产生重复规则、优先级不明确和多份副本漂移，AI Agent 也无法可靠判断哪些内容是通用约束、端职责差异或技术栈特例。

## 2. 目标

将本项目建设为多技术栈、可组合、可验证的 AI 工程技术底座，同时支持两类场景：

1. 对已有项目应用治理规则，不覆盖用户已有修改。
2. 创建新项目时，调用成熟脚手架生成代码工程，再叠加治理规则和验证能力。

底座需要让 AI Agent 能够：

- 识别项目包含哪些可交付组件及其仓库边界。
- 根据端类型和技术栈加载正确规则。
- 确认 API、状态、数据库等跨端事实源的归属。
- 安全地生成或更新仓库级指令和文档。
- 执行与变更类型匹配的最小必要验证。
- 报告冲突、跳过项、验证结果和残余风险。

## 3. 非目标

第一阶段不包含：

- 自研并替代 Spring Initializr、Vite 等成熟工程脚手架。
- 同时支持所有语言、框架和部署平台。
- 引入通用规则 DSL 或复杂插件市场。
- 强制所有项目立即采用 OpenAPI 代码生成。
- 修改具体业务项目的业务代码。
- 将单仓库或多仓库模式固定为唯一选择。

## 4. 设计原则

### 4.1 单一权威来源

每条规则只允许存在一个权威定义：

- 通用工程原则由 `core/rules/` 负责。
- 端职责差异由 `templates/` 负责。
- 框架差异和命令由 `profiles/` 负责。
- 项目组成和所有权由项目清单负责。
- 业务状态由后端项目的状态注册表负责。

其他文件可以引用权威规则，但不得复制后形成第二份可独立修改的定义。

### 4.2 组合优于复制

最终落地内容由以下层次组合：

```text
core rule
  + component template
  + technology profile
  + blueprint/project manifest
  = repository-local agent guidance and checks
```

### 4.3 安全应用

- 默认不覆盖已有文件。
- 写入前生成变更预览。
- 已生成文件必须包含来源和生成标识。
- 重复执行必须幂等。
- 存在冲突时停止处理冲突文件，但继续分析其他文件并输出报告。
- 不执行破坏性 Git 操作。

### 4.4 规则必须可验证

文档约束应尽可能对应自动检查。不能自动检查的规则，应进入 Agent 完成清单或人工审查清单。

### 4.5 渐进支持

治理叠加能力覆盖更多技术栈；官方完整脚手架只维护少量经过持续验证的组合。

## 5. 总体架构

```text
dev-governance-kit/
  core/
    rules/
      architecture.md
      api.md
      database.md
      security.md
      testing.md
      agent-workflow.md

  templates/
    shared/
    server/
    admin/
    client/
    miniprogram/

  profiles/
    backend/
      java-springboot-mybatis/
      go-gin-gorm/
      node-nestjs-prisma/
    frontend/
      react-admin/
      vue-admin/
    client/
      web/
      wechat-miniprogram/

  blueprints/
    java-react-wechat.yaml
    go-vue-web.yaml
    node-react-web.yaml

  schemas/
    governance-kit.schema.json
    profile.schema.json
    blueprint.schema.json

  tooling/
    init/
    apply/
    validate/

  tests/
    fixtures/
    composition/
    idempotency/
```

### 5.1 Core

`core/rules/` 是技术无关规则的唯一权威来源，吸收 `TECH_FRAMEWORK_REFERENCE.md` 的通用内容：

- 架构分层、模块职责和外部 adapter 边界。
- API 契约、DTO、错误结构、兼容性和调用方检查。
- migration、事务、索引、数据兼容和回滚要求。
- 密钥、环境隔离、鉴权、生产保护和敏感信息规则。
- 按变更类型选择测试和验证。
- AI Agent 的读取顺序、影响分析、修改和交付要求。

Core 不包含 Spring、MyBatis、React、微信小程序等框架名称，也不包含业务状态值。

### 5.2 Templates

`templates/` 表达端类型的职责：

- `shared/`：所有仓库共同需要的 Agent 入口、完成定义和通用检查入口。
- `server/`：业务事实源、鉴权、持久化、事务、状态流转和 API 契约职责。
- `admin/`：运营工作流、权限交互、状态展示和后台页面职责。
- `client/`：用户端 API、加载状态、错误恢复和稳定 DTO 消费职责。
- `miniprogram/`：在 `client/` 基础上增加小程序配置、包体、平台权限和公开配置约束。

`miniprogram` 是 `client` 的增量层，而不是完全独立复制一套客户端规则。

### 5.3 Profiles

Profile 只表达某一技术栈如何落实通用规则，包括：

- 适用组件类型。
- 运行时、框架和推荐版本范围。
- 分层目录映射。
- 安装、启动、测试、类型检查、构建和 migration 命令。
- 需要读取或生成的技术栈专属文件。
- 兼容和互斥条件。
- Profile 专属验证器。

每个 Profile 包含说明文档和机器可读的 `profile.yaml`。Profile 不得重新定义 Core 中已有的规则。

示例：

```yaml
id: java-springboot-mybatis
version: 1
componentTypes:
  - server
commands:
  test: mvn test
  build: mvn package
  migration: mvn flyway:migrate
capabilities:
  migration: flyway
  dataAccess: mybatis
compatibleWith:
  java: ">=21"
```

### 5.4 Blueprints

Blueprint 是经过维护和验证的组件组合，不负责定义规则。

```yaml
id: java-react-wechat
version: 1
components:
  server:
    profile: java-springboot-mybatis
  admin:
    profile: react-admin
  client:
    profile: wechat-miniprogram
defaults:
  repositoryMode: multi-repo
contracts:
  statusRegistryOwner: server
  apiContractOwner: server
```

Blueprint 可以覆盖合理默认值，但不能覆盖 Core 的硬性安全规则。

### 5.5 Tooling

工具分为三个稳定入口：

- `init`：创建新项目。调用上游脚手架后执行 `apply` 和 `validate`。
- `apply`：给新项目或已有项目叠加治理文件。
- `validate`：检查项目清单、规则组合、占位符、生成物和项目命令。

第一阶段优先交付 `apply` 和 `validate`。`init` 在组合模型稳定后实现。

## 6. 项目清单

每个使用底座的工作区根目录维护 `governance-kit.yaml`：

```yaml
schemaVersion: 1

project:
  name: example-product
  repositoryMode: multi-repo

components:
  server:
    profile: java-springboot-mybatis
    path: example-server
  admin:
    profile: react-admin
    path: example-admin
  client:
    profile: wechat-miniprogram
    path: example-miniprogram

contracts:
  statusRegistryOwner: server
  apiContractOwner: server

generation:
  conflictPolicy: report
```

### 6.1 字段语义

- `schemaVersion`：清单格式版本，用于兼容性检查。
- `project.repositoryMode`：允许 `monorepo` 或 `multi-repo`。
- `components.*.profile`：选择组件使用的 Profile。
- `components.*.path`：相对工作区根目录的组件路径。
- `contracts.statusRegistryOwner`：业务状态注册表的唯一所有者。
- `contracts.apiContractOwner`：API 契约的主要所有者。
- `generation.conflictPolicy`：第一阶段固定支持 `report`，表示不覆盖冲突文件并生成报告。

多仓库模式下，每个组件可以拥有独立 `.git`；工具不得假设工作区根目录本身是 Git 仓库。

## 7. 规则优先级与冲突处理

规则从高到低排序：

1. 安全和不可破坏性硬规则。
2. Core 通用规则。
3. Component Template 端职责规则。
4. Profile 技术栈规则。
5. Blueprint 默认值。
6. 项目清单中的合法项目级配置。

低优先级层不能关闭高优先级硬规则。发生以下情况时必须报错：

- Profile 与组件类型不兼容。
- 两个被选 Profile 声明互斥能力。
- 状态注册表或 API 契约配置了不存在的所有者。
- 多个组件同时声明同一跨端事实源的所有权。
- 生成目标仍存在未解析占位符。
- 目标路径逃逸出工作区。

文件冲突分三类：

- 未存在：可以生成。
- 工具生成且来源版本匹配：可以幂等更新。
- 工具生成但来源版本不匹配：不得直接更新，先执行对应版本迁移；不存在迁移路径时按冲突处理。
- 用户文件或来源不明：不得覆盖，输出建议合并内容和冲突报告。

## 8. AGENTS.md 生成策略

仓库级 `AGENTS.md` 保持简洁，只包含：

- 仓库职责和技术栈摘要。
- 必读文件及触发条件。
- 不可违反的硬规则。
- 由 Profile 提供的常用命令。
- 完成定义。

详细规则保留在 `docs/governance/`，避免 `AGENTS.md` 膨胀。生成文件需要标记：

```text
Generated by dev-governance-kit.
Source manifest: ../governance-kit.yaml
Do not edit generated sections manually.
```

若项目已有 `AGENTS.md`，第一阶段不自动改写，只生成：

- 建议追加的受控片段。
- 来源说明。
- 冲突报告。

后续可以引入明确标记的 managed block，只更新工具负责的区块。

## 9. 状态与 API 契约

### 9.1 状态注册表

保留现有后端权威、客户端生成镜像的模型：

- 后端 `docs/status-enums.json` 是业务状态事实源。
- Markdown 是生成物，不手工编辑。
- 客户端不得引入未注册状态。
- 状态 code 稳定，展示文案允许变化。
- 状态流转由后端 service 层强制执行。

现有状态生成和检查脚本作为首个可执行治理能力保留，并在后续消除 server/admin/miniprogram 之间的重复实现。

### 9.2 API 契约

第一阶段保留文档规则和所有权声明，不强制特定契约格式。

第二阶段支持可选的 OpenAPI Profile 能力：

- 后端生成或维护 OpenAPI。
- 客户端生成类型或 SDK。
- CI 检查破坏性变更。

未启用 OpenAPI 时，API 变更仍必须执行调用方影响检查。

## 10. Agent 工作流

### 10.1 新项目

```text
理解产品需求和交付组件
  -> 选择 Blueprint 或独立 Profiles
  -> 生成 governance-kit.yaml
  -> 校验组合兼容性
  -> 展示目录、命令和文件变更预览
  -> 调用上游脚手架创建代码工程
  -> apply 治理规则
  -> validate 配置和生成物
  -> 执行各组件最小启动、测试和构建验证
  -> 输出交付报告
```

### 10.2 已有项目

```text
检查现有仓库和用户修改
  -> 识别组件、技术栈和仓库模式
  -> 生成候选 governance-kit.yaml
  -> 展示推断结果供确认
  -> dry-run apply
  -> 生成新增、可更新和冲突文件清单
  -> 应用无冲突内容
  -> validate
  -> 输出人工合并项和残余风险
```

Agent 不得仅凭目录名确定技术栈，必须结合构建文件和现有命令验证推断结果。

## 11. 验证设计

### 11.1 静态验证

- 项目清单符合 JSON Schema。
- 所有组件引用的 Profile 存在且兼容。
- 所有模板变量已解析。
- 目标路径位于工作区内。
- 必需文档和脚本存在。
- 生成文件携带来源信息。
- 状态注册表结构、重复 code 和流转目标合法。
- Core、Template 和 Profile 不重复定义受控规则。

### 11.2 行为验证

- 对空 fixture 执行 `apply` 后生成预期结构。
- 对已有文件 fixture 执行时不覆盖用户内容。
- 连续执行两次，第二次不产生额外变更。
- 修改状态源后能生成一致的注册表。
- 非法 Profile 组合必须失败并给出可执行错误。
- 单仓库和多仓库 fixture 均通过。

### 11.3 工程验证

官方 Blueprint 必须在干净目录完成：

- 依赖安装。
- 本地启动或健康检查。
- 最小测试。
- 类型检查（适用时）。
- 构建或打包。
- 治理校验。

无法运行的验证必须在报告中标明原因，不得以静态阅读替代通过结果。

## 12. 错误处理和报告

工具统一输出：

- 已创建文件。
- 已更新的工具托管文件。
- 跳过的用户文件。
- 冲突及建议处理方式。
- 执行的验证命令和结果。
- 未执行验证及原因。
- 残余风险。

错误分级：

- `error`：组合无效、路径不安全、Schema 错误等，停止写入。
- `conflict`：用户文件无法自动合并，跳过该文件。
- `warning`：建议规则缺失但不影响基本应用。
- `info`：创建、复用或无需变更。

写入过程需要先完成所有可预检项目。若中途失败，报告已经写入的文件，不宣称整体成功。

## 13. 现有内容迁移

| 现有内容 | 目标位置或处理方式 |
|---|---|
| `templates/server/AGENTS.md` | 拆分为 shared、server 和 Profile 组合来源 |
| `templates/admin/AGENTS.md` | 拆分为 shared、admin 和 Profile 组合来源 |
| `templates/miniprogram/AGENTS.md` | 拆分为 shared、client、miniprogram 和 Profile |
| 三端 `API_RULES.md` | 通用内容进入 Core，端差异保留在 Template |
| `DATABASE_RULES.md` | 通用部分进入 Core，server 保留职责路由 |
| `LOCAL_RUNBOOK.md` | Template 保留结构，命令由 Profile 注入 |
| `RELEASE_CHECKLIST.md` | 通用完成定义进入 Core，端检查由 Template/Profile 增补 |
| 状态 JSON 和脚本 | 保留能力，抽取共享渲染与验证实现 |
| Profile README | 保留说明，并增加符合 Schema 的 `profile.yaml` |
| `TECH_FRAMEWORK_REFERENCE.md` | 拆入 Core 规则，迁移后保留索引和来源说明 |

迁移期间需要提供兼容窗口：现有模板在新版组合生成器通过等价测试前不删除。

## 14. 分阶段实施

### 阶段一：治理叠加 MVP

- 建立 Core 规则目录。
- 定义项目清单、Profile 和 Blueprint Schema。
- 将现有三个 Profile 转为说明文档加机器配置。
- 实现 dry-run、`apply` 和 `validate`。
- 支持 Java Spring Boot + React Admin + 微信小程序。
- 建立冲突、幂等、占位符和多仓库测试。

### 阶段二：多技术栈扩展

- 增加 Go、Node、Vue 和通用 Web Profile。
- 增加经过验证的 Blueprint。
- 抽取共享状态生成和校验实现。
- 增加规则重复和 Profile 兼容性检查。

### 阶段三：官方脚手架

- 实现 `init`。
- 集成成熟上游脚手架。
- 首批维护两到三个官方可运行组合。
- 增加干净目录端到端构建和启动验证。
- 按需增加 OpenAPI 契约能力。

## 15. 验收标准

阶段一完成需要同时满足：

- 能通过一个清单描述单仓库和多仓库项目。
- 能对空目录生成治理结构。
- 能应用到已有项目且不覆盖来源不明的文件。
- 重复执行不产生额外修改。
- 不允许未解析占位符进入交付结果。
- Java、React 和微信小程序 Profile 通过 Schema 和组合验证。
- 状态注册表生成与检查通过。
- 所有自动化行为有 fixture 覆盖。
- 工具报告包含变更、冲突、验证和风险。
- README 能指导 AI Agent 和开发者完成一次 `apply` 与 `validate`。

阶段三的官方 Blueprint 还必须通过干净目录的依赖安装、最小测试、构建和本地可访问性验证。

## 16. 主要风险与控制

### 16.1 规则重复

风险：Template 和 Profile 复制 Core 内容，导致漂移。

控制：建立规则标识或受控标题检查；评审要求 Profile 只能描述技术栈差异。

### 16.2 生成器破坏现有项目

风险：自动写入覆盖用户规则。

控制：默认 dry-run、来源标记、冲突跳过、路径校验和幂等测试。

### 16.3 技术栈矩阵膨胀

风险：组合数量超过维护能力。

控制：区分“治理兼容 Profile”和“官方可运行 Blueprint”；后者严格限制数量。

### 16.4 文档存在但不可执行

风险：底座退化为规则资料库。

控制：每个阶段都要求对应验证器、fixture 和干净目录验收。

### 16.5 上游脚手架变化

风险：框架升级导致 `init` 失效。

控制：锁定受支持版本范围，定期运行官方 Blueprint 端到端验证，不复制上游脚手架内部实现。

## 17. 决策结论

采用“Core + Template + Profile + Blueprint + Tooling”的五层组合架构。

交付顺序确定为：

1. 先交付安全、幂等、可验证的治理叠加能力。
2. 再扩展多技术栈 Profile 和组合测试。
3. 最后为少量官方组合提供完整脚手架。

该方案保留了现有项目最有价值的状态注册和仓库级 Agent 治理能力，同时将通用技术框架转化为可组合、可执行、可持续扩展的 AI Agent 工程底座。
