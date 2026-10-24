# T004 · C：上游、宿主、MCP 与投递

状态：checking（本地 C0/C1 离线材料和适配器已交付，真实平台未访问，尚无本轮提交或合并）。唯一状态位置：本文件。

分工来源：`120c81cfd4d8ed720c9cc70178edb9c6fd172a34`；可领取产品基准：64443ed；执行者、实际启动 HEAD 与依赖验收 commit 在领取时填写。允许 wazuh-adapter、teleagent-bridge、mcp-server、core/delivery、自有测试和[本线交接目录](../workstreams/c/README.md)；根依赖/锁/装配交 A。

| 阶段 | 状态     | 前置实际交付                    | 目标                                    |
| ---- | -------- | ------------------------------- | --------------------------------------- |
| C0   | checking | 无产品依赖                      | 离线 M0、查询映射、合成夹具、角色矩阵   |
| C1   | checking | A1/A2、A3 对应 HTTP fake        | S04 认证/分页/能力/受限查询             |
| C2   | planned  | C1、A3                          | S08 窄驱动；S09 独立通道/grant/可信绑定 |
| C3   | planned  | C2、A4 对应应用端口             | S09 薄协议入口、角色隔离、发送确认      |
| C4   | planned  | C2、B3 结果端口、A4 发布/outbox | S11 订阅/outbox/worker/回执/恢复        |
| C5   | planned  | A5、D3、当次真实授权            | M0—M4 真实证据与缺口                    |

## 交接

当前只有目录说明。[纯 testkit](../../../packages/testkit/README.md)可提供 HTTP/执行/投递失败与响应丢失场景；C2 先交窄端口供 A4 接线，C3 再消费 A4，不相互等待整模块。

不读取凭据或连接真实 Wazuh/宿主/模型，冻结首个上游。未知回执保持 uncertain，投递不重跑调查。按[统一命令](../commands.md)和[交接模板](../workflow.md)补齐记录。

接手说明：根仓库与 code/ 共用 Git 历史。64443ed 只证明现有基座入库；A 当前复验未合并前，不自动放行本线后续阶段。A 的实际标准运行时结果见 T002。

## 2026-10-24 本地续作交接

用户授权跨 A/B/C/D 串行推进，实际代码基准 cc610cb6447ca70659030cc597b486a12cd8d872，依赖 A1—A3 已合入的 3ee347c / 157e956。只写 /home/eight/Project/GPT/campussec；来源仓库只读。本地目录未建立产品 Git，本轮无实现/合并 commit，不把 checking 写成 main 已验收。

本轮功能、公开入口、失败与未执行项统一见[本地案件闭环验证](../../verification/local-cases-2026-10-24.md)。Windows 开发者可运行 `npm.cmd run test:windows:full`；本机未执行 Node/Electron。后续阶段按原表依赖推进，不用本轮合成材料放行真实接入。

2026-10-24 Review 补记：修复公开入参规范化、背景作用域/容量与平台来源/覆盖问题；Bun 干净检查 135/0，未提交/合并，外部 Windows/Node/Electron 未执行。见[本地 Review](../../reviews/local-implementation-2026-10-24.md)。

## 2026-10-24：独立证据通道（按路径认领）

- 状态：checking（本目录实现及补充验证完成，固定依赖环境待复验；不放行整个 C2）；本次用户授权按路径串行开发，不受原工作线限制；Codex，base `03f1448b36a2b8d38596e0fe0a490008da2a8312`，依赖 `3ee347c` / `157e956` / `c70a992` 已在 HEAD。
- 分支 `task/S09-evidence-channels`，工作目录 `D:/design_agent/campussec-channels`。范围 `code/packages/mcp-server/channels/**` 及本段；公开出口附带新增 `packages/mcp-server/package.json`、同步两份锁的 workspace 元数据。不改 gateway、契约、DDL、桌面装配。
- 目标：EvidenceChannelPort、transport 内部认证、同步数据库授权复核、撤销/轮换及真实临时 SQLite 测试。可信会话标识由系统适配器提供，字符串本身不证明真实宿主绑定。
- 检查：类型编译、模块及受影响测试、源码边界、锁图、`git diff --check`；依赖下载和已有冻结快照问题分别记录，未执行项不计通过。未启动网络监听或真实宿主/模型。
- 实现提交：`984d1886adb62b61f20c77c1435536ef167ac3bc`；保留在上述分支，未合并 main、未推送。公开入口及使用边界见 [channels README](../../../packages/mcp-server/channels/README.md)。
- 实际补充验证：Windows / Node 24.16.0，隔离副本 `.local/channel-check` 与最终通道源码逐文件一致；使用本机缓存 TypeScript 6.0.3、Zod 4.4.3、@types/node 26.0.0、undici-types 8.3.0，非项目锁定环境。测试源码编译通过；15 项新增测试及既有测试共 **150/0**，涵盖真实 SQLite、认证/撤销交错、轮换清理失败、代次/期限/身份、错误角色及数据库重开；源码边界 58 文件、两个设计检查、diff 检查通过。
- 标准检查限制：`npm ci --offline --ignore-scripts` 缺缓存；正常下载返回 EACCES。`verify-foundation.ts` 仍因基准 contracts.ts 快照哈希失配失败；`export-npm-lock.ts --check` 因未安装的依赖缺元数据失败。独立静态对照确认两份锁只新增本地 workspace，其他依赖和元数据均未变化；不将此项代替标准锁/干净安装验收。
- 首轮测试发现 Buffer.slice 共享内存导致清零影响令牌，已改为独立 Uint8Array 并复验；未改公共秘密存储。后续标准环境执行 `npm ci --ignore-scripts`、`npm run check`；S08/gateway/桌面装配、真实宿主和 Electron 接入仍未执行。
