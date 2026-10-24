# B0：表、端口与事务映射

[机器映射](b0-mapping.json)逐项列出 B 线全部表、服务方法与关联场景；校验器与固定 architecture.json/contracts.ts 对照，遗漏、重复、越权表或不存在方法均失败。该文件只描述实现计划，不增加任何产品类型或服务。

## 1. 表组与业务写所有权

| 所有者 | 表                                                       | 计划写入口与不变量                                                                                             |
| ------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| S02    | schema_migrations、space_metadata                        | 只在存储初始化/迁移写；既有迁移哈希、space/principal/epoch 不符拒绝打开，保留原库                              |
| S02    | domain_events、diagnostic_events                         | appendInTx 与业务提交同事务；诊断仅安全摘要，不存平台正文；事件 seq 清理后仍可触发 resetRequired               |
| S05    | alerts_inbox、watch_checkpoints                          | 每页接收事务；源键唯一、receive_seq 单调；仅全部页完成推进 completed_upper，失败仍保留先前已提交页             |
| S05    | trigger_policies、auto_candidates、trigger_decisions     | expectedRevision CAS、epoch fence、启用 receiveSeq 起点；history/recovery 不自动调查；受理与 dispatched 同事务 |
| S05    | notifications                                            | 唯一通知键、pending/shown/uncertain/muted；发送在事务外，未知展示不声称成功/严格 exactly-once                  |
| S06    | cases、case_changes、evidence_links                      | 案件 CAS/审计/附移材料；双案版本同事务；历史 run 证据不随拆案删除                                              |
| S06    | evidence_sources、evidence_versions、evidence_retrievals | 稳定定位键、不可变版本、每次取得另记 retrieval；过期后重新获取新版本                                           |
| S06    | business_context、context_versions                       | 作者来自 Actor，来源/目标/有效期/核实状态保留版本；外层/内层 caseId 一致                                       |
| S06    | query_runs、query_pages、query_evidence                  | 页序/响应哈希幂等；同 ordinal 不同内容冲突；连续页也需确认无失败/截断，不以有数据推断完整                      |
| S06    | run_evidence、evidence_projections                       | S07 传 run 和可信关联；prepared 不构成有效报告引用，unknown send 为 uncertain；不读取 S07 私有状态             |
| S06    | cleanup_plans                                            | 预览 10min、精确 hash/revisions/保护集合；应用再次复核，正文过期保留定位/原哈希/历史引用标记                   |
| S10    | report_drafts、reviews                                   | 逐 run 新版本、引用校验与人工结论分离；invalid/needs_review 保留候选，valid 仍 unreviewed                      |
| S10    | followups、response_notes                                | 待办 CAS、新建 expectedRevision=0；人工记录不当成观测。response_notes 写入口待 G02 明确，不能自己加公开方法    |
| S10    | result_packages                                          | request/resultVersion 不可变、同内容幂等/异内容冲突；terminalState 由 S07 的 CompletionDecision 提供           |

B 维护所有物理迁移不等于获得 connections、jobs、analysis_runs、quota_ledger、mcp_calls、mcp_grants 或 result_deliveries 的业务写权。测试为了满足外键可显式预置其他所有者的合成行；这不授权产品 Repository 跨表写入。既有 0001.sql 和 spec 原文保持不变。

## 2. 端口消费规则

| 导出                                                                 | 消费者 / 事务形式                                               | 约束                                                                                                    |
| -------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| createStorage → DatabasePort/EventPort                               | A/S03 装配，各模块 db.read/write；appendInTx 使用调用者 WriteTx | 仅同步回调；不暴露驱动，关闭等候队列，错误/抛出/thenable 全回滚                                         |
| createCaseService → CaseService                                      | S03 Facade，异步公共服务，自持一个 read/write                   | UI/MCP 不取得 tx；list/snapshot/evidence 为核权读取，其余调用原子实现                                   |
| createCaseService → CaseAtomicPort                                   | S05/S07/S10，已打开的同步 ReadTx/WriteTx                        | 不嵌套 db.write；S06 不回调预算/MCP；inspectRunInTx 只返回证据视图                                      |
| createAlertService → AlertService                                    | S03 显式调 pollOnce/flushCandidates；UI 读收件箱/改策略         | 构造不启动定时器。依赖 query/connections/casesAtomic/requestsAtomic/notifications，不引入 ExecutionPort |
| createReportService → ReportService                                  | S03 与 S07 注入所需窄视图；prepare 为事务外纯准备               | propose/finalize 等同步 InTx；review 与 export 自持单事务，不读取任务/宿主事实                          |
| InvestigationProfilePort / ReportProposalPort / ReportCompletionPort | 分别是 ReportService 的固定 Pick 视图                           | 不重新定义接口或扩大为完整上层服务；prepare 不创建 projection，不把 prepared 当交付事实                 |
| createResultPackageReader → ResultPackageReadPort                    | S11 先核权订阅，再在其 tx 调 getInTx                            | 只读自己的 result_packages；无结果 RESULT_NOT_READY，不查 jobs 推断结果                                 |

