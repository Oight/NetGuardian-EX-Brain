# NetGuardian 代码审查与功能盘点

日期：2026-10-24。审查：Codex 辅助。目标仓库 `/home/eight/Project/NetGuradian/NetGuardian-EX-Brain`，HEAD `157e956d7b85ec7a0cbec8e5a17753c590e295a4`，开始审查时工作树干净。

业务 v4.2、内部契约 0.2.0、外部信封 0.1.0。对照 design_document 的主设计、S01—S12 设计、集成/边界说明，以及 code/docs/development/tasks 的当前阶段和验证记录。未将提案提升为必做目标。

## 审查结论

工程基座已形成，S01 公共契约、S02 初始存储、S03 桌面宿主基础能力和独立 S07 原子预算已有真实源码。业务调查闭环尚未形成：S04/S05/S06/S08/S09/S10/S11 没有业务实现，S12 只有最小状态页。表、类型、fake、测试预置数据的存在不等于相应业务功能完成。

本次复现 3 项 P2 问题。建议在后续模块接入前修复。未修改目标仓库或业务源码；运行检查、安装依赖和添加探针均在当前工作区的隔离副本完成。

## 可复现问题

### R1 · P2 · Facade 的错误分支绕过输出 schema

位置：[facade.ts:159](/home/eight/Project/NetGuradian/NetGuardian-EX-Brain/code/apps/desktop/runtime/facade.ts:159)。

处理器成功结果通过 parseDesktopOutput 校验；失败结果直接返回，未校验 AppError，也未使用新增 parseRpcResponse 统一校验错误信封。若注入模块错误对象含未知 code 或额外字段，这些内容会穿过 IPC 返回页面。现有测试覆盖非法成功对象和抛异常，没有覆盖非法错误对象。

复现：合成 CaseService.create 返回 `{ok:false,error:{code:'UNKNOWN_REVIEW_CODE',message:'synthetic error',retryable:false,password:'synthetic-review-only'}}`。Facade 实际响应仍包含该额外 password 字段；同一响应被公开 parseRpcResponse 拒绝。此处使用纯合成字符串，未读取真实秘密。

影响：接入真实适配后，异常错误对象可能破坏外部协议，或使本应拒绝的调试字段进入 renderer。建议在统一响应出口校验成功/失败两种结果，非法对象映射为安全 INTERNAL，并增加错误分支反例。

### R2 · P2 · 后台任务同步抛错会永久留下 active 标记

位置：[recovery.ts:41](/home/eight/Project/NetGuradian/NetGuardian-EX-Brain/code/apps/desktop/runtime/recovery.ts:41)。

定时器先调用立即执行的 async 函数，再把 Promise 放进 active。若 work 在返回 Promise 前同步抛错，catch/finally 会同步完成，先执行 active.delete；随后 active.set 又把已经完成的 Promise 放回去。后续 tick 因 active.has(name) 永久跳过该任务。

复现：2ms 定时任务第一次同步抛错，其余调用本应成功，等待 60ms。实际只调用 1 次、报告 1 次错误，此后不再执行。建议先登记运行状态再调用 work，或将调用延迟至已登记后的微任务，确保 finally 一定清除当前运行标记。

影响：后续装配告警轮询、请求 tick 或投递 tick 时，一次同步异常可能使对应循环停止。当前生产组合尚未接入这些后台业务，本问题发生在已交付的通用调度工具。

### R3 · P2 · 干净副本无法直接执行文档中的 Bun 统一检查

位置：[check.ts:8](/home/eight/Project/NetGuradian/NetGuardian-EX-Brain/code/scripts/local/check.ts:8)、[core/package.json:6](/home/eight/Project/NetGuradian/NetGuardian-EX-Brain/code/packages/core/package.json:6)。

新预算测试从公开子路径 @campussec/core/requests/budgets 导入；运行时导出指向 dist/requests/budgets.js。Bun 本机脚本先运行测试，后构建，且 tsconfig 没有该子路径的源码映射。标准 npm 总检查已调整为先构建，但 Bun 路径遗漏了对应调整。

