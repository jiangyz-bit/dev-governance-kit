# dev-governance-kit 引导式初始化与 npm 首发设计

日期：2026-07-19  
状态：已完成用户确认，等待书面设计复核

## 1. 背景

`dev-governance-kit` 已经具备 `apply`、`validate`、项目清单、三类 Profile、冲突保护和自动化测试，但普通用户仍需：

1. 克隆工具仓库。
2. 手工编写 `governance-kit.yaml`。
3. 使用源码路径执行 CLI。
4. 理解 Profile、组件所有者和仓库模式等内部概念。

下一阶段的目标不是优先增加更多技术栈，而是把当前能力变成可公开安装、可安全初始化、对无开发经验用户友好的 npm CLI。

## 2. 目标

陌生用户进入一个受支持的已有项目后，只需要执行：

```text
npx dev-governance-kit init
```

工具应当：

1. 自动了解项目结构和技术栈。
2. 只询问无法可靠判断的信息。
3. 使用普通中文解释识别结果。
4. 在内存中生成配置和完整变更计划。
5. 确认前不修改目标项目工作区中的任何文件。
6. 有冲突时不修改目标项目工作区。
7. 用户明确确认后应用治理规则并自动验证。
8. 在 Windows、macOS 和 Linux 上保持一致行为。

标准支持项目中，普通用户最多经过三个简单交互页面并确认一次，应在 5 分钟内完成治理接入。

## 3. 命令职责

### 3.1 `init`

`init` 用于给已有业务项目初始化工程治理，不创建 Spring Boot、React 或微信小程序源码。

```text
npx dev-governance-kit init
```

### 3.2 `create`

`create` 保留给未来“从空目录创建完整业务项目”的能力。

```text
npx dev-governance-kit create
```

本阶段不实现 `create`。README 需要解释它与 `init` 的使用场景，但必须明确标记为“规划能力，尚未实现”，不能放入可复制执行的快速开始命令，CLI 帮助也不能将其显示为可用命令。

## 4. 方案选择

本阶段采用“证据驱动的引导式初始化”：

- 不采用完全手工填写向导，因为它仍要求用户理解内部模型。
- 不采用大模型自动分析，因为它会引入网络、费用、隐私和不确定性。
- 采用本地确定性扫描、证据和置信度模型，只对歧义进行交互确认。

识别不确定时宁可询问或停止，不能为了自动完成而静默猜测。

## 5. 总体架构

`init` 由七个边界清晰的模块组成。

### 5.1 Scanner

只读扫描工作区，收集项目标志文件、依赖文件和 Git 边界。

要求：

- 跳过 `.git`、`node_modules`、`target`、`dist`、`build`、`.next`、`coverage`、`vendor`。
- 默认最多扫描工作区下 4 层目录、10,000 个目录项和 10 秒；任一上限触发后停止继续扩展。
- 不跟随符号链接或 Windows junction。
- 扫描被截断时返回明确警告，并将识别结果标记为不完整，不能直接进入自动写入。

### 5.2 Detector

根据扫描证据生成组件候选。每个候选在内部包含：

- 相对路径。
- 推断的组件角色。
- Profile。
- 识别证据。
- 置信度。
- 兼容性警告。

### 5.3 Resolver

解决多个候选、低置信度、混合 Git 结构和契约所有者歧义。

交互模式下使用普通中文提问；无 TTY、`--json` 或 CI 环境下不等待输入，而是返回机器可读的 `NEEDS_INPUT`。

### 5.4 Manifest Builder

在内存中生成候选 `governance-kit.yaml`，随后立即执行现有 Schema 和跨字段兼容性校验。

确认前不能为了复用现有 `apply` 而把临时 Manifest 写入工作区。

### 5.5 Init Planner

使用候选 Manifest 生成完整治理文件计划，同时计算：

- 将创建的文件。
- 将更新的工具托管文件。
- 内容未变化的文件。
- 用户文件和来源版本冲突。

Manifest 按以下状态参与预览：

- 不存在：作为 `create-only` 计划项创建。
- 已存在且默认执行 `init`：校验并使用现有配置，不参与创建冲突。
- 已存在且无效：停止并报告，不覆盖。
- 使用 `--reconfigure` 且候选内容相同：记为 `unchanged`。
- 使用 `--reconfigure` 且候选内容不同：展示配置 diff；只有用户明确确认后才允许原子更新这一个用户配置文件。

