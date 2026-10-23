# 统一文档目录

> 仓库初始化说明（2026-10-23）：当前为独立本地 Git 仓库 main；采用[轻量协作](development/README.md)，PR 可选。下文的研究/归档引用经[来源索引](reference-index.md)保留，原件未随仓库导入；业务基线仍为 v4.2。

当前基线为 **v4.2**。版本状态依据原 `D:\design\README.md` 及各文件正文确定，不以文件修改时间排序决定。迁移文档副本已修复相对链接，并标注来源；原件可从文件顶部返回。后续新增的研究稿单列日期与状态。

| 状态 | 文档 | 阅读用途 |
|---|---|---|
| 当前基线 | [v4.2 客户端设计](current/security-triage-client-design-v4.md) | 三个调查入口、两类 MCP、客户端职责、证据、任务和结果回传的实施范围 |
| 当前验收计划 | [v4 实验与验收附录](current/security-triage-client-experiments-v4.md) | 数据准备、分支验证、对照和演示条件；计划不是实测结果 |
| 本轮工程设计 | [12 个子系统设计与交接入口](implementation/README.md) | 统一端口、各模块内嵌契约与 SQL、事务及集成验收；未发布新业务基线，尚未实现/联调 |
| 2026-10-23工程修订 | [0.2.0修订记录](implementation/changes-0.2.0.md)、[组件边界](implementation/boundaries.md) | 解除证据回调、集中终态、分开工具入口与应用编排；内部接口有兼容变化 |
| 开发与协作规范 | [Agent协作入口](development/README.md)、[开工准备](development/readiness.md) | 任务/归属/PR/检查/信息权威位置；规范就绪不表示产品基座已实现 |
| 已有环境观察 | [2026-10-21 Wazuh 能力核实](current/wazuh-capability-assessment-2026-10-21.md) | 管理员只读结果、接口限制、网络设备来源缺口 |
| 接入条件建议 | [2026-10-22 Wazuh 模块与 API 清单](proposals/wazuh-upstream-access-checklist-2026-10-22.md) | 官方文档核对、模块/API/权限与验收条件；非新增平台实测，未替代基线 |
| 旧凭据接入实测 | [2026-10-22 独立 API 重试](reference-index.md#source-25) | 当次指定账号重试：9200 连接拒绝，55000 认证 401；后续 Server 成功记录另列 |
| Server 接入实测 | [2026-10-22 Server 专用账号](reference-index.md#source-23) | 独立认证与单机清单/FIM 对象/SCA 抽样通过；最小权限、分页及严格 TLS 等待验收 |
| 最新 Indexer 接入实测 | [2026-10-22 Indexer 专用账号](reference-index.md#source-24) | 告警、归档与 24 小时聚合通过；根信息、漏洞及两类清单状态请求为 403 |
| 面板开发交接 | [2026-10-22 API 实测汇总与态势面板交接](reference-index.md#source-29) | 可转发的 Markdown：认证、接口、聚合请求、字段、权限限制与时间/数量口径 |
| 待评审提案 | [客户端、桥接与 MCP 细化提案](proposals/security-triage-client-detail-proposal.md) | 讨论稿 0.1；进程结构、契约、调查档案与创新候选 |
| 历史取舍依据 | [设计修订提案](history/security-triage-design-revision-plan.md) | 解释向 v4 迁移的原因，不恢复旧范围 |
| 历史 v3 | [单机方案](history/security-triage-single-host-design.md) | Wazuh 与 Python 研判服务同机的前版设计 |
| 历史 v2 | [开源复用方案](history/security-triage-open-source-design.md) | 多机 Wazuh、Vector、Kafka 与 Python 的前版设计 |
| 历史 v1 | [自研方案](history/security-triage-mvp-design.md) | 自研采集、解析、规则与多机服务的前版设计 |

[项目现状](project-status.md) 汇总已有成果与缺口；[演进与过时内容说明](version-history.md) 解释版本冲突的处理；[TeleAgent 研究入口](reference-index.md#source-30) 导向原始实验和分析。

早期业务草案 v0.2、v0.1 PDF/图集和原始架构保留在研究树中，适用于回顾讨论；它们不替代本目录的 v4.2 基线。未提供比赛规则、正式会议纪要或独立的最新需求确认文件，不从讨论稿推导额外承诺。
