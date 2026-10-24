# S10 报告与结果包

公开出口 @campussec/core/reports → createReportService、createResultPackageReader。已实现配置、可信引用校验、草案/评估/显式完成、人工审核/待办、不可变结果包与 Markdown/JSON 导出；默认 runtime 装配报告服务。

依赖 db/events/clock/ids、cases/casesAtomic 与 anchors:ReportAnchorReadPort。锚点实现由 S07 经装配注入，S10 不查询任务/请求/轮次私表，不决定取消或任务终态，不调用宿主或投递。结构 valid 仍为 unreviewed，语义支持由人工核查。

同步事务、CAS、回滚、重启回读和导出场景在 tests/。真实调查与 S07/S11 outbox 组合仍待验收；人工备注当前为 human_statement，observed 独立入口未交付。见[T003](../../../docs/development/tasks/T003-b-local-domain.md)。
