# 治理叠加 MVP 实施计划

> **面向执行 Agent：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，逐项实施本计划。所有步骤使用复选框（`- [ ]`）跟踪进度。

**目标：** 构建一个安全、幂等的 Node.js CLI，用于验证多技术栈项目清单，并将现有 Java、React Admin 和微信小程序治理层应用到空工作区或已有工作区，同时不覆盖用户拥有的文件。

**架构：** MVP 以 `governance-kit.yaml` 作为工作区入口，以 JSON Schema 作为配置契约，并维护机器可读的 Profile 和 Blueprint 目录。纯规划层负责把 Core 规则、组件模板和 Profile 解析为文件操作；独立的应用层只对新文件或工具托管文件执行原子写入；验证层负责报告配置、占位符、状态注册表和生成文件错误。

**技术栈：** Node.js 20+、ECMAScript modules、npm、`yaml`、`ajv`、Node.js 内置 `node:test`。

## 全局约束

- 第一阶段支持 `java-springboot-mybatis`、`react-admin` 和 `wechat-miniprogram`。
- 必须同时支持 `monorepo` 和 `multi-repo` 工作区布局。
- 不得假设工作区根目录本身是 Git 仓库。
- 默认冲突策略为 `report`；不得覆盖用户拥有或来源不明的文件。
- 所有解析后的目标路径必须位于配置的工作区内部。
- 输入不变时，重复执行 `apply` 不得产生新的修改。
- Core 负责技术无关规则；Template 负责组件职责；Profile 负责技术栈专属命令和映射。
- 后端组件仍是状态注册表的唯一事实源。
- 在组合测试证明生成结果等价之前，保留现有模板。
- 面向人类和 Agent 的说明文档以中文为主体；文件名、命令、代码标识符、Schema 字段和错误码保留英文。
- 本计划不实现 Go、Node 后端、Vue、OpenAPI 生成或完整项目脚手架。

---

## 文件映射

### 运行时与公开入口

- 创建 `package.json`：定义 Node 版本、依赖、CLI bin 和测试脚本。
- 创建 `tooling/cli.mjs`：解析参数并分发 `apply` / `validate` 命令。
- 创建 `tooling/index.mjs`：提供稳定的程序化导出。

### 配置契约与加载

- 创建 `schemas/governance-kit.schema.json`：工作区清单契约。
- 创建 `schemas/profile.schema.json`：Profile 契约。
- 创建 `schemas/blueprint.schema.json`：Blueprint 契约。
- 创建 `tooling/lib/errors.mjs`：稳定错误码和可序列化诊断信息。
- 创建 `tooling/lib/files.mjs`：UTF-8 加载、安全路径解析、哈希和原子写入。
- 创建 `tooling/lib/schema-validator.mjs`：Ajv 编译与验证。
- 创建 `tooling/lib/catalog.mjs`：发现 Profile 和 Blueprint。
- 创建 `tooling/lib/manifest.mjs`：加载清单并检查交叉引用。

### 组合与应用

- 创建 `tooling/lib/template.mjs`：严格渲染 `{{VARIABLE}}` 并检测未解析占位符。
- 创建 `tooling/lib/planner.mjs`：生成无副作用的组合计划。
- 创建 `tooling/lib/apply.mjs`：执行 dry-run、托管文件更新、冲突跳过和报告生成。
- 创建 `tooling/lib/validate.mjs`：编排工作区验证。
- 创建 `tooling/lib/status-registry.mjs`：在 CLI 侧验证状态源并渲染预期 Markdown。

### 治理内容

- 创建 `core/rules/*.md`：从已批准设计迁移技术无关规则。
- 创建 `templates/shared/docs/governance/README.md`：生成的治理索引。
- 创建 `profiles/*/profile.yaml`：三个现有 Profile 的机器可读元数据。
- 创建 `blueprints/java-react-wechat.yaml`：首个受支持的组件组合。
- 兼容窗口内保持现有生成项目的状态脚本不变；共享封装放到第二阶段。

### 测试与 fixture

- 创建 `tests/helpers/workspace.mjs`：隔离的临时工作区辅助函数。
- 创建 `tests/schema-validator.test.mjs`：Schema 和交叉引用测试。
- 创建 `tests/catalog.test.mjs`：目录发现和兼容性测试。
- 创建 `tests/template.test.mjs`：严格渲染测试。
- 创建 `tests/planner.test.mjs`：分层组合和路径安全测试。
- 创建 `tests/apply.test.mjs`：冲突和幂等性测试。
- 创建 `tests/status-registry.test.mjs`：状态验证和渲染测试。
- 创建 `tests/cli.test.mjs`：CLI 端到端测试。
- 创建 `tests/fixtures/monorepo/governance-kit.yaml`：monorepo fixture。
- 创建 `tests/fixtures/multi-repo/governance-kit.yaml`：multi-repo fixture。

---

### 任务 1：建立 Node.js 包和测试基础

**文件：**
- 创建：`package.json`
- 创建：`tooling/index.mjs`
- 创建：`tests/package.test.mjs`
- 通过 `npm install` 创建：`package-lock.json`

**接口：**
- 产出：npm scripts `test`、`test:unit` 和 `governance-kit`；package bin `governance-kit`。
- 产出：后续任务补充实现但不改变导入路径的公开导出。

- [ ] **步骤 1：编写失败的包契约测试**

