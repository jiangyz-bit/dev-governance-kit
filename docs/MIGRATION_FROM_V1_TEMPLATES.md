# 从 V1 手工模板迁移

现有 `templates/server`、`templates/admin` 和 `templates/miniprogram` 在兼容窗口内继续可用，不会立即删除。

## 三仓库工作区

在三个仓库的共同父目录创建：

```yaml
schemaVersion: 1
project:
  name: product
  repositoryMode: multi-repo
components:
  server:
    profile: java-springboot-mybatis
    path: product-server
  admin:
    profile: react-admin
    path: product-admin
  client:
    profile: wechat-miniprogram
    path: product-miniprogram
contracts:
  statusRegistryOwner: server
  apiContractOwner: server
generation:
  conflictPolicy: report
```

工作区根目录不需要是 Git 仓库，三个子目录可以分别维护自己的 `.git`。

## 先预览

```powershell
node tooling/cli.mjs apply --workspace C:\Projects\product --dry-run --json
```

报告分类：

- `created`：目标不存在，可以生成。
- `updated`：同一来源和版本的工具托管文件可以更新。
- `unchanged`：内容一致。
- `conflicts`：用户文件、create-only 文件或来源版本不匹配。

## 已有 AGENTS.md

第一阶段不会重写已有 `AGENTS.md`。工具将其报告为 `USER_FILE_CONFLICT`，并继续处理其他无冲突文件。

处理方式：

1. 保留项目原有规则。
2. 对照 dry-run 计划内容人工合并。
3. 不要伪造 `governance-kit:managed` 标记。
4. 再次运行 dry-run 和 validate。

## 状态注册表

- 后端已有 `docs/status-enums.json` 时按 create-only 冲突处理，不覆盖业务状态。
- 确认状态源后运行现有生成脚本。
- `validate` 会检查重复 code、未知流转和 Markdown 漂移。

## 完成迁移

```powershell
node tooling/cli.mjs apply --workspace C:\Projects\product
node tooling/cli.mjs validate --workspace C:\Projects\product
```

最后分别进入各组件仓库运行真实测试、类型检查和构建命令。
