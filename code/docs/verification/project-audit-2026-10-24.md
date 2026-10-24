# 全项目严格核验与补全 · 2026-10-24

当前结论：**本地实现与合成业务闭环已有实质补全，整个项目尚未全部验收完成。** 不按页面存在、接口类型存在或测试数量推算完成百分比。当前任务为 [T008](../development/tasks/T008-project-completion.md)，旧 A/B/C/D 分工仅保留历史记录。

起点为实际拉取的 `28c5185`，工作分支 `task/project-completion-audit`。本记录区分实现、合成验证、真实接入和分发；新改动未以“已合入 main”放行。

## 本轮确认的原始问题

1. 标准 TypeScript 检查不通过：S10/Profile/工具已有源码，但公开出口、workspace 或声明路径缺失。冻结 spec 文件被重新格式化后又与已登记原文哈希不符。
2. S05、S07 请求生命周期、S08 执行/宿主、S09 网络网关、S11 投递没有完整产品实现。已有 S06/S10/工具模块也没有全部接入生产 compose。界面完整不能代表业务已经可执行。
3. 旧验收仍以 requests.create 返回“未实现”为成功条件，无法证明真实请求能够排队、取消、恢复或产生结果。
4. 本轮进一步组合测试暴露：收件箱新材料无法附案、未知设备材料被误当成越权数据而整页拒绝、种子事件预算标识不一致、请求/执行期限混用、全局 token 阈值可被策略时区/额度覆盖、取消后的无限中止请求，以及委派读取连接摘要与 S04 连接管理权限不匹配。均有对应修复，不能仅靠模块 fake 发现这些问题。

## 逐模块实际状态

| 模块 | 当前实现和代码证据 | 本轮验证与剩余限制 |
|---|---|---|
| S01 契约/工程 | [公共导出](../../packages/core/package.json)、[workspace 验证](../../scripts/product/verify-workspaces.ts)、spec 原文恢复、两份锁与 tsconfig | 43 个 Desktop 方法保持冻结契约；18 个公共包入口实际导入；未用改哈希期望值掩盖格式破坏 |
| S02 存储 | [真实 SQLite](../../packages/storage/src/index.ts)、既有迁移与同步事务、[冻结轮次映射的增量迁移](../../packages/storage/migrations/0003-run-mapping.sql) | 打开/重开、身份隔离、失败回滚、原子 outbox/清理已走真实库；不复制另一套内存业务实现 |
| S03 桌面/装配 | [compose](../../apps/desktop/runtime/compose.ts)、[bootstrap](../../apps/desktop/main/bootstrap.ts) | 已接案件/报告/请求/告警/工具/宿主驱动/投递/留存/发布、恢复屏障、定时器、原生通知提供者；真实 Electron 当前启动失败，见下文 |
| S04 Wazuh | [适配器](../../packages/wazuh-adapter/src/index.ts)、[查询](../../packages/wazuh-adapter/src/queries.ts) | 真正经过规范化、身份/范围/代次/预算、登录和固定上界；Node 合成接口与生产组合通过。认证/FIM/漏洞行映射、稳定多页 Indexer 与真实权限仍有未核实能力，继续明确拒绝或 partial；未接真实 Wazuh |
| S05 告警 | [业务实现](../../packages/core/alerts/index.ts)、[专项测试](../../packages/core/alerts/tests/alerts.test.ts) | 首次历史/重启恢复、固定上界/去重、通知意图、策略 CAS/epoch、候选分组、固定合并窗口、原子派发和预算拒绝后保留提醒。真实迟到回放、风暴/长周期行为与 OS 通知可见性未验收 |
| S06 案件/证据 | [案件与附案](../../packages/core/cases/cases.ts)、[采集](../../packages/core/cases/queries.ts)、既有投影/清理/封存 | 已验证收件箱来源授权附案；无设备身份仅可作为系统收件箱材料保存，不能因此进入未知设备的调查范围。真实查询/引用/回滚组合通过 |
| S07 调度/完成 | [请求状态机](../../packages/core/requests/service.ts)、[预算](../../packages/core/requests/budgets.ts)、[工具用例](../../packages/core/investigations/tool-runner/index.ts)、[留存](../../packages/core/investigations/retention.ts)、[人工发布](../../packages/core/investigations/publication.ts) | 幂等/补范围/20 队列/单活动槽/主动优先、独立 TTL、每日预占与未知 usage 停派、取消与终态 fence、重启 hold、5/15/60s 最多三次自动核实、显式放弃、完成同事务。封存保留准备时映射，连接代次变化不算正常成功；实际宿主执行仍依赖 M0 |
| S08 宿主 | [执行账本](../../packages/teleagent-bridge/execution/index.ts)、[来源与投递窄端口](../../packages/teleagent-bridge/host-access/index.ts)、[驱动测试](../../packages/teleagent-bridge/execution/tests/execution.test.ts) | 提交意图先落库、输入一致性/消息关联、10s 超时未知、迟到响应不改事实、拒绝绑定重定向。**真实 Windows 接口适配未完成**；ExecutionWire/HostWire 为注入边界，默认不伪造可用宿主 |
| S09 MCP | [网络网关](../../packages/mcp-server/gateway/index.ts)、[实际参数目录](../../packages/mcp-server/gateway/catalog.ts)、[通道](../../packages/mcp-server/channels/index.ts) | 真实回环 HTTP、Host/Origin/协议/鉴权、角色分离、模型不能指定 Actor/来源、发送前 fence、实际发送后释放投影、停止撤权。合成客户端通过，TeleAgent 实际客户端未联调 |
| S10 报告 | [报告入口](../../packages/core/reports/index.ts)、既有校验/核查/导出/Profile | 已接入生产并经过实际工具引用、完成封存、人工核查后单独发布；不让报告模块决定任务终态。合成业务通过，真实模型材料未验收 |
| S11 投递 | [投递实现](../../packages/core/delivery/index.ts)、[组合验收](../../tests/acceptance/delivery-lifecycle.test.ts) | 最小不可变结果、来源订阅、outbox 与结果/终态原子提交、固定键、可见回执、断线先核实、absent 才退避重试、unknown 阻止自动发送；真实原会话回传未完成 |
| S12 UI | [工作台](../../apps/desktop/renderer/app.ts)、[调查页](../../apps/desktop/renderer/investigations.ts)、[Electron 验收](../../scripts/electron/foundation-smoke.cjs) | 接入真实新增服务；静态 CSP/沙箱/renderer 依赖和 IPC 组合通过。当前设备 GUI 启动失败，不能把历史截图或本轮 Node 测试视作人工页面/托盘验收 |

