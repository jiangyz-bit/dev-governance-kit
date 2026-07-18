# governance-kit.yaml 项目清单参考

`governance-kit.yaml` 是 AI Agent 和 CLI 理解工作区的唯一入口。

## 完整示例

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

Schema 不允许未知字段。

## 字段

### schemaVersion

- 必填整数。
- 当前固定为 `1`。

### project.name

- 必填非空字符串。
- 用于生成产品名称和仓库说明。

### project.repositoryMode

- 必填。
- `monorepo`：组件位于同一仓库或工作区目录。
- `multi-repo`：每个组件可以包含独立 `.git`，工作区根目录不必是 Git 仓库。

### components

- 至少包含一个组件。
- 允许的键：`server`、`admin`、`client`。
- 每个组件必须包含：
  - `profile`：已注册的 Profile ID。
  - `path`：相对工作区根目录的路径，不允许逃逸到工作区外。

第一阶段可用 Profile：

| 组件 | Profile |
|---|---|
| `server` | `java-springboot-mybatis` |
| `admin` | `react-admin` |
| `client` | `wechat-miniprogram` |

### contracts.statusRegistryOwner

- 必填。
- 指定业务状态注册表唯一所有者。
- 值必须是 `components` 中实际存在的组件。
- 当前推荐且默认语义为 `server`。

### contracts.apiContractOwner

- 必填。
- 指定 API 契约主要所有者。
- 值必须是 `components` 中实际存在的组件。

### generation.conflictPolicy

- 必填。
- 第一阶段固定为 `report`。
- 用户文件或来源不明文件只报告冲突，不自动覆盖。

## monorepo 示例

```yaml
schemaVersion: 1
project:
  name: demo
  repositoryMode: monorepo
components:
  server:
    profile: java-springboot-mybatis
    path: apps/server
  admin:
    profile: react-admin
    path: apps/admin
  client:
    profile: wechat-miniprogram
    path: apps/miniprogram
contracts:
  statusRegistryOwner: server
  apiContractOwner: server
generation:
  conflictPolicy: report
```

## 使用顺序

```powershell
node tooling/cli.mjs apply --workspace C:\Projects\demo --dry-run
node tooling/cli.mjs apply --workspace C:\Projects\demo
node tooling/cli.mjs validate --workspace C:\Projects\demo
```