### 5.6 Presenter

默认输出面向无开发经验用户，只解释：

- 找到了哪些项目组成部分。
- 每个部分的用途。
- 将添加什么。
- 不会修改什么。
- 是否存在需要处理的问题。

技术细节通过 `--verbose` 展示，稳定结构化结果通过 `--json` 输出。

### 5.7 Executor

只有以下条件全部满足时才执行：

1. 项目结构不存在未解决歧义。
2. Manifest 校验通过。
3. 所有路径和链接边界检查通过。
4. 所有模板能够完整渲染。
5. 不存在任何用户文件或来源版本冲突。
6. 用户明确确认，或非交互模式传入 `--yes`。

执行顺序：

1. 重新核对预览时记录的 Manifest 和全部目标文件状态及内容哈希。
2. 任一状态发生变化时立即停止，不修改目标项目工作区。
3. 原子创建或更新 `governance-kit.yaml`。
4. 直接执行内存中已经确认的治理文件计划，不重新读取 Manifest 或重新规划。
5. 应用已预检的治理文件计划。
6. 执行 `validate`。
7. 输出应用结果、验证结果和后续建议。

## 6. 完整数据流

```text
环境和路径预检查
→ 读取已有 Manifest
   ├─ 已有有效 Manifest
   │  → 校验组件真实目录、项目证据和安全边界
   │  → 使用现有配置生成计划
   └─ 没有 Manifest 或使用 --reconfigure
      → 安全扫描项目
      → 识别组件与 Git 边界
      → 处理歧义
      → 内存生成候选 Manifest
      → Schema 与兼容性校验
→ 完整变更预演
→ 冲突和写入条件检查
→ 小白用户预览
→ 用户确认
→ 重查目标文件状态
→ 执行已确认的内存计划
→ 自动 validate
→ 输出结果
```

已有有效 Manifest 时默认直接使用，不重新识别技术栈，但必须验证每个组件路径真实存在、是目录、位于工作区内，并具有与所选 Profile 基本一致的项目证据。`init` 不创建业务组件目录。只有显式使用 `--reconfigure` 才重新扫描、生成候选配置并展示配置差异。

## 7. 识别规则

第一版只自动识别当前已经存在的三个 Profile。

### 7.1 Java 后端

高置信度证据：

- 存在 `pom.xml`。
- 存在 Spring Boot 依赖。
- 存在 MyBatis 依赖。

Java 版本、Flyway 或 Maven 配置与 Profile 假设不完全匹配时显示兼容性警告并要求确认。Gradle、纯 Spring、JPA 或其他数据访问方案不能自动分配 `java-springboot-mybatis`。

### 7.2 React 管理端

识别证据：

- `package.json` 中存在 React。
- 存在 Vite 依赖或脚本。
- 存在 TypeScript 配置。
- 目录名称包含 `admin`、`console`、`dashboard` 等辅助信号。

React 只能证明网页技术栈，不能证明它是管理后台。角色证据不足时必须询问。

### 7.3 微信小程序

高置信度证据：

- `project.config.json`。
- `app.json`。
- `miniprogramRoot` 或其他微信小程序配置。

### 7.4 仓库模式

- 所有组件属于同一 Git 根目录：建议 `monorepo`。
- 组件分别属于不同 Git 根目录：建议 `multi-repo`。
- 工作区无 Git、组件各自有 Git：建议 `multi-repo`。
- 根仓库中存在嵌套 Git：视为混合结构，必须询问。

识别过程只读取 Git 边界，不能执行 `git init`、修改 `.gitignore`、提交或推送。

### 7.5 不支持和歧义

以下情况不能静默映射：

- 多个 Java 服务竞争 `server`。
- 多个 React 项目竞争 `admin`。
- React 普通用户端可能被误判为管理后台。
- Next.js、Vue、Go、Node.js 后端等尚无 Profile。
- 当前组件模型无法表达多个同类型服务。

交互模式允许用户从候选目录中选择。非交互模式返回 `NEEDS_INPUT` 或 `UNSUPPORTED_PROFILE`。

空目录返回 `NO_PROJECT_FOUND`，没有任何受支持组件的已有项目返回 `UNSUPPORTED_PROJECT`。两种情况均不修改工作区，并用普通中文说明 `init` 适用于已有项目；可以提到未来的 `create`，但必须明确它尚未实现。