## 已运行的业务组合

- [生产本地案件](../../tests/acceptance/local-cases.test.ts)：真实 compose → 可信 IPC → typed client → 建案/背景/CAS/重开 → 请求排队与取消，没有预置案件或真实网络。
- [生产调查链](../../tests/acceptance/investigation-flow.test.ts)：真实调度/SQLite/Profile → 实际随机通道与可信绑定校验 → 回环 MCP HTTP → S07 工具 → S04 合成接口映射 → S06 采集/实际投影 → 按第一次返回的规则构造第二次查询 → 报告实际引用 → 完成/manifest/结果。继续覆盖人工审核不自动发布、显式发布幂等、清理与工具回复缓存原子失败回滚。
- [生产自动告警链](../../tests/acceptance/automatic-flow.test.ts)：合成 Server 登录/设备与 Indexer → 真实 S04 → 历史不派发 → 实时策略/候选 → S06 种子 → S07 原子受理/每日预占。没有宿主时明确生成 failed 和实际 runId，不伪称完成调查。
- [请求生命周期](../../tests/acceptance/request-lifecycle.test.ts)：来源伪造、幂等冲突、补范围、持久排队、重启 hold/CAS、提交响应丢失不重提、未知占槽/三次核实、显式放弃、超时前撤权、消息关联、独立 TTL，以及 22 次并发受理只能产生 20 组请求/任务/案件。
- [每日额度](../../tests/acceptance/daily-quotas.test.ts)：失败/重启不退款、当日上限、未知用量不当成已知零。
- [投递链](../../tests/acceptance/delivery-lifecycle.test.ts)：结果与 outbox 同事务、发送丢回执/重启、found/absent/unknown、稳定投递键、原对话绑定不可重定向、跨角色读取拒绝、真实来源委派路由，以及 outbox 写入失败整笔回滚。