复现：排除依赖/缓存/全部 dist 的 209 文件副本，Bun 离线冻结安装、禁脚本后直接执行 `bun scripts/local/check.ts`：预算测试文件无法加载，提示 Cannot find module '@campussec/core/requests/budgets'；整体失败，其余 82 个测试通过。先单独执行 `bun scripts/product/build.ts` 再执行相同检查，87 个测试与全部后续编译通过。

影响：本机禁止 Node/Electron 的成员无法按当前文档直接复现新预算测试，已有 dist 会掩盖问题。建议将构建放到消费者测试之前，或明确实现可用且一致的源码解析路径，并验证真正没有旧生成物的 Bun 检查。

## 当前功能状态

| 子系统 | 当前已实现 | 未实现或尚未完成 |
|---|---|---|
| S01 公共契约 | 137 个原文声明、70 个数据 interface 的 schema、43 个 Desktop 方法输入/输出；严格信封、RPC 响应关联、控制/取证工具信封、ResultPackage；时间/范围/字节限制、规范 JSON、摘要与本地游标 | 不代表 43 个业务操作已落地；R1 是生产出口没有完整使用校验 |
| S02 存储与事件 | 49 表初始 DDL、v1 初始化/校验、WAL/FK/FULL、串行同步事务、失败整体回滚、拒绝 thenable/过期句柄、主体空间隔离、事件序号与缺口恢复 | B1 正式接手仍 planned；没有通用多版本增量迁移器；案件业务不属于建表完成 |
| S03 桌面宿主 | 实际 bootstrap、单实例/窗口/托盘、沙箱 preload、有限 IPC、Facade、设置 CAS 持久化、秘密引用与保护适配、同快照摘要、导出保存对话框、恢复/关闭与身份切换基础工具 | S04—S11 实际装配、宿主身份变化接线、完整后台业务、通知链路、安装包；R1/R2 需修复 |
| S04 Wazuh | 契约与说明 | 真实 ConnectionService、认证、TLS、权限/能力核实、设备/统计读取、分页与查询适配 |
| S05 告警 | 设计与 B0 材料 | 轮询、源去重、收件箱、通知、策略 epoch、候选合并与自动触发 |
| S06 案件与证据 | 契约、DDL 与测试预置数据 | 案件创建/编辑/检索、背景版本、不可变证据、投影交付、封存、迁移与清理原语 |
| S07 请求与调查 | 独立 createRunBudget：工具 12/读取 10/平台尝试 20/不同事件 300；事务预占、持久化、代次/过期/取消/hold fence、预算竞争与回滚 | 请求受理/幂等/补输入、队列调度、每日自动预算、取消/超时/恢复、工具账本、实际取证、留存/发布/完成协调；预算组件尚未进入生产调查链 |
| S08 TeleAgent | 契约与执行/来源/投递 fake | 真实宿主认证、专用配置、可信来源、建会话/提交/核实/取消和 wire driver |
| S09 MCP | 契约及 channels/gateway 目录说明 | 两类实际协议入口、通道/grant/token/可信绑定、角色隔离与实际发送确认 |
| S10 配置与报告 | 结构 schema、DTO 样例和 B0 计划 | PreparedProfile/Skill/提示材料生成、可信引用/语义核查、人工审核修订、结果版本、核查事项、实际 Markdown/JSON 报告导出 |
| S11 投递 | 契约、outbox 表与投递 fake | 订阅、排 outbox、worker、原来源回传、去重/回执/核实/重试/恢复 |
| S12 工作台 | 最小真实状态页：宿主状态、案件/排队/活动数量、最近案件、托盘开关、事件刷新 | 案件操作、证据/背景/步骤界面、调查入口、预算/取消/恢复操作、人工核查/导出/投递和完整用户验收 |

当前可见产品能力主要是启动桌面基座、保存设置、控制托盘和查看本地摘要。新用户不能通过当前 UI 创建案件、发起调查、审核/导出报告或把结果回传 TeleAgent；这些不是单纯缺少凭据，而是对应业务实现尚未存在。

## 开发阶段与设计协调