## 8. 小白用户体验

### 8.1 默认识别结果

```text
正在了解你的项目……

✓ 找到后端服务
  目录：demo-server
  用途：处理业务、数据和接口

✓ 找到管理后台
  目录：demo-admin
  用途：供管理员在电脑上管理业务

✓ 找到微信小程序
  目录：demo-miniprogram
  用途：提供给最终用户使用

✓ 项目组织方式
  这三个部分分别保存在独立目录中

没有修改任何文件。
```

默认不显示 Profile、repositoryMode、置信度和契约所有者等术语。

### 8.2 歧义提问

```text
发现两个网页项目：

1. demo-admin
2. demo-web

哪一个是管理员使用的后台？

[1] demo-admin
[2] demo-web
[3] 都不是
[4] 我不确定
```

选择“我不确定”时解释如何判断，并允许安全退出或把结果交给 AI Agent。

“最多回答三个问题”定义为最多三个交互页面，而不是最多三个字段。一个页面可以集中确认多个低风险推断；如果安全相关歧义无法在三个页面内明确解决，则停止并建议用户交给 AI Agent 分析，不能为了减少问题而自动猜测。

### 8.3 写入前预览

```text
准备完成项目治理配置

将会：
✓ 为 3 个项目添加 AI 开发规则
✓ 添加接口、数据库和测试说明
✓ 添加自动检查脚本
✓ 创建 governance-kit.yaml

不会：
✓ 不会修改你的业务代码
✓ 不会覆盖你自己维护的文件
✓ 不会提交或推送 Git
✓ 不会上传项目内容

预计新增 31 个文件，修改 0 个已有文件。

是否继续？(y/N)
```

确认默认值必须为 `N`。

预览同时显示检测到的 Git 仓库是否存在未提交修改，并明确工具不会提交、回滚或清理 Git；脏工作区仅提示，不作为初始化阻塞条件。

重复初始化或版本升级时，如果计划更新由 `dev-governance-kit` 管理的已有规则文件，预览必须单独列出更新数量和相对路径。使用 `--reconfigure` 更新 Manifest 时也必须单独披露，不能用“不会覆盖已有文件”笼统描述。

### 8.4 冲突提示

默认输出使用“发现已有文件，为避免覆盖所以没有修改”的普通中文，并显示阻塞文件相对于工作区的路径，例如 `demo-server/AGENTS.md`。默认不直接暴露 `USER_FILE_CONFLICT` 等内部错误码；`--verbose` 和 `--json` 保留错误码与绝对路径。

### 8.5 完成提示

完成后说明：

- 已识别多少项目组成部分。
- 已添加哪些治理能力。
- 是否更新工具管理的规则文件。
- 是否覆盖用户自己维护的文件。
- 是否修改业务代码。
- 验证是否通过。
- AI Agent 下一步应先阅读哪些 `AGENTS.md`。

## 9. CLI 协议

### 9.1 参数

```text
init
  --workspace <path>  指定项目工作区
  --dry-run           只查看计划，不写入
  --yes               确认无歧义、无冲突的计划
  --verbose           显示技术细节
  --json              输出机器可读结果
  --reconfigure       重新识别已有配置
```

普通用户：

```text
npx dev-governance-kit init
```

AI Agent 预演：

```text
npx --yes dev-governance-kit@0.1.0 init --dry-run --json
```

AI Agent 执行：

```text
npx --yes dev-governance-kit@0.1.0 init --yes --json
```

前一个 `--yes` 属于 npx，后一个 `--yes` 属于 `init`。使用文档必须解释二者区别。

### 9.2 JSON

`--json` 时 stdout 只能包含一个合法 JSON 文档，提示和诊断信息不能混入。基础结构：

```json
{
  "command": "init",
  "workspace": "C:/Projects/demo",
  "ok": false,
  "status": "needs_input",
  "detected": [],
  "questions": [],
  "plan": null,
  "report": null
}
```

`--yes` 只能确认已明确的计划，不能替用户回答技术栈或组件角色歧义。

`status` 固定使用以下值：

- `planned`：dry-run 计划完整且无冲突。
- `applied`：已写入且验证通过。
- `cancelled`：用户明确选择不继续。
- `needs_input`：仍有必须由用户回答的歧义。
- `conflict`：计划发现文件冲突。
- `unsupported`：空目录或不支持的项目。
- `partial_failure`：执行开始后发生部分写入失败。
- `failed_validation`：已应用但最终验证失败。
- `interrupted`：收到 `Ctrl+C`。