这些测试的宿主/平台响应明确是合成的；业务服务、数据库、HTTP 网关、权限、引用和事务是实际实现。没有付费模型调用、真实平台扫描或个人会话操作。

## 检查结果

| 检查 | 结果 |
|---|---|
| Node 24.15.0 / npm 11.12.1 / Windows x64 | 实际使用，便携工具链在忽略目录；不改系统全局工具链 |
| npm run check | 通过；最终复验 232 项测试，0 失败；包括类型/构建/workspace 实际出口/renderer/边界/spec/锁 |
| npm run check:clean | 通过；干净源副本排除 dist/node_modules/缓存，冻结离线安装 24 个包后重新检查，232/232 |
| 设计 verify_subsystem_designs.py | 通过；离线设计检查，不能代替产品执行 |
| 设计 verify_development_docs.py | 通过；离线设计/链接/依赖检查 |
| npm run test:electron | **实际运行失败**，不是跳过或通过；Chromium 安装目录 ACL 拒绝，且系统保护加密报告失败，尚未进入完整页面验收 |
| 安装包、签名、安装/卸载 | 未执行，当前仍无已验收分发物 |
| 真实 Wazuh / 模型 / TeleAgent / 原对话回传 | 未执行，未获得当次真实连接/凭据/额度授权及完整接口证据 |

Electron 尝试没有关闭 sandbox、降低 CSP 或改成明文存储。对本地运行时补充系统要求的只读 ACL 被 Windows 拒绝；当前代理不能把这一环境限制当作已修复。测试入口支持 `--electron-dir` 指向另一处同锁定版本运行时，仍验证实际版本。复测步骤见[检查命令](../development/commands.md)。日志/临时库只在忽略目录，不随项目提交。

## TeleAgent 静态证据与真实接入边界

用户说明目标为能找到的最新 Windows 版本，没有 API/MCP 原文。已只读核对本机已安装包：TeleAgent **2.7.1**，主入口 main-loader.cjs；app.asar SHA-256 为 `68d21d65351ca422681b35e031c3935a2549abf10e1daacac1fc62075c2e7528`。这说明本轮实际检查对象，不宣称它始终是官方最新发布。

安装包的 42 个静态 runtime JS 中发现 SDK 路由候选：`/ready`、`/session`、`/session/{sessionID}/prompt_async`、消息读取、`/session/{sessionID}/abort`、`/mcp` 与 `/config` 等。仅有路由名不能证明可信来源、每轮专用 Profile/技能/工具隔离、提交消息归属或原对话非模型回传。未读取个人 userData、进程参数、签名密钥、既有会话，也未向这些路由发送真实请求。

[原设计的宿主核实条件](../../../design_document/docs/implementation/08-teleagent.md)仍然有效；网关采用的回环协议约束可对照 [MCP 2025-06-18 transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)。不能把普通 MCP 可连接或 HTTP 204 当作上述能力已经验证。

## 仍不能标为“整个项目完成”的工作

1. M0：对 TeleAgent 目标版本实现并核实真正的 ExecutionWire/HostWire/可信 transport 适配。必须能证明专用隔离、来源/提交消息绑定、远端终态、原对话外部消息可见回执与投递核实，不能从“当前会话”或模型参数推定。
2. S04 真实平台权限、各版本认证/FIM/漏洞字段映射、稳定多页 Indexer、监测设备范围与未知设备提醒、迟到/休眠/风暴回放仍需补齐可复核样本与验收。当前显式 unavailable/partial 是限制说明，不是完成标记。
3. 冻结契约未提供 blocked 投递的显式恢复命令，缺少单独的用量/估算/未知项 UI 查询视图，以及动态监测范围/更细通知策略的配置接口。当前有本地结果取回和持久额度记录；这些接口/页面缺口需要后续契约修订并配套实现，不能以数据库字段存在代替产品交付。
4. 当前 Windows Electron 实测、原生通知可见性、托盘/退出/身份切换与人工工作台验收，以及可分发安装包/签名/安装卸载尚未全部完成。

上述剩余项不会被改写成 done。本轮可复核的本地代码已经可以继续开发；当前状态不是“只剩上传或随便配一个 API 就能完成”。