- T002 将 A1/A2/A3/A4a 标为 done，依据 3ee347c 已进入 main；A4b 和 A5 未完成。A1—A3 工程交付不等于整个 S03 或 S07 业务完成。
- B0 已完成：29 表/44 方法映射、36 个未来产品验收场景与 10 个原生 DDL 探针。B1—B4 未启动；现有 S02 是可复用旧基座，不能推定 B1 已正式验收。
- C/D 当前没有新增产品执行成果。A 的交付已提供 B1/C1/D1 所需公共基座，消费者仍需记录实际启动/依赖提交和验收。
- B0 的 G03 公共 fake 已交付；G01 封存持久化归属、G02 处理备注入口、G05 语义核查口径仍需协调。G04 自动受理失败的真实业务原子性尚待 S07/S05 实现，当前只验证底层整体回滚机制。
- 原工作流删除导致设计检查失败的问题已修复；根工作流仅手动触发。目录中仍存在一些历史基准/未验收措辞，当前阶段以产品任务文件和本次源码核对为准。

## 本次实际验证与证据边界

所有可写操作位于 `/home/eight/Project/GPT/campussec/.local/reviews/netguardian-157e956-2026-10-24/`。其中 snapshot.json 保存 209 个受版本控制文件的哈希、原路径和 HEAD；repository 是隔离副本。没有运行副本中的 prepare:electron/test:electron/desktop/check:clean，也没有执行任何 Node/npm/npx 或 Electron。

| 验证 | 本次结果 |
|---|---|
| 新 workspace/依赖生命周期审查；Bun 1.4.4 离线冻结安装，显式 ignore-scripts | 通过，使用已有缓存安装 15 个外部包，未执行安装钩子 |
| 干净副本直接运行 Bun 统一检查 | 失败：R3，预算包尚未构建；没有将该失败改记为通过 |
| 先单独构建，再运行同一 Bun 检查 | 通过：类型、42 个源码边界、原文/DDL/schema、锁图、87 个测试、构建和标准测试代码编译 |
| 针对性探针 | R1/R2 均复现；脚本位于副本 code/review-probes.ts；不计入既有 87 个测试 |
| Python 3.12 环境发现 | 不可用，本机未安装该解释器；未更改系统 Python 或设计要求 |
| uv 使用已有 Python 3.14 执行两个设计脚本 | 通过：17 工程文档/137 声明/49 表；46 Markdown/224 本地链接/19 组件。不能记录为 Python 3.12 验收 |
| uv/Python 3.14 执行 B0 核验 | 通过：29 表/44 方法/36 planned 场景/31 链接，10 个 SQLite 3.54.0 原生 DDL 探针。未执行 B 产品服务 |
| Node/npm、实际 Electron、Windows、OS 保护、安装包与线上 Actions | 本次未执行；目标仓库的 A 线记录报告 Windows/Node/Electron 验证通过，属于其他执行环境的记录 |
| 真实 Wazuh/TeleAgent/模型/MCP/结果投递 | 本次未执行，当前相应业务也未落地 |

87 个测试包含 43 个 Desktop 方法的结构往返，它们不是 43 个真实业务场景；B0 的 36 个 planned 场景也不计入产品通过数。Electron 启动/SQLite 设置重启验证不等于安装包或案件创建闭环验收。

收尾核对：原仓库 HEAD 仍为 157e956，209 个受版本控制文件逐一 SHA-256 与审查开始快照一致，原工作树仍干净。本次审查没有写入原仓库。

## 建议实施顺序

1. A 修复 R1/R2/R3 并补相应反例，完成无旧产物的 Bun 复验。
2. B 正式接手 B1，再交基本 B2 CaseService/CaseAtomicPort；封存部分先落定 G01。
3. C 通过现有 HTTP/Secret fake 开始 C1 Wazuh 适配，同时推进宿主/通道的公开窄端口；D 使用 DesktopApi fake 开始 D1。
4. A 在上述端口交付后推进 A4b；B/C/D 再接报告、outbox、真实工作台和三入口组合，最后分层验收 M0—M4、安装包与完整 P0。
