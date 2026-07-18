# CORE-AGENT：AI Agent 工作规则

<!-- rule-id: CORE-AGENT-001 -->
- 开始工作前读取当前目录的 Agent 指令、README 和与改动相关的 docs。

<!-- rule-id: CORE-AGENT-002 -->
- 修改前确认仓库边界、运行命令、测试命令和跨组件影响。

<!-- rule-id: CORE-AGENT-003 -->
- 不覆盖用户已有修改，不执行破坏性 Git 操作，除非用户明确要求。

<!-- rule-id: CORE-AGENT-004 -->
- 跨端改动必须同步 API、状态、类型、测试和文档。

<!-- rule-id: CORE-AGENT-005 -->
- 涉及数据库时新增 migration；涉及状态时更新状态注册和流转规则。

<!-- rule-id: CORE-AGENT-006 -->
- 最终回复说明完成内容、验证结果、未完成事项和剩余风险。