正常业务结果的 stderr 必须为空，包括 `needs_input`、`conflict` 和 `cancelled`；只有 CLI 尚无法构造结构化结果的启动级故障允许写入 stderr。

### 9.3 退出码

| 退出码 | 含义 |
|---:|---|
| `0` | 应用成功、无冲突 dry-run 成功，或用户明确选择不继续 |
| `1` | 识别不清、存在冲突、写入失败或验证失败 |
| `2` | 命令参数错误 |
| `130` | 用户通过 `Ctrl+C` 取消 |

用户在确认阶段明确输入 `N` 时返回 `0`，结果为 `ok: true`、`status: "cancelled"`、`applied: false`。EOF、无 TTY 且缺少必要输入时返回 `1` 和 `status: "needs_input"`。

无歧义、无冲突的 dry-run 返回 `0`；发现歧义或冲突的 dry-run 返回 `1`。无论退出码如何，dry-run 都不得修改目标项目工作区。

## 10. 安全与错误恢复

### 10.1 零写入门槛

以下任一情况发生时，`init` 默认不修改目标项目工作区：

- 用户尚未确认。
- 用户取消。
- 存在未解决歧义。
- Manifest 无效。
- 路径逃逸或链接边界无法确认。
- 模板无法完整渲染。
- 存在 `USER_FILE_CONFLICT`。
- 存在 `CREATE_ONLY_EXISTS`。
- 存在 `SOURCE_VERSION_MISMATCH`。
- 写入权限预检失败。
- 用户确认后、实际写入前发现目标文件状态或内容哈希发生变化。

现有 `apply` 的部分应用语义可以保持兼容，但必须在文档中与 `init` 的整体停止语义区分。

### 10.2 路径保护

除现有字符串路径边界外，还需要校验真实路径：

- 不允许组件根目录通过 symlink 或 junction 指向工作区外。
- 扫描不跟随链接。
- 对不存在的目标文件，从最近存在的父目录验证真实路径边界。
- Windows 路径比较处理大小写差异。

### 10.3 写入失败

跨多个目录和仓库无法实现真正的整体文件系统事务，因此不宣称全局原子性。

要求：

- 写入前完成全部可执行预检。
- 每个文件使用唯一临时文件和原子替换。
- 记录本次成功创建和更新的文件。
- 中途失败时输出恢复清单。
- 不自动删除、覆盖或 Git reset 用户内容。
- 自动验证失败时保留生成结果，并报告 `applied: true, valid: false`。
- `Ctrl+C` 清理临时文件并返回 `130`。

执行阶段发生可捕获的部分失败时，JSON 至少包含：

```json
{
  "ok": false,
  "status": "partial_failure",
  "applied": true,
  "valid": false,
  "written": [],
  "failed": {},
  "recovery": {
    "safeToRerun": true,
    "nextCommand": "npx dev-governance-kit init --verbose"
  }
}
```

第一版不在工作区持久化事务日志。发生进程崩溃或断电后，用户重新执行 `init`；工具通过托管文件元数据和重新预演识别已完成与未完成项。端到端测试必须验证这种重跑可以安全恢复，不能承诺硬崩溃后的自动回滚。

## 11. 测试设计

### 11.1 识别器单元测试

覆盖：

- 三个受支持 Profile 的完整、部分和错误证据。
- 项目名称推断。
- 单组件和任意受支持组件组合。
- 只包含 admin 或 client 时必填契约所有者的确定性选择。
- monorepo、multi-repo 和混合 Git 结构。
- 多候选、低置信度和不支持技术栈。
- 中文、空格、括号、大小写和长路径。
- `.git` 目录和 worktree `.git` 文件。
- 忽略目录、符号链接、junction 和路径逃逸。
- 达到 4 层、10,000 项和 10 秒扫描上限后的截断结果。

### 11.2 初始化计划测试

覆盖：

- 候选 YAML 通过现有 Schema。
- 路径统一为相对路径和 `/` 分隔符。
- 契约所有者必须是实际存在的组件。
- 相同输入生成字节级一致结果。
- 用户选择优先于自动推断。
- 确认前、取消后、探测失败和冲突时目标项目工作区快照不变。

