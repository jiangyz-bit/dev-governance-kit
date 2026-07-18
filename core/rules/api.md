# CORE-API：API 契约规则

<!-- rule-id: CORE-API-001 -->
- API 契约优先于页面实现；跨端改动先确认请求、响应、错误和兼容范围。

<!-- rule-id: CORE-API-002 -->
- 客户端请求必须集中封装，页面不得散落原始 HTTP 调用。

<!-- rule-id: CORE-API-003 -->
- 页面通过稳定 DTO 或 View Model 消费数据，不直接依赖持久化实体。

<!-- rule-id: CORE-API-004 -->
- 错误响应使用稳定 code、可读 message 和可选 details，禁止泄露堆栈、SQL、凭据或内部地址。

<!-- rule-id: CORE-API-005 -->
- API 变更优先采用向后兼容的增量方式；破坏性变更必须同步检查全部调用方。

<!-- rule-id: CORE-API-006 -->
- 批量操作返回逐项成功或失败结果；写操作返回最新资源状态或可追踪任务 ID。