```js
// tests/package.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("package exposes the governance CLI and supported Node version", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.type, "module");
  assert.equal(pkg.bin["governance-kit"], "./tooling/cli.mjs");
  assert.equal(pkg.engines.node, ">=20");
  assert.equal(pkg.scripts.test, "node --test tests");
});
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`node --test tests/package.test.mjs`

预期：FAIL，`package.json` 返回 `ENOENT`。

- [ ] **步骤 3：创建包契约和公开模块**

```json
{
  "name": "dev-governance-kit",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "bin": {
    "governance-kit": "./tooling/cli.mjs"
  },
  "scripts": {
    "governance-kit": "node tooling/cli.mjs",
    "test": "node --test tests",
    "test:unit": "node --test tests/*.test.mjs"
  },
  "dependencies": {
    "ajv": "8.17.1",
    "yaml": "2.8.1"
  }
}
```

```js
// tooling/index.mjs
export { applyGovernance } from "./lib/apply.mjs";
export { loadProjectManifest } from "./lib/manifest.mjs";
export { validateWorkspace } from "./lib/validate.mjs";
```

创建临时 CLI stub，使 npm 能在任务 7 之前解析已声明的 bin：

```js
#!/usr/bin/env node
// tooling/cli.mjs
process.stderr.write("governance-kit CLI is not initialized\n");
process.exitCode = 2;
```

- [ ] **步骤 4：安装锁定依赖并运行包测试**

运行：`npm install`

预期：退出码为 0，并生成 `package-lock.json`。

运行：`node --test --test-name-pattern="package exposes" tests/package.test.mjs`

预期：PASS，1 个测试通过。

- [ ] **步骤 5：提交**

```powershell
git add package.json package-lock.json tooling/index.mjs tooling/cli.mjs tests/package.test.mjs
git commit -m "build: establish governance CLI package"
```

---

### 任务 2：定义并验证项目清单、Profile 和 Blueprint

**文件：**
- 创建：`schemas/governance-kit.schema.json`
- 创建：`schemas/profile.schema.json`
- 创建：`schemas/blueprint.schema.json`
- 创建：`tooling/lib/errors.mjs`
- 创建：`tooling/lib/files.mjs`
- 创建：`tooling/lib/schema-validator.mjs`
- 创建：`tests/schema-validator.test.mjs`

**接口：**
- 产出：`GovernanceError(code: string, message: string, details?: object)`。
- 产出：`readYamlFile(filePath: string): Promise<object>`。
- 产出：`resolveInside(rootDir: string, relativePath: string): string`。
- 产出：`validateSchema(schemaName: "governance-kit" | "profile" | "blueprint", value: object): void`。

- [ ] **步骤 1：编写失败的 Schema 和安全路径测试**

```js
// tests/schema-validator.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { validateSchema } from "../tooling/lib/schema-validator.mjs";
import { resolveInside } from "../tooling/lib/files.mjs";

test("accepts a valid project manifest", () => {
  assert.doesNotThrow(() => validateSchema("governance-kit", {
    schemaVersion: 1,
    project: { name: "demo", repositoryMode: "multi-repo" },
    components: {
      server: { profile: "java-springboot-mybatis", path: "demo-server" }
    },
    contracts: { statusRegistryOwner: "server", apiContractOwner: "server" },
    generation: { conflictPolicy: "report" }
  }));
});

test("rejects an unsupported repository mode", () => {
  assert.throws(
    () => validateSchema("governance-kit", {
      schemaVersion: 1,
      project: { name: "demo", repositoryMode: "shared-folder" },
      components: {
        server: { profile: "java-springboot-mybatis", path: "server" }
      },
      contracts: { statusRegistryOwner: "server", apiContractOwner: "server" },
      generation: { conflictPolicy: "report" }
    }),
    (error) => error.code === "SCHEMA_INVALID"
  );
});

test("rejects paths outside the workspace", () => {
  assert.throws(
    () => resolveInside("C:/workspace/demo", "../outside"),
    (error) => error.code === "UNSAFE_PATH"
  );
});
```

- [ ] **步骤 2：运行测试并确认模块不存在错误**

运行：`node --test tests/schema-validator.test.mjs`

预期：FAIL，因为 `schema-validator.mjs` 和 `files.mjs` 尚不存在。

- [ ] **步骤 3：创建精确的 JSON Schema**

`schemas/governance-kit.schema.json` 必须：

- 要求存在 `schemaVersion`、`project`、`components`、`contracts` 和 `generation`；
- 将 `schemaVersion` 限定为整数常量 `1`；
- 将 `repositoryMode` 限定为 `monorepo` 或 `multi-repo`；
- 要求至少存在一个组件；
- 将组件键限定为 `server`、`admin` 或 `client`；
- 要求每个组件只能包含 `profile` 和 `path`；
- 将 `conflictPolicy` 限定为常量 `report`；
- 在每一层对象中禁止未知属性。

`schemas/profile.schema.json` 必须要求：

```json
{
  "id": "java-springboot-mybatis",
  "version": 1,
  "componentTypes": ["server"],
  "commands": {
    "test": "mvn test",
    "build": "mvn package"
  },
  "capabilities": {
    "migration": "flyway",
    "dataAccess": "mybatis"
  },
  "templateVariables": {
    "LANGUAGE_AND_VERSION": "Java 21"
  }
}
```

`schemas/blueprint.schema.json` 必须要求 `id`、`version`、`components`、`defaults` 和 `contracts`；组件值必须包含 `profile`；仓库模式和所有者字段使用与项目清单相同的枚举。

- [ ] **步骤 4：实现错误对象、UTF-8 YAML 加载、安全路径和 Ajv 验证**

```js
// tooling/lib/errors.mjs
export class GovernanceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GovernanceError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}
```

```js
// tooling/lib/files.mjs
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { GovernanceError } from "./errors.mjs";

