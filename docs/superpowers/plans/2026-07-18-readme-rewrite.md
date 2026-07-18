# README 中文重写实施计划

> **面向执行 Agent：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，逐项实施本计划。所有步骤使用复选框（`- [ ]`）跟踪进度。

**目标：** 将根目录 README 重写为开发者和 AI Agent 都能在 3 分钟内理解并开始使用的中文入口。

**架构：** README 采用渐进式信息结构：先讲用户价值和快速开始，再说明产物、安全边界、Agent 提示词、支持范围和工作原理。详细 Schema 保持在 `docs/MANIFEST_REFERENCE.md`，不把旧版迁移和内部路线图放回主入口。

**技术栈：** Markdown、Node.js 内置测试框架。

## 全局约束

- README 中文为主体，命令、路径、Profile ID 和 Schema 字段保留英文。
- 不宣传未实现的 `init`、远程安装或包发布能力。
- 不链接 V1 迁移文档。
- 不重复同一组 apply/validate 命令。
- README 控制在约 150 行以内。

---

### 任务 1：重写并验证 README

**文件：**
- 修改：`tests/package.test.mjs`
- 修改：`README.md`

**接口：**
- 使用：当前真实 CLI 命令 `node tooling/cli.mjs apply|validate`。
- 产出：包含价值、快速开始、生成结果、安全边界、Agent 提示词和进阶文档链接的 README。

- [ ] **步骤 1：扩展失败的 README 契约测试**

测试必须要求以下标题存在：

```js
for (const heading of [
  "## 它能解决什么问题",
  "## 3 分钟快速开始",
  "## 执行后会得到什么",
  "## 已有项目是否安全",
  "## 交给 AI Agent 使用"
]) {
  assert.match(readme, new RegExp(heading));
}
```

测试必须拒绝以下旧版或路线图内容：

```js
for (const legacyText of ["V1", "第一阶段", "第二阶段", "第三阶段", "MIGRATION_FROM_V1_TEMPLATES"]) {
  assert.doesNotMatch(readme, new RegExp(legacyText));
}
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`node --test tests/package.test.mjs`

预期：FAIL，缺少新的用户导向标题，且仍包含旧版/阶段叙述。

- [ ] **步骤 3：按设计重写 README**

README 按以下顺序编写：

```text
一句话定位
它能解决什么问题
3 分钟快速开始
执行后会得到什么
已有项目是否安全
交给 AI Agent 使用
当前支持范围
工作原理
进阶文档
项目开发验证
```

- [ ] **步骤 4：运行完整验证**

运行：

```powershell
node --test tests/package.test.mjs
npm test
git diff --check
```

预期：全部测试通过，Markdown 无空白错误。

- [ ] **步骤 5：提交**

```powershell
git add README.md tests/package.test.mjs docs/superpowers/plans/2026-07-18-readme-rewrite.md
git commit -m "docs: simplify Chinese README"
```
