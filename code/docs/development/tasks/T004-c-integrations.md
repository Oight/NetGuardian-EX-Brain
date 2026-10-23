# T004 · C：上游、宿主、MCP 与投递

状态：planned（尚未领取，无真实接入）。唯一状态位置：本文件。分支入口：task/T004-c-integrations。

分工来源：`120c81cfd4d8ed720c9cc70178edb9c6fd172a34`；可领取产品基准：64443ed；执行者、实际启动 HEAD 与依赖验收 commit 在领取时填写。允许 wazuh-adapter、teleagent-bridge、mcp-server、core/delivery、自有测试和[本线交接目录](../workstreams/c/README.md)；根依赖/锁/装配交 A。

| 阶段 | 状态 | 前置实际交付 | 目标 |
|---|---|---|---|
| C0 | ready | 无产品依赖 | 离线 M0、查询映射、合成夹具、角色矩阵 |
| C1 | planned | A1/A2、A3 对应 HTTP fake | S04 认证/分页/能力/受限查询 |
| C2 | planned | C1、A3 | S08 窄驱动；S09 独立通道/grant/可信绑定 |
| C3 | planned | C2、A4 对应应用端口 | S09 薄协议入口、角色隔离、发送确认 |
| C4 | planned | C2、B3 结果端口、A4 发布/outbox | S11 订阅/outbox/worker/回执/恢复 |
| C5 | planned | A5、D3、当次真实授权 | M0—M4 真实证据与缺口 |

## 交接

当前只有目录说明。[纯 testkit](../../../packages/testkit/README.md)可提供 HTTP/执行/投递失败与响应丢失场景；C2 先交窄端口供 A4 接线，C3 再消费 A4，不相互等待整模块。

不读取凭据或连接真实 Wazuh/宿主/模型，冻结首个上游。未知回执保持 uncertain，投递不重跑调查。按[统一命令](../commands.md)和[交接模板](../workflow.md)补齐记录。

接手说明：根仓库与 code/ 共用 Git 历史。64443ed 只证明现有基座入库；A 当前复验未合并前，不自动放行本线后续阶段。A 的实际标准运行时结果见 T002。