### 11.3 交互和 CLI 黑盒测试

覆盖：

- 只需要最终确认的标准流程。
- 补问组件角色和仓库模式。
- 默认 `N` 和显式取消。
- EOF、无 TTY 和 `Ctrl+C`。
- 默认中文小白输出。
- `--verbose` 技术输出。
- `--json` 单一合法 JSON。
- `--yes` 不绕过歧义。
- 退出码 `0`、`1`、`2`、`130`。
- 显式 `N`、EOF 和启动级错误的状态及 stdout/stderr 协议。
- 预览后目标文件被其他进程修改时停止写入。

### 11.4 端到端测试

覆盖：

- 标准三组件 monorepo。
- 三个独立仓库组成的 multi-repo。
- 已存在有效和无效 Manifest。
- 已存在用户 `AGENTS.md`。
- 已存在业务 `status-enums.json`。
- 初始化后直接 `validate`。
- 连续两次运行完全幂等。
- 写入中途失败的恢复清单和安全重跑。

现有测试已经证明 monorepo 和 multi-repo 可以在 `apply` 后直接 `validate`。状态注册表生成脚本保留独立烟测，不作为 `init` 必须额外执行的步骤。

### 11.5 真实 npm tarball 测试

CI 必须：

1. 使用 `npm pack --json --pack-destination <temp-dir>` 生成可确定定位的 `.tgz`。
2. 在全新临时目录安装生成的 `.tgz`。
3. 从源码仓库之外执行：

   ```text
   npm exec --offline --yes --package <absolute-tarball-path> -- governance-kit init
   ```

4. 再执行打包后的 `validate`。
5. 验证包内包含全部运行时资源。
6. 验证 CLI 报告版本与 tarball `package.json` 完全一致。
7. 验证运行时资源来自解包目录，而不是当前源码仓库。
8. 验证包内严格匹配白名单，且不包含 `tests/` 和 `docs/superpowers/`。
9. 发布完成后再执行真实用户命令：

   ```text
   npx --yes dev-governance-kit@0.1.0 init
   ```

测试系统：

- Windows。
- macOS。
- Linux。

## 12. npm 包设计

包名：

```text
dev-governance-kit
```

npm 维护者账号：

```text
coogle
```

GitHub 仓库仍为：

```text
jiangyz-bit/dev-governance-kit
```

`package.json` 发布前需要：

- 移除 `"private": true`。
- 补充 `description`、`keywords`、`repository`、`homepage`、`bugs` 和 `author`。
- `author` 固定为 `coogle`，`repository.url` 精确指向公开仓库 `https://github.com/jiangyz-bit/dev-governance-kit.git`。
- 增加明确的 `files` 白名单。
- 增加公开 npm registry 的 `publishConfig`。
- 保留 Node.js `>=20` 和现有 `bin`。
- 确保 CLI 在 Unix 系统具有正确 shebang 和可执行权限。

发布白名单：

```text
blueprints/
core/
profiles/
schemas/
templates/
tooling/
docs/MANIFEST_REFERENCE.md
```

`package.json`、README 和 LICENSE 由 npm 自动包含。

## 13. CI 与发布

### 13.1 持续集成

GitHub Actions 至少覆盖：

- Windows + Node.js 20、22、24。
- Ubuntu + Node.js 20、22、24。
- macOS + Node.js 20、22、24。

执行：

```text
npm ci
npm test
npm audit --omit=dev
npm pack
tarball 端到端烟测
```

可以在不降低系统覆盖的前提下拆分单元测试矩阵和 tarball 烟测矩阵，控制 CI 时间。

### 13.2 首次发布

首次公开版本为 `0.1.0`。首次发布由维护者人工完成：

1. 登录 npm 账号 `coogle`。
2. 执行 `npm whoami`，结果必须精确等于 `coogle`。
3. 启用 npm 两步验证。
4. 再次确认 `dev-governance-kit` 包名未被占用。
5. 检查 `private` 已移除、版本为 `0.1.0`、repository URL 精确匹配公开 GitHub 仓库。
6. 通过完整 CI 和本地 tarball 门禁。
7. 执行 npm dry-run。
8. 发布公开包。
9. 验证固定版本的真实 `npx` 命令。
10. 创建 GitHub `v0.1.0` Release。

### 13.3 后续可信发布

首次发布后配置 GitHub Actions Trusted Publishing：

