# 演进与过时内容说明

版本地位依据原设计索引及各文件正文，不能将两个工作区的版本号直接横向比较。

| 阶段 | 保留位置 | 当前处理 |
|---|---|---|
| 早期总体架构与工作流 | [原架构](reference-index.md#source-31)、[早期工作流](reference-index.md#source-32) | 历史讨论；自研导入/解析/检测职责与旧双入口不能覆盖 v4.2 |
| 早期系统 v0.1 | [Markdown](reference-index.md#source-33)、[导出材料](reference-index.md#source-34) | 历史；PDF、流程图、ZIP 和生成器只对应 v0.1 |
| 早期业务 v0.2 | [业务草案](reference-index.md#source-16) | 当时优先于 v0.1，记录实时/短期事件响应方向；已不是全工作区的当前基线 |
| 自研 v1 | [历史文档](history/security-triage-mvp-design.md) | 已被 v4.2 替代 |
| 开源复用 v2 | [历史文档](history/security-triage-open-source-design.md) | 多机平台与 Python 方案不再作为当前实施主线 |
| 单机 v3 | [历史文档](history/security-triage-single-host-design.md) | 同机服务、首周计划与资源预算不作为 v4.2 交付承诺 |
| 设计修订提案 | [历史取舍](history/security-triage-design-revision-plan.md) | 解释修订原因，不独立改变主设计 |
| 当前 v4.2 | [主设计](current/security-triage-client-design-v4.md) | 当前设计基线；文件正文日期 2026-10-20；尚未实现与端到端验收 |
| 2026-10-21 环境核实 | [Wazuh 观察](current/wazuh-capability-assessment-2026-10-21.md) | 实验事实与限制；不能自动替代设计或补足受限身份验收 |
| 2026-10-21 讨论稿 0.1 | [细化提案](proposals/security-triage-client-detail-proposal.md) | 当前候选细化，未替代 v4.2 |
| 2026-10-23 工程契约0.2.0 | [修订记录](implementation/changes-0.2.0.md)、[协作规范](development/README.md) | 修订可维护工程包的内部边界与协作流程，业务仍v4.2；外部信封0.1.0，尚未实现/联调 |

v4.2 已明确替代“学校已有 Wazuh”“MCP 一律不得派发任务”和只有告警起点的旧表述；三个入口共享任务核心，但委派与取证权限分开。当前架构将平台检测与客户端调查分工，不恢复自研采集和检测职责。

原研究索引中“当前 v0.2”和原 `AGENTS.md` 中的优先规则都属于源工作区的历史上下文。[原说明文件](reference-index.md#source-35) 已保留，新的工作区入口与规则统一指向 v4.2。

过时内容保留原件，避免失去讨论过程或实验出处；当前可读副本只增加状态标记和调整链接，未据此生成新的设计版本，也未重新导出旧 PDF。
