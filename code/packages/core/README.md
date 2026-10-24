# 本地业务核心

本目录按业务所有权组织。已实现公开入口：`@campussec/core/requests/budgets`、`@campussec/core/cases`、`@campussec/core/reports` 和 `@campussec/core/investigations/tools`。调查工具层尚未接请求生命周期与 MCP 协议入口；alerts、delivery 及其他调查协调用例仍待实现。按任务路径维护公开子路径和装配，不导出成功占位。

| 路径                     | 归属    | 职责                                       |
| ------------------------ | ------- | ------------------------------------------ |
| alerts                   | B / S05 | 告警、收件箱、触发决策                     |
| cases                    | B / S06 | 案件、背景、证据、投影                     |
| requests、investigations | A / S07 | 生命周期、预算、工具、留存、发布、完成协调 |
| reports                  | B / S10 | 草案校验、核查、结果包、导出               |
| delivery                 | C / S11 | 订阅、outbox、worker、回执                 |

S07 唯一决定任务终态；跨所有者使用窄端口和同步 InTx，不访问私有 Repository 或直接写他表。
