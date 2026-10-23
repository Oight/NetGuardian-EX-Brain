# 本地业务核心

本目录按业务所有权组织，尚无业务实现或可调用导出。根 package.json 的 exports 为空，防止把目录准备误当成功接口。各域新增源码与 tests 后，再由 A 维护真实公开子路径和装配。

| 路径 | 归属 | 职责 |
|---|---|---|
| alerts | B / S05 | 告警、收件箱、触发决策 |
| cases | B / S06 | 案件、背景、证据、投影 |
| requests、investigations | A / S07 | 生命周期、预算、工具、留存、发布、完成协调 |
| reports | B / S10 | 草案校验、核查、结果包、导出 |
| delivery | C / S11 | 订阅、outbox、worker、回执 |

S07 唯一决定任务终态；跨所有者使用窄端口和同步 InTx，不访问私有 Repository 或直接写他表。