所需外部输入端口为 ClockPort/IdPort、S04 的 PlatformQueryPort/ConnectionReadPort、S07 的 RequestAtomicPort、S03 的 NotificationPort。只有 S07 协调者消费 RunBudgetAtomicPort、RetentionService 与 ReviewPublicationPort；S06/S10 不反向依赖这些上层对象。

## 3. 必须原子的操作

| 编号 / 协调者                    | 同一事务中的调用与数据                                                                                | 事务外动作 / 失败预期                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| TX01 / S02                       | 初始化迁移、空间元数据；业务 write 回调与 domain_events                                               | 不自动重跑含外部副作用的回调；失败保留原库/回滚整笔；迁移 DDL 探针不证明产品回调约束       |
| TX02 / S05                       | generation 复核 → S06.captureInTx → 新 inbox → notification/decision → 事件                           | 查询先在外；通知后在外。页失败不推进整轮 completed_upper；receiveSeq 只分配给真正新项      |
| TX03 / S05                       | setPolicy CAS/epoch → S07.cancelPolicyInTx → 事件                                                     | S07 后台 tick 撤销/中止；S05 不调用执行驱动。InTx 失败则 policy 也回滚                     |
| TX04 / S05                       | S07.createAutoInTx → candidate dispatched/拒绝记录                                                    | 成功同提交，失败按 G04 全回滚或无副作用保证后记录原因；通知不依赖预算受理成功              |
| TX05 / S06                       | 两案主体/连接/双 CAS → evidence_links 移动 → 两案 audit/revision                                      | 任一版本错两案均不变；不删除旧 run_evidence                                                |
| TX06 / S07                       | fence/事件预算 → S06.captureInTx/projectInTx → S07 回复账本                                           | HTTP 在外；任何失败预算与材料一起回滚；300 事件上限归 S07                                  |
| TX07 / S07                       | setStatusInTx → 冻结返回 revision → 预算 seed → initializeRunInTx；保存 initialInput                  | 提交后 prepare 配置/宿主提交；实际发送核实后另事务 release，不预先释放                     |
| TX08 / S07                       | sealInTx → S10.assessInTx → S07 决定/保存终态 → S10.finalizeInTx → S06.applyRunInTx → S11.enqueueInTx | 宿主 inspect 与投递在外；任一失败整笔回滚。seal 持久化依 G01；uncertain 不调用完成         |
| TX09 / S07 RetentionService      | 当前活动/uncertain 保护集合 → S06.applyCleanupInTx → S07 缓存 EXPIRED                                 | 计划/引用/保护集合变化拒绝，重新预览；缓存失败连正文过期一起回滚                           |
| TX10 / S10                       | review 新记录/修订 → S06.recordChangeInTx → 事件                                                      | 不投递。作者由 Actor，CAS 冲突不覆盖；不自动关闭案件                                       |
| TX11 / S07 ReviewPublicationPort | 核对来源/双版本 → S10.publishReviewedInTx → S11.enqueueInTx                                           | 沿用原包 terminalState；outbox 失败不留半个新版包；普通 review 不走此路径                  |
| TX12 / S10                       | 一个 ReadTx：S06.snapshotInTx + 本域报告/审核/待办 + 导出序号/版本                                    | 返回 filename/mediaType/text 后由 S03 系统对话框写文件；禁两个异步快照拼接、跨案信息和秘密 |

具体失败、输入与预期见[验收场景](b0-scenarios.json)。跨模块组合预期属于 B4/A/C 的后续验收，B0 只保证材料可解析且对应冻结端口；不会返回一组 fake success 冒充这些事务已经运行。
