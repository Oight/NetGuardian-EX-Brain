# 工程契约0.2.0修订记录

> 协作补充（2026-10-23）：本文记录工程契约修订，技术边界不变；其中较重的角色/PR安排由用户后续确认的[轻量流程](../development/README.md)替代。

日期：2026-10-23。依据本轮用户要求落实前述耦合评审与Agent并行开发讨论。业务基线仍是v4.2，本次为内部工程设计修订，尚未实现/联调。[边界说明](boundaries.md) · [契约原文](contracts.ts) · [开发入口](../development/README.md)。

## 1. 版本与兼容性

| 项目 | 本轮版本/处理 |
|---|---|
| 业务设计 | v4.2，范围/完成条件不变 |
| 工程TypeScript契约 | 0.2.0，包含不兼容内部接口调整；不混用0.1.0实现 |
| Desktop RPC、MCP工具信封、导出schema | 0.1.0，外部字段/方法和限制保持 |
| 调查Skill配置候选 | campussec-investigator/0.1.0，加载仍待真实验证 |
| 数据库 | 0001设计DDL修订；无已交付产品库，不声称执行过数据迁移 |

## 2. 已落实的边界调整

1. S06去掉recordEventsInTx/MCP清理回调，project/release/seal/capture/清理移入内部CaseAtomicPort；S07统一协调预算、投影和缓存。
2. S07拆请求协调、预算、工具应用、留存和修订发布；工具调用账本mcp_calls与investigation_steps转归S07，保持物理表名。
3. S09拆无业务依赖的EvidenceChannelPort和McpGatewayPort入口；S07只拿open/revoke，S08只拿bind，入口只做协议/身份/路由。
4. S08内部解释parentID/finish等wire细节，对外ExecutionSnapshot改为verification；HostDeliveryPort改接HostMessage，不解释ResultPackage。
5. S10改为assessInTx+显式CompletionDecision，不读取jobs/request_events判断终态；发布修订不回调S11。
6. 新增FrozenRunInput、RunEvidenceView、ReportValidationInput等明确快照，S07组装实际输入后交下层，不让模型自填内部事实。
7. 增加查询、连接读取、报告配置/提案/完成、宿主来源/投递等窄端口；继续使用确定性schema与获准能力。

## 3. 旧接口迁移表

| 0.1.0调用 | 0.2.0调用/归属 |
|---|---|
| RequestService.createAutoInTx | RequestAtomicPort.createAutoInTx |
| RequestService预算方法 | RunBudgetPort/RunBudgetAtomicPort |
| CaseService.capture/project/release/seal/清理 | CaseAtomicPort，由S07用例协调 |
| McpGatewayPort.openChannel/bindChannel/revoke | EvidenceChannelPort及其窄视图 |
| McpGatewayPort.acknowledgeReply | InvestigationToolPort.acknowledgeReply |
| McpAtomicPort.expireRepliesInTx | S07 ToolReplyAtomicPort |
| ReportService.propose | S07传显式校验快照后proposeInTx |
| ReportService.finalize(execution) | assessInTx后finalizeInTx(context,decision,assessment,manifest) |
| ReportService.publishReview | S07 ReviewPublicationPort→S10.publishReviewedInTx→S11 |
| HostAccess.deliver(result) | HostDeliveryPort.deliver(message) |

## 4. 数据与原件

schema.sql在analysis_runs增加prepared_profile_json、completion_decision_json，tool_reservations增加tool_epoch、identity_epoch、connection_generation以核对预占后的授权变化，均由S07持有；表数量和状态约束保持。旧实验库若已采用0001，必须增加独立迁移，不覆盖其已记录校验值。当前未执行真实数据库升级。

archive/sources/design、research/teleagent迁入原件及migration/manifest.jsonl不改；工作副本的有意修改记在本页和核验记录，不重算迁移原件哈希来消除差异。

## 5. 仍未完成的工程条件

产品workspace、运行时schema、共享fake/testkit、严格tsc、源码边界检查、安装包、真实宿主M0及完整P0均仍待实现。开发规范和模板不等于这些条件已通过。任务开工状态见[准备清单](../development/readiness.md)。
