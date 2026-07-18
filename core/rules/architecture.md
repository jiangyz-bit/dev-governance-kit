# CORE-ARCH：架构规则

这些技术无关规则对每个生成组件具有权威性。

<!-- rule-id: CORE-ARCH-001 -->
- 后端是业务事实源；前端负责交互、展示和用户输入。

<!-- rule-id: CORE-ARCH-002 -->
- 后端遵循 `controller -> service -> repository/mapper -> database`，Controller 不承载业务规则。

<!-- rule-id: CORE-ARCH-003 -->
- Service 统一负责业务规则、权限校验、状态流转、事务和审计。

<!-- rule-id: CORE-ARCH-004 -->
- 外部系统调用封装为独立 adapter/client，禁止散落在业务代码中。

<!-- rule-id: CORE-ARCH-005 -->
- 重要写操作必须具备幂等能力或明确的防重复机制。

<!-- rule-id: CORE-ARCH-006 -->
- 每个可独立发布的组件必须拥有清晰边界以及独立可运行的构建、测试和发布命令。
