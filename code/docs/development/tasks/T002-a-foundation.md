# T002 · A：工程、桌面与调度

状态：planned（尚未正式领取；旧基座可复用，缺少产品合并依据）。唯一状态位置：本文件。分支入口：task/T002-a-foundation。

分工来源：`120c81cfd4d8ed720c9cc70178edb9c6fd172a34`；实际产品 base/执行者/依赖合并 commit：未提供。允许路径见[结构归属](../structure.md)的 A 线，不写 renderer 或物理迁移。

| 阶段 | 状态 | 前置实际交付 | 目标 |
|---|---|---|---|
| A1 | ready | 无产品依赖 | workspace、ESM/strict、最小桌面构建与目标环境小验证 |
| A2 | planned | A1 | S01 runtime schema 与公开入口 |
| A3 | planned | A2 | 独立 testkit、失败/竞态、实际检查和外部 CI |
| A4 | planned | A3、B1/B2、C2 窄端口 | S07 请求/预算/工具/终态/恢复；S03 接线与安装包 |
| A5 | planned | B3、C4、D3 | 三入口与故障恢复，分别登记真实证据和缺口 |

## 可复用成果与交接

已有 contracts、testkit、宿主基座和检查工具，[本次验证](../../verification/structure-2026-10-23.md)只代表本机结果，不能直接把 A1—A3 标 done。Node/npm/Electron/安装包未验收，S07 未实现。

A 单任务维护共享文件，不接管 B/C/D 业务；S07 唯一决定终态，跨所有者调用同步 InTx。按[统一命令](../commands.md)和[交接模板](../workflow.md)补齐准确实现/合并记录。
