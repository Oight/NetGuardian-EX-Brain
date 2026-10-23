# T003 · B：存储与本地业务

状态：planned（尚未领取；已有 S02 已于 64443ed 入库，待 B 接手验收）。唯一状态位置：本文件。分支入口：task/T003-b-local-domain。

分工来源：`120c81cfd4d8ed720c9cc70178edb9c6fd172a34`；可领取产品基准：64443ed；执行者、实际启动 HEAD 与依赖验收 commit 在领取时填写。允许 storage、core/{alerts,cases,reports}、investigation-profile、自有测试和[本线交接目录](../workstreams/b/README.md)。物理迁移由 B 独占，根锁/公共导出交 A。

| 阶段 | 状态 | 前置实际交付 | 目标 |
|---|---|---|---|
| B0 | ready | 无产品依赖 | 表/事务/端口映射与合成验收材料 |
| B1 | checking | A1/A2、A3 对应 fake | S02 初始化/迁移/同步事务/事件 |
| B2 | planned | B1、A3 | S06 案件/证据/背景/投影，真实保存与重启回读 |
| B3 | planned | B2、A4/C2 对应接口 | S05 告警与触发；S10 配置/核查/结果包/导出 |
| B4 | planned | A4、C4、D3 | 三入口、留存与冲突组合验收 |

## 可复用成果与交接

[S02](../../../packages/storage/README.md)已有真实 SQLite 合成检查，初始 DDL 校验值不变；目标 Electron 兼容未验收。S05/S06/S10 当前只有目录说明。

S06 不回调预算/MCP；S10 不决定任务终态、不读任务私表解释取消。禁止直写 S07/S11 表修补组合错误。按[统一命令](../commands.md)和[交接模板](../workflow.md)记录结果，未合并依赖不放行后续阶段。

接手说明：根仓库与 code/ 共用 Git 历史。64443ed 只证明现有基座入库；A 当前复验未合并前，不自动放行本线后续阶段。A 的实际标准运行时结果见 T002。