- 使用 GitHub OIDC，不保存长期 npm token。
- 使用 GitHub-hosted `ubuntu-latest` 和 Node.js 24，不使用 release build cache，并显式校验 npm CLI `>=11.5.1`。
- 权限只开放 `contents: read` 和 `id-token: write`。
- npm Trusted Publisher 绑定 GitHub owner `jiangyz-bit`、仓库 `dev-governance-kit` 和固定发布工作流。
- 发布工作流由 GitHub Release `published` 触发；发布前强制校验 Release tag `vX.Y.Z` 与 `package.json.version` 的 `X.Y.Z` 完全一致，并确认 npm 中尚不存在该版本。
- 使用受保护的 GitHub Environment 进行人工审批，并将同一 Environment 名称绑定到 npm Trusted Publisher。
- 增加发布 `concurrency`，同一版本只允许一个发布任务执行。
- npm 维护者 `coogle` 与 GitHub owner 不要求同名。
- 可信发布验证成功后启用“Require 2FA and disallow tokens”，并撤销不再需要的自动化 token。

## 14. MacBook M5 实机验收

macOS 既进入自动 CI，也进入首版人工发布门槛。

在用户的 MacBook M5 上使用临时目录完成：

1. 检查 Apple Silicon 和 Node.js 版本。
2. 从候选 `.tgz` 安装，不依赖源码仓库。
3. 验证 `npx`/npm shim 和 CLI 可执行权限。
4. 运行标准项目的 `init`。
5. 验证默认小白输出、确认和取消。
6. 运行 `validate`。
7. 连续运行两次验证幂等。
8. 验证中文、空格路径和 symlink 越界保护。
9. 删除临时测试目录，不影响用户真实项目。

若后续提供可连接的 Mac 测试环境，主智能体可直接执行；否则提供固定测试命令，由用户运行后回传完整输出。

## 15. 使用文档

README 调整为：

1. 这个工具能解决什么问题。
2. 我应该使用 `init` 还是 `create`。
3. 3 分钟接入已有项目。
4. `init` 会做什么、不会做什么。
5. 已有文件冲突怎么办。
6. 交给 AI Agent 使用。
7. 开发者高级参数。
8. `create` 的规划场景与尚未实现状态。
9. Windows、macOS 和 Linux 示例。
10. 从源码参与开发。

所有快速开始命令必须经过真实 tarball 测试。README 默认面向普通用户，技术术语进入高级参数或独立参考文档。

npm 页面需要访问的参考文档使用 GitHub 绝对链接，避免 npm 页面解析仓库相对路径时产生歧义。

## 16. 子智能体交叉验证

实施阶段采用职责隔离：

- 实现子智能体负责 Scanner、Detector、Resolver 和 Init Planner。
- 测试子智能体只依据本文行为契约编写黑盒与安全测试。
- 审查子智能体只使用 `.tgz`，模拟陌生用户完成 monorepo、multi-repo、冲突和取消流程。
- 主智能体审查所有差异，并在干净环境重新执行完整测试。

子智能体报告不能直接作为完成依据，最终结论必须以主智能体重新验证的证据为准。

## 17. 首版验收标准

### 17.1 发布候选版门槛

进入首次 npm 发布前必须同时满足：

- 本地候选 tarball 通过等价用户入口完成受支持已有项目的治理初始化。
- 普通用户默认看不到必须理解的内部技术术语。
- 最多经过三个简单交互页面并确认一次。
- 确认前、取消后和冲突时不修改目标项目工作区。
- 不覆盖用户文件，不修改 Git 元数据，不上传项目内容。
- `--dry-run --json` 和 `--yes --json` 可供 AI Agent 稳定调用。
- Windows、macOS 和 Linux CI 全部通过。
- 真实 npm tarball 在三个系统上完成端到端烟测。
- MacBook M5 完成发布候选版实机验收。
- npm 包不包含测试 fixture 和内部设计计划。
- README 中所有可复制命令均经过验证。

### 17.2 发布完成门槛

发布候选版门槛通过后，还需满足：

- npm 已公开发布 `dev-governance-kit@0.1.0`。
- 固定版本的真实 `npx` 命令完成公开安装烟测。
- npm 包元数据、文件清单和维护者信息与设计一致。
- GitHub `v0.1.0` Release 已创建且 tag 与包版本一致。
