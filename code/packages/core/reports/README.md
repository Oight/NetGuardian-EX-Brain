# S10 · 报告与结果包

`@campussec/core/reports` 导出 `createReportService({db,events,clock,ids,cases,casesAtomic})` 和 `createResultPackageReader({db})`。实现冻结契约的全部 ReportService 方法；生产 composeRuntime 默认装配，界面经 DesktopApi 消费。

草案校验实际轮次投影、交付状态、版本/摘要、查询和已交付背景引用；引用错误保存 invalid，语义疑点 needs_review，有效结构仍 unreviewed。人工修订保留旧文，审核和待办更新与案件审计同事务；备注只记 human_statement，不因关联证据自动成为 observed。

完成方法只消费协调者的 CompletionDecision/封存摘要，不读取 JobState、决定取消、改任务表或发送结果。仅读取 run/request 的关联及冻结元数据进行核权；S11 先核权订阅，再消费结果只读端口。私有 JSON 附带引用策略与幂等指纹，公开结果包仍为 0.1.0，不复制投影正文。

导出在同一 ReadTx 读取全部当前关联证据页及案件/报告/人工记录；保留审核状态和覆盖限制，隐藏结构化敏感字段，Markdown 使用安全代码围栏。返回受控文件名/正文，由 S03 保存。测试跟随 tests/；本轮结果在 [T003](../../../docs/development/tasks/T003-b-local-domain.md)。完整工具调查、发布/outbox 原子性与真实宿主仍由后续用例验收。