export async function readYamlFile(filePath) {
  const source = await readFile(filePath, "utf8");
  return parse(source);
}

export function resolveInside(rootDir, relativePath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new GovernanceError("UNSAFE_PATH", `Path escapes workspace: ${relativePath}`, {
      root,
      target
    });
  }
  return target;
}

export async function writeUtf8Atomic(filePath, content) {
  const temporaryPath = `${filePath}.governance-kit.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, filePath);
}
```

```js
// tooling/lib/schema-validator.mjs
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { GovernanceError } from "./errors.mjs";

const schemaPaths = {
  "governance-kit": new URL("../../schemas/governance-kit.schema.json", import.meta.url),
  profile: new URL("../../schemas/profile.schema.json", import.meta.url),
  blueprint: new URL("../../schemas/blueprint.schema.json", import.meta.url)
};

const ajv = new Ajv({ allErrors: true, strict: true });
const validators = Object.fromEntries(
  Object.entries(schemaPaths).map(([name, url]) => {
    const schema = JSON.parse(readFileSync(url, "utf8"));
    return [name, ajv.compile(schema)];
  })
);

export function validateSchema(schemaName, value) {
  const validate = validators[schemaName];
  if (!validate) {
    throw new GovernanceError("UNKNOWN_SCHEMA", `Unknown schema: ${schemaName}`);
  }
  if (!validate(value)) {
    throw new GovernanceError("SCHEMA_INVALID", `${schemaName} validation failed`, {
      errors: validate.errors
    });
  }
}
```

- [ ] **步骤 5：运行针对性测试和完整测试**

运行：`node --test tests/schema-validator.test.mjs`

预期：PASS，3 个测试通过。

运行：`npm test`

预期：当前全部测试通过。

- [ ] **步骤 6：提交**

```powershell
git add schemas tooling/lib/errors.mjs tooling/lib/files.mjs tooling/lib/schema-validator.mjs tests/schema-validator.test.mjs
git commit -m "feat: define governance configuration contracts"
```

---

### 任务 3：添加 Core 规则和首个机器可读目录

**文件：**
- 创建：`core/rules/architecture.md`
- 创建：`core/rules/api.md`
- 创建：`core/rules/database.md`
- 创建：`core/rules/security.md`
- 创建：`core/rules/testing.md`
- 创建：`core/rules/agent-workflow.md`
- 创建：`templates/shared/docs/governance/README.md`
- 创建：`profiles/java-springboot-mybatis/profile.yaml`
- 创建：`profiles/react-admin/profile.yaml`
- 创建：`profiles/wechat-miniprogram/profile.yaml`
- 创建：`blueprints/java-react-wechat.yaml`
- 创建：`tooling/lib/catalog.mjs`
- 创建：`tests/catalog.test.mjs`

**接口：**
- 使用：任务 2 的 `readYamlFile()` 和 `validateSchema()`。
- 产出：`loadCatalog(kitRoot: string): Promise<{ profiles: Map<string, Profile>, blueprints: Map<string, Blueprint> }>`。
- 产出：包含内部绝对路径 `_sourceDir` 的目录条目。

- [ ] **步骤 1：编写失败的目录测试**

```js
// tests/catalog.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "../tooling/lib/catalog.mjs";

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("loads the three phase-one profiles and the official blueprint", async () => {
  const catalog = await loadCatalog(kitRoot);
  assert.deepEqual([...catalog.profiles.keys()].sort(), [
    "java-springboot-mybatis",
    "react-admin",
    "wechat-miniprogram"
  ]);
  assert.deepEqual([...catalog.blueprints.keys()], ["java-react-wechat"]);
});

test("blueprint profiles support their assigned component types", async () => {
  const catalog = await loadCatalog(kitRoot);
  const blueprint = catalog.blueprints.get("java-react-wechat");
  for (const [componentType, selection] of Object.entries(blueprint.components)) {
    const profile = catalog.profiles.get(selection.profile);
    assert.ok(profile.componentTypes.includes(componentType));
  }
});
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`node --test tests/catalog.test.mjs`

预期：FAIL，因为目录模块和 YAML 目录文件尚不存在。

- [ ] **步骤 3：添加 Core 规则文档**

为每个已批准的规则组创建一份职责单一的文档：

- `architecture.md`：后端事实源、controller/service/data 边界、adapter、事务、幂等和组件所有权。
- `api.md`：集中式客户端、DTO 边界、稳定错误、兼容性、分页、批量结果语义和调用方检查。
- `database.md`：只使用 migration、已发布 migration 不可修改、干净初始化、稳定状态码、索引、兼容窗口和回滚分析。
- `security.md`：密钥分离、显式环境、生产保护、后端授权、安全错误和禁止真实数据。
- `testing.md`：按变更类型划分的验证矩阵和基于证据的完成标准。
- `agent-workflow.md`：读取顺序、影响分析、非破坏性 Git 行为、跨组件同步和最终报告。

每个文件的标题必须以稳定规则 ID 前缀开头，例如：

```markdown
# CORE-ARCH：架构规则

这些技术无关规则对每个生成组件具有权威性。
```

每条规范性 Core 规则前必须包含全局唯一、机器可读的标记：

```markdown
<!-- rule-id: CORE-ARCH-001 -->
- Controller 只适配 HTTP 请求和响应，不承载业务规则。
```

规则 ID 使用 `CORE-<GROUP>-<THREE_DIGITS>`。Template 和 Profile 可以引用 Core 规则 ID，但不得为同一规则再次声明 `rule-id` 标记。

共享治理索引必须通过相对路径链接每份复制的 Core 规则，并说明生成的规则文件不得手工编辑。

- [ ] **步骤 4：添加精确的第一阶段 Profile 元数据**

以现有 Profile README 的命令和规则为来源。每个 `profile.yaml` 必须提供所选组件模板引用的全部变量。

Java Profile 必须声明：

```yaml
id: java-springboot-mybatis
version: 1
componentTypes:
  - server
commands:
  startDatabase: docker compose up -d
  start: mvn spring-boot:run
  test: mvn test
  build: mvn package
  statusGenerate: node scripts/generate-status-registry.mjs
  statusCheck: node scripts/check-status-registry.mjs
capabilities:
  migration: flyway
  dataAccess: mybatis
templateVariables:
  LANGUAGE_AND_VERSION: Java 21
  WEB_FRAMEWORK: Spring Boot
  ORM_OR_DATA_ACCESS: MyBatis
  MIGRATION_TOOL: Flyway
  DATABASE: MySQL
  BUILD_TOOL: Maven
  RUNTIME: Java 21
  DATABASE_RUNTIME: Docker Compose
  START_DATABASE_COMMAND: docker compose up -d
  START_SERVER_COMMAND: mvn spring-boot:run
  TEST_COMMAND: mvn test
```

React Profile 必须声明：

```yaml
id: react-admin
version: 1
componentTypes:
  - admin
commands:
  install: npm install
  start: npm run dev
  test: npm test
  typecheck: npm run typecheck
  build: npm run build
  statusGenerate: node scripts/generate-status-registry.mjs
  statusCheck: node scripts/check-status-registry.mjs
capabilities:
  ui: operations-console
  language: typescript
templateVariables:
  FRONTEND_FRAMEWORK: React
  LANGUAGE: TypeScript
  BUILD_TOOL: Vite
  UI_LIBRARY: Project-selected component library
  INSTALL_COMMAND: npm install
  DEV_COMMAND: npm run dev
  TEST_COMMAND: npm test
  TYPECHECK_COMMAND: npm run typecheck
  BUILD_COMMAND: npm run build
```

微信小程序 Profile 必须声明：

```yaml
id: wechat-miniprogram
version: 1
componentTypes:
  - client
commands:
  install: npm install
  test: npm test
  statusGenerate: node scripts/generate-status-registry.mjs
  statusCheck: node scripts/check-status-registry.mjs
capabilities:
  platform: wechat-miniprogram
  publicClient: true
templateVariables:
  INSTALL_COMMAND: npm install
  TEST_COMMAND: npm test
```

这些是新项目的 Profile 默认值。应用到已有项目时，Agent 必须在写入前确认所选 Profile 与仓库实际构建文件和脚本一致；MVP 不推断或改写 package scripts。

- [ ] **步骤 5：添加首个 Blueprint 和目录加载器**

```yaml
# blueprints/java-react-wechat.yaml
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

```js
// tooling/lib/catalog.mjs
import { readdir } from "node:fs/promises";
import path from "node:path";
import { readYamlFile } from "./files.mjs";
import { GovernanceError } from "./errors.mjs";
import { validateSchema } from "./schema-validator.mjs";

async function loadEntries(parentDir, { fileName, schemaName }) {
  const entries = new Map();
  const items = (await readdir(parentDir, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const item of items) {
    const isCandidate = fileName ? item.isDirectory() : item.isFile() && item.name.endsWith(".yaml");
    if (!isCandidate) {
      continue;
    }
    const sourceDir = item.isDirectory() ? path.join(parentDir, item.name) : parentDir;
    const sourceFile = item.isDirectory()
      ? path.join(sourceDir, fileName)
      : path.join(parentDir, item.name);
    const value = await readYamlFile(sourceFile);
    validateSchema(schemaName, value);
    if (entries.has(value.id)) {
      throw new GovernanceError("DUPLICATE_CATALOG_ID", `Duplicate ${schemaName}: ${value.id}`);
    }
    entries.set(value.id, { ...value, _sourceDir: sourceDir });
  }
  return entries;
}

export async function loadCatalog(kitRoot) {
  return {
    profiles: await loadEntries(path.join(kitRoot, "profiles"), {
      fileName: "profile.yaml",
      schemaName: "profile"
    }),
    blueprints: await loadEntries(path.join(kitRoot, "blueprints"), {
      fileName: "",
      schemaName: "blueprint"
    })
  };
}
```

- [ ] **步骤 6：运行目录测试和完整测试**

运行：`node --test tests/catalog.test.mjs`

预期：PASS，2 个测试通过。

运行：`npm test`

预期：全部测试通过。

- [ ] **步骤 7：提交**

```powershell
git add core templates/shared profiles blueprints tooling/lib/catalog.mjs tests/catalog.test.mjs
git commit -m "feat: add core rules and phase-one catalog"
```

---

### 任务 4：加载项目清单并构建无副作用的组合计划

**文件：**
- 创建：`tooling/lib/manifest.mjs`
- 创建：`tooling/lib/template.mjs`
- 创建：`tooling/lib/planner.mjs`
- 创建：`tests/template.test.mjs`
- 创建：`tests/planner.test.mjs`
- 创建：`tests/fixtures/multi-repo/governance-kit.yaml`
- 创建：`tests/fixtures/monorepo/governance-kit.yaml`

**接口：**
- 使用：目录映射、Schema 验证和安全路径解析。
- 产出：`loadProjectManifest(workspaceDir: string, kitRoot: string): Promise<ProjectContext>`。
- 产出：`renderStrict(source: string, variables: Record<string, string>): string`。
- 产出：`buildApplyPlan(context: ProjectContext): Promise<ApplyPlan>`。
- `ProjectContext` 使用 `{ kitRoot, workspaceDir, manifest, catalog, components }`，其中每个 `components[type]` 条目为 `{ type, rootDir, profile }`。
- `ApplyPlan` 使用 `{ context, operations }`。
- `ApplyPlan.operations` 条目使用 `{ component, sourcePath, targetPath, content, sourceId, sourceVersion, writePolicy }`。
- 带托管标记的生成文本使用 `"managed"`，`docs/status-enums.json` 使用 `"create-only"`。

- [ ] **步骤 1：编写失败的严格模板测试**

```js
// tests/template.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { renderStrict } from "../tooling/lib/template.mjs";

test("renders every declared variable", () => {
  assert.equal(
    renderStrict("Run {{TEST_COMMAND}} for {{PROJECT_NAME}}.", {
      TEST_COMMAND: "npm test",
      PROJECT_NAME: "demo"
    }),
    "Run npm test for demo."
  );
});

test("rejects unresolved variables", () => {
  assert.throws(
    () => renderStrict("Run {{TEST_COMMAND}} and {{BUILD_COMMAND}}.", {
      TEST_COMMAND: "npm test"
    }),
    (error) => error.code === "UNRESOLVED_VARIABLE"
      && error.details.variables.includes("BUILD_COMMAND")
  );
});
```

- [ ] **步骤 2：编写失败的清单和规划器测试**

规划器测试必须断言：

- multi-repo fixture 能解析出三个独立组件根目录；
- monorepo fixture 能解析同一根目录下的组件路径；
- 每个组件都包含计划应用的 Core 规则；
- 能正确选择 server、admin 和 miniprogram 模板；
- 每个操作目标均位于其组件根目录内；
- 计划内容不包含 `{{` 或 `}}`；
- `components` 中不存在的所有者以 `UNKNOWN_CONTRACT_OWNER` 失败；
- Profile 分配给不支持的组件时以 `INCOMPATIBLE_PROFILE` 失败。

使用以下精确 fixture 内容：

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

- [ ] **步骤 3：运行针对性测试并确认失败**

运行：`node --test tests/template.test.mjs tests/planner.test.mjs`

预期：FAIL，因为三个实现模块尚不存在。

- [ ] **步骤 4：实现严格渲染**

```js
// tooling/lib/template.mjs
import { GovernanceError } from "./errors.mjs";

const variablePattern = /\{\{([A-Z0-9_]+)\}\}/g;

export function renderStrict(source, variables) {
  const missing = new Set();
  const rendered = source.replace(variablePattern, (match, name) => {
    if (!(name in variables)) {
      missing.add(name);
      return match;
    }
    return String(variables[name]);
  });
  if (missing.size > 0) {
    throw new GovernanceError("UNRESOLVED_VARIABLE", "Template variables are unresolved", {
      variables: [...missing].sort()
    });
  }
  return rendered;
}
```

- [ ] **步骤 5：实现清单交叉引用检查**

`loadProjectManifest()` 必须：

1. 加载 `governance-kit.yaml`；
2. 使用项目 Schema 验证；
3. 加载目录；
4. 解析每个 Profile；
5. 验证组件兼容性；
6. 验证契约所有者存在；
7. 返回工作区/组件绝对路径以及所选元数据。

使用以下 `GovernanceError` 错误码：

- `PROFILE_NOT_FOUND`
- `INCOMPATIBLE_PROFILE`
- `UNKNOWN_CONTRACT_OWNER`

- [ ] **步骤 6：实现确定性规划**

`buildApplyPlan()` 必须按以下顺序创建操作：

1. 按文件名排序的 Core 规则。
2. 按相对路径排序的共享模板文件。
3. 按相对路径排序的组件模板文件。
4. 组件 Profile 文档。

模板变量按确定顺序合并：

1. 工作区派生值：
   - `PRODUCT_NAME` = `manifest.project.name`
   - `SERVER_NAME`、`ADMIN_NAME` 和 `MINIPROGRAM_NAME` = 对应组件路径的 basename
   - `SERVER_REPO_DIR_NAME` = server 组件路径的 basename
2. 所选 Profile 的 `templateVariables`。

重复键的值不一致时以 `VARIABLE_CONFLICT` 失败。模板要求但两个来源都未提供的变量通过 `renderStrict()` 失败。

兼容窗口内，将使用 `wechat-miniprogram` Profile 的 `client` 组件映射到现有 `templates/miniprogram` 来源。为托管 Markdown 内容添加以下生成元数据：

```markdown
<!-- governance-kit:managed -->
<!-- source-id: SOURCE_ID -->
<!-- source-version: 1 -->
```

不要向 JSON 状态源文件添加托管标记，因为它们必须保持为有效 JSON。任务 5 将 `docs/status-enums.json` 视为仅创建文件。

- [ ] **步骤 7：运行针对性测试和完整测试**

运行：`node --test tests/template.test.mjs tests/planner.test.mjs`

预期：全部针对性测试通过。

运行：`npm test`

预期：全部测试通过。

- [ ] **步骤 8：提交**

```powershell
git add tooling/lib/manifest.mjs tooling/lib/template.mjs tooling/lib/planner.mjs tests/template.test.mjs tests/planner.test.mjs tests/fixtures
git commit -m "feat: plan deterministic governance composition"
```

---

### 任务 5：在不覆盖用户文件的前提下应用计划

**文件：**
- 创建：`tooling/lib/apply.mjs`
- 创建：`tests/helpers/workspace.mjs`
- 创建：`tests/apply.test.mjs`

**接口：**
- 使用：任务 4 的 `ApplyPlan` 和任务 2 的 `writeUtf8Atomic()`。
- 产出：`applyGovernance({ workspaceDir: string, kitRoot?: string, dryRun?: boolean }): Promise<ApplyReport>`；省略 `kitRoot` 时，解析为包含 `tooling/lib/apply.mjs` 的仓库。
- `ApplyReport` 包含 `created`、`updated`、`unchanged`、`conflicts`、`warnings` 和 `errors` 数组。

- [ ] **步骤 1：编写失败的应用测试**

```js
// tests/apply.test.mjs
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { applyGovernance } from "../tooling/lib/apply.mjs";
import { createFixtureWorkspace } from "./helpers/workspace.mjs";

test("dry-run reports files without writing them", async (t) => {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  const report = await applyGovernance({ workspaceDir: workspace, dryRun: true });
  assert.ok(report.created.length > 0);
  await assert.rejects(readFile(path.join(workspace, "demo-server", "AGENTS.md"), "utf8"));
});

test("does not overwrite a user-owned AGENTS.md", async (t) => {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  const target = path.join(workspace, "demo-server", "AGENTS.md");
  await writeFile(target, "# User rules\n", "utf8");
  const report = await applyGovernance({ workspaceDir: workspace });
  assert.ok(report.conflicts.some((entry) => entry.path === target));
  assert.equal(await readFile(target, "utf8"), "# User rules\n");
});

test("a second unchanged apply is idempotent", async (t) => {
  const workspace = await createFixtureWorkspace(t, "multi-repo");
  await applyGovernance({ workspaceDir: workspace });
  const second = await applyGovernance({ workspaceDir: workspace });
  assert.equal(second.created.length, 0);
  assert.equal(second.updated.length, 0);
  assert.ok(second.unchanged.length > 0);
});
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`node --test tests/apply.test.mjs`

预期：FAIL，因为 `apply.mjs` 和 fixture 辅助函数尚不存在。

- [ ] **步骤 3：实现隔离的 fixture 创建**

`createFixtureWorkspace(t, fixtureName)` 必须：

- 使用 `mkdtemp(path.join(tmpdir(), "governance-kit-"))`；
- 通过 `t.after(() => rm(root, { recursive: true, force: true }))` 注册清理；
- 复制选定的 fixture 清单；
- 创建该 fixture 声明的所有组件目录；
- 返回临时工作区路径。

- [ ] **步骤 4：实现分类和 dry-run**

分类规则：

```text
target absent                                  -> created
target bytes equal planned content             -> unchanged
target has managed marker and same source ID   -> updated
target is docs/status-enums.json and exists    -> conflict
all other existing targets                     -> conflict
```

任何写入前：

- 构建完整计划；
- 对每项操作进行分类；
- `dryRun` 为 true 时立即返回；
- 报告中包含 `error` 时停止全部写入；
- 只为分类为 `created` 或 `updated` 的操作创建父目录。

每次写入都使用 `writeUtf8Atomic()`。返回前按路径对报告中的每个数组排序。

- [ ] **步骤 5：添加来源版本不匹配行为**

如果托管目标具有相同来源 ID，但来源版本不同：

- 不更新该文件；
- 添加错误码为 `SOURCE_VERSION_MISMATCH` 的 `conflicts` 条目；
- 包含预期版本和实际版本；
- 保持文件逐字节不变。

增加一个测试：写入版本 `0`，运行 apply，并验证冲突及文件字节未变化。

- [ ] **步骤 6：运行针对性测试和完整测试**

运行：`node --test tests/apply.test.mjs`

预期：全部应用、冲突和幂等性测试通过。

运行：`npm test`

预期：全部测试通过。

- [ ] **步骤 7：提交**

```powershell
git add tooling/lib/apply.mjs tests/helpers/workspace.mjs tests/apply.test.mjs
git commit -m "feat: apply governance layers safely"
```

---

### 任务 6：验证状态注册表和生成的工作区

**文件：**
- 创建：`tooling/lib/status-registry.mjs`
- 创建：`tooling/lib/validate.mjs`
- 创建：`tests/status-registry.test.mjs`
- 创建：`tests/validate.test.mjs`

**接口：**
- 产出：`validateStatusSource(source: object): void`。
- 产出：`renderStatusRegistry(source: object, options: { remote: boolean }): string`。
- 产出：`validateWorkspace({ workspaceDir: string, kitRoot?: string }): Promise<ValidationReport>`；省略 `kitRoot` 时，解析为包含 `tooling/lib/validate.mjs` 的仓库。
- `ValidationReport` 包含 `valid`、`checks`、`warnings` 和 `errors`。

- [ ] **步骤 1：编写失败的状态测试**

测试以下精确行为：

- 重复组名以 `DUPLICATE_STATUS_GROUP` 失败；
- 同组重复 code 以 `DUPLICATE_STATUS_CODE` 失败；
- 未知 `next` code 以 `UNKNOWN_NEXT_STATUS` 失败；
- 有效状态源能渲染确定性 Markdown；
- server 和远程 client 标题仅在来源说明上不同；
- 修改状态源后重新渲染能产生预期的新 code。

使用包含 `draft`、`reviewing` 和 `approved` 流转的精简 fixture。

- [ ] **步骤 2：编写失败的工作区验证测试**

测试以下精确检查：

- 有效的已应用 fixture 返回 `valid: true`；
- 未解析的 `{{BUILD_COMMAND}}` 返回 `UNRESOLVED_PLACEHOLDER`；
- 缺失托管文件返回 `MISSING_GENERATED_FILE`；
- 修改后的生成注册表返回 `STATUS_REGISTRY_DRIFT`；
- 重复声明 `<!-- rule-id: CORE-ARCH-001 -->` 返回 `DUPLICATE_RULE_ID`；
- 清单/Profile 不兼容以错误返回，而不是产生未捕获异常。

- [ ] **步骤 3：运行针对性测试并确认失败**

运行：`node --test tests/status-registry.test.mjs tests/validate.test.mjs`

预期：FAIL，因为两个实现模块尚不存在。

- [ ] **步骤 4：实现 CLI 侧状态验证和渲染**

在 `validateStatusSource()` 中实现重复和流转检查，在 `renderStatusRegistry()` 中实现确定性 Markdown 构建。输出必须与当前 server/client 逐字节一致，使现有生成项目脚本继续作为兼容性基准。

第一阶段不修改现有模板脚本。验证它们仍可通过以下命令直接执行：

```powershell
node scripts/generate-status-registry.mjs
node scripts/check-status-registry.mjs
```

server 脚本读取本地 `docs/status-enums.json`。admin 和 miniprogram 脚本继续支持 `SERVER_REPO_DIR`，相邻目录占位符在 apply 时渲染。将生成项目的实现抽取为统一封装明确推迟到第二阶段。

- [ ] **步骤 5：实现工作区验证**

`validateWorkspace()` 必须：

1. 加载并交叉检查清单；
2. 构建预期应用计划，但不写入；
3. 验证每个计划中的托管文件都存在；
4. 扫描计划文本目标中的未解析 `{{[A-Z0-9_]+}}`；
5. 扫描 `core/`、`templates/` 和 `profiles/` 中的 `<!-- rule-id: ID -->` 声明并拒绝重复 ID；
6. 验证 server 状态源；
7. 在状态 Markdown 存在时渲染并比较；
8. 返回排序后的结构化诊断结果。

使用 `error.toJSON()` 将 `GovernanceError` 实例转换为报告错误。必须重新抛出意外错误，避免隐藏程序缺陷。

- [ ] **步骤 6：运行针对性、wrapper 和完整测试**

运行：`node --test tests/status-registry.test.mjs tests/validate.test.mjs`

预期：全部针对性测试通过。

在生成的 server fixture 中运行：

```powershell
node scripts/generate-status-registry.mjs
node scripts/check-status-registry.mjs
```

预期：两个命令退出码均为 0，检查命令输出 `Status registry check passed.`

运行：`npm test`

预期：全部测试通过。

- [ ] **步骤 7：提交**

```powershell
git add tooling/lib/status-registry.mjs tooling/lib/validate.mjs tests/status-registry.test.mjs tests/validate.test.mjs
git commit -m "feat: validate generated governance workspaces"
```

---

### 任务 7：通过 CLI 暴露 apply 和 validate

**文件：**
- 修改：`tooling/cli.mjs`
- 修改：`tooling/index.mjs`
- 创建：`tests/cli.test.mjs`

**接口：**
- 使用：`applyGovernance()` 和 `validateWorkspace()`。
- 产出命令：
  - `governance-kit apply --workspace <path> [--dry-run] [--json]`
  - `governance-kit validate --workspace <path> [--json]`
- 退出码：`0` 表示成功，`1` 表示验证错误或冲突，`2` 表示 CLI 用法错误。

- [ ] **步骤 1：编写失败的 CLI 端到端测试**

使用 `process.execPath` 启动 `tooling/cli.mjs` 并断言：

- `apply --dry-run --json` 退出码为 0，报告待创建文件且不执行写入；
- `apply --json` 在空 fixture 中退出码为 0，并生成托管文件；
- 已有用户文件发生冲突时，`apply --json` 退出码为 1；
- 干净 apply 后，`validate --json` 退出码为 0；
- 引入注册表漂移后，`validate --json` 退出码为 1；
- 未知命令退出码为 2，并向 stderr 输出用法；
- JSON 模式只向 stdout 写入一份有效 JSON 文档。

- [ ] **步骤 2：运行 CLI 测试并确认失败**

运行：`node --test tests/cli.test.mjs`

预期：FAIL，因为 CLI 仍包含初始化 stub。

- [ ] **步骤 3：实现无额外依赖的参数解析**

只接受：

```text
apply
validate
--workspace <path>
--dry-run
--json
--help
```

出现重复 `--workspace`、缺失值、validate 使用 `--dry-run` 或未知参数时，以退出码 2 拒绝。

`--workspace` 默认使用 `process.cwd()`。从 CLI 模块位置解析 `kitRoot`，不得从当前工作目录解析。

- [ ] **步骤 4：实现稳定输出和退出码**

JSON 输出结构：

```json
{
  "command": "apply",
  "workspace": "C:/absolute/workspace",
  "ok": true,
  "report": {
    "created": [],
    "updated": [],
    "unchanged": [],
    "conflicts": [],
    "warnings": [],
    "errors": []
  }
}
```

人类可读输出以中文呈现，必须包含每个报告分类的数量，并列出冲突/错误的英文错误码和路径。

`conflicts` 或 `errors` 非空时，`apply` 返回退出码 1。`valid` 为 false 时，`validate` 返回退出码 1。

- [ ] **步骤 5：运行 CLI 测试和完整测试**

运行：`node --test tests/cli.test.mjs`

预期：全部 CLI 测试通过。

运行：`npm test`

预期：全部测试通过。

运行：`node tooling/cli.mjs --help`

预期：退出码为 0，用法文本同时包含 `apply` 和 `validate`。

- [ ] **步骤 6：提交**

```powershell
git add tooling/cli.mjs tooling/index.mjs tests/cli.test.mjs
git commit -m "feat: expose governance apply and validate CLI"
```

---

### 任务 8：记录 MVP 并验证干净工作区行为

**文件：**
- 修改：`README.md`
- 创建：`docs/MANIFEST_REFERENCE.md`
- 创建：`docs/MIGRATION_FROM_V1_TEMPLATES.md`
- 修改：`tests/package.test.mjs`
- 修改：`tests/cli.test.mjs`

**接口：**
- 记录任务 1–7 创建的稳定 CLI 和清单字段。
- 不改变运行时接口，只增加最终验收覆盖。

- [ ] **步骤 1：添加失败的文档契约测试**

扩展 `tests/package.test.mjs`：

```js
test("README documents both supported workflows", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /governance-kit apply/);
  assert.match(readme, /governance-kit validate/);
  assert.match(readme, /已有项目/);
  assert.match(readme, /新项目/);
});
```

- [ ] **步骤 2：运行文档测试并确认失败**

运行：`node --test tests/package.test.mjs`

预期：FAIL，因为 README 尚未记录 CLI 工作流。

- [ ] **步骤 3：更新用户和 Agent 文档**

README 必须包含：

- 中文主体说明，技术标识和命令保留英文；
- 五层架构；
- 使用 `npm install` 安装；
- 完整的 `governance-kit.yaml` 示例；
- apply 前先执行 dry-run；
- apply 和 validate 命令；
- 冲突处理行为；
- 第一阶段支持的 Profile；
- 明确说明 `init` 和其他技术栈属于后续阶段。

`docs/MANIFEST_REFERENCE.md` 必须记录每个 Schema 字段、允许的枚举、默认值、所有权规则，以及一个 monorepo 和一个 multi-repo 示例。

`docs/MIGRATION_FROM_V1_TEMPLATES.md` 必须说明：

- 现有模板继续可用；
- 如何为已有三仓库工作区创建清单；
- dry-run 如何分类已有 `AGENTS.md`；
- 为什么报告用户文件而不是覆盖；
- 如何手工解决冲突并重新运行 validate。

- [ ] **步骤 4：添加最终验收测试**

为 `tests/cli.test.mjs` 增加两个端到端测试：

1. 复制 monorepo fixture，执行两次 apply，断言第二次报告的 `created` 和 `updated` 均为零，然后成功 validate。
2. 复制 multi-repo fixture；每个组件包含独立 `.git` 目录，工作区根目录不包含；成功 apply 和 validate，并断言没有命令尝试初始化或修改 Git 元数据。

- [ ] **步骤 5：运行全新的完整验证**

运行：`npm ci`

预期：使用已提交 lockfile，退出码为 0。

运行：`npm test`

预期：全部测试通过，失败数为零。

运行：

```powershell
node tooling/cli.mjs apply --workspace tests/fixtures/multi-repo --dry-run --json
```

预期：退出码为 0，输出有效 JSON，至少包含一个计划创建项，并且 fixture 未修改。

运行：`git diff --check`

预期：退出码为 0，没有空白错误。

运行：`git status --short`

预期：提交前只存在任务 8 有意产生的文档和测试修改。

- [ ] **步骤 6：提交**

```powershell
git add README.md docs/MANIFEST_REFERENCE.md docs/MIGRATION_FROM_V1_TEMPLATES.md tests/package.test.mjs tests/cli.test.mjs
git commit -m "docs: document governance overlay workflows"
```

---

## 第一阶段完成门槛

在声明 MVP 完成前，从干净 checkout 或 detached verification worktree 运行全部命令：

```powershell
npm ci
npm test
node tooling/cli.mjs --help
node tooling/cli.mjs apply --workspace tests/fixtures/monorepo --dry-run --json
node tooling/cli.mjs apply --workspace tests/fixtures/multi-repo --dry-run --json
git diff --check
git status --short
```

完成必须满足：

- 测试失败数为零；
- 两个 dry-run 命令都输出有效 JSON，且不修改 fixture；
- 生成的测试工作区中不存在未解析的 `{{VARIABLE}}`；
- 冲突场景后，已有用户文件保持逐字节一致；
- 输入不变时第二次 apply 的创建和更新数量均为零；
- 状态注册表生成和漂移检查通过；
- 不存在意外 Git 工作区修改。

通过该门槛后，再分别为第二阶段（新增 Profile 和共享状态脚本封装）与第三阶段（`init` 和上游脚手架集成）编写独立实施计划。
