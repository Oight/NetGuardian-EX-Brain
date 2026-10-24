# TeleAgent 接入实现与分层验证 · 2026-10-24

结论：**已实现固定版本的独占后端执行适配，并跑通项目核心与真实 TeleAgent 后端的合成工具调查链。真实桌面账号的文本与取消也已验证；完整真实模型工具调查、可信对话委派和原对话外部结果回传仍未验收。** 当前任务见 [T011](../development/tasks/T011-teleagent-m0.md)。

基于 `177815d9c4123ac73f1a45d6e40166b20640443c`，在独立任务分支实现；未修改研究原件、冻结契约、旧迁移或 TeleAgent 安装/全局配置。业务仍为 v4.2，工程 0.2.0，外部业务信封 0.1.0。

实现提交 `a85b7cb39db02fa89850a61d9417e169273d33ce` 已快进合入 main。用户随后授权同步，远端 main 已推送并回读核实到 `961f7c9da7af33df2f2d81c762366decec9e1d58`，包含实现与交接；未运行线上 Actions。该同步只交付下述已实现范围，不表示完整 M0 通过。

## 版本依据

当前设备安装包标注 **2.7.0**，正在运行的后端与父工作区保留的分析样本 SHA-256 一致：

`632ae07bf98e976dc18fb0118feb9bc38be35e1c31352c06621757c55ed60184`

安装包随附 OpenAPI 的 SHA-256 为 `1e65ea3d83296711bcbd0729107f7d53281cf5207cf85910a862322f268defce`；启动管理源码摘录为 `73f3af90021ab8eb8f678f2cae4de0b15c2ccc48ca416b8ffbb434036769bad6`。代码和新增实测共同确定本次映射；不将另一设备的 2.7.1 记录或随包 OpenAPI 推定为实际兼容保证。其他哈希默认拒绝启动。

## 已实现

- [签名客户端](../../packages/teleagent-bridge/execution/teleagent/client.ts)：显式回环地址与独立工作目录，对最终编码路径/查询做 local-v1 HMAC；每次使用新 nonce，拒绝重定向，限制超时与响应大小，不自动重试写请求，不输出认证头或上游原文错误。
- [版本启动器](../../packages/teleagent-bridge/execution/teleagent/launcher.ts)：核对实际二进制哈希，为每轮生成独立密钥及数据/配置/缓存/设备/工作目录，通过 stdin 传递启动载荷；不读取桌面账号数据。模型和审查配置由操作者显式提供，合成验收默认只允许回环服务。
- [执行适配](../../packages/teleagent-bridge/execution/teleagent/index.ts)：专用 Agent/Skill 文本与默认拒绝权限回读校验；每轮只配置一个证据 MCP。创建会话后立即保存映射，再绑定随机证据凭据，最后提交；回读实际用户消息，按 parentID、完成时间、finish/error 识别终态和取消。tool_calls、204、空闲或已有文字都不能代替完成。
- [可信通道装配](../../packages/mcp-server/gateway/owned-auth.ts)：凭据只由可信启动装配登记，绑定独占实例已创建的会话；模型参数和 HTTP 会话声明不决定 Actor、轮次或路由。每次读取和发送前复核授权，结束、撤销、身份锁定及退出时关闭通道/子进程。
- [执行账本](../../packages/teleagent-bridge/execution/index.ts)：异步操作中的会话检查点保留已知映射以核实丢失响应；检查身份、连接/工具代次、任务状态和期限。超时关闭提交窗口，迟到回调不能改账本；没有发生模型提交的失败记为 not_submitted，业务任务实际失败。
- [生产装配](../../apps/desktop/runtime/compose.ts)：网页和桌面可以显式启用适配。默认仍不连接宿主；未实现的可信委派与外部回传能力继续显示 unverified。

### 实测纠正的接口假设

这个样本的 `POST /mcp` 确实发生握手，但返回空状态，后续 `GET /mcp` 也没有保留该通道；不能把握手当成登记成功。本实现采用重新验证的路径：独占后端启动配置登记 `enabled:false`，创建会话并完成应用侧可信绑定后调用 `POST /mcp/campussec/connect`，轮询确认 connected 才提交模型任务。

prompt_async 的 204 可能早于用户消息可读。本实现短时回读确认提交消息；到期限仍未确认时保留 uncertain，并沿用原会话核实，不新建或重提。首轮组合曾因过早观察而使通道进入 uncertain，修复后完整链与取消均通过。

## 验证证据

| 层级 | 本次实际结果 | 不支持的结论 |
|---|---|---|
| 静态与模块测试 | 最终检查见任务交接；覆盖签名编码、nonce、错误体脱敏、响应上限、消息错配、工具中间轮、取消、检查点/代次和通道伪造/撤销 | 不替代模型或平台验收 |
| 真实后端 + 合成模型/上游 | 实际 S07、SQLite、TeleAgent、S09 HTTP、S04 映射、S06 投影、S10 报告和完成事务；四次工具调用、两次查询，第二次使用第一次返回的规则；另一次运行中取消通过 | 查询选择由脚本生成，不证明真实研判质量或真实 Wazuh 覆盖 |
| 真实桌面模型文本 | 新会话 NewApi/chat-pro；两条合成证据引用与标记、用户/助手 parent 关联和正常 stop 通过，未调用工具 | 路由别名不证明底层供应商/版本，也不证明专用 MCP/Skill 调查 |
| 真实桌面运行中取消 | 第二个新会话已出现输出后请求 abort，观察到本次 parent 关联的 MessageAbortedError | 取消回包中的零 usage 不证明实际计费为零 |
| 空闲测试会话 noReply | 不调用模型的追加可回读，短时观察未生成新助手消息；原生角色为 user | 不证明外部结果消息、忙碌会话无干扰、幂等或原对话异步投递 |

最终 Windows x64 / Node 24.15.0 / npm 11.12.1 标准检查 **273/273**，干净源副本冻结离线安装后复验 **273/273**；类型、构建、公开出口、renderer、源码边界、spec 和锁图均通过。两个设计检查通过；Node 网页入口实际启动返回 HTTP 200。干净副本初次因本工作目录缓存不全而 ENOTCACHED，补齐同完整性缓存后复验通过；没有放宽检查。新增文档链接无缺失，基准已有的 7 处缺失设计增量链接未在本任务编造修补。

本轮真实模型任务总数为 **2**，未读取其他会话内容、未修改全局配置、未连接真实 Wazuh。签名材料仅在获授权实验的 Python 内存使用，未保存认证头、密钥、完整 provider 配置或 reasoning。该研究取密钥方法不进入默认产品启动。

本机原始报告在忽略的 `.local/teleagent-acceptance/` 和 `.local/live-teleagent/authorized-20261024/`；不提交临时数据库、凭据或个人运行日志。[机器摘要](teleagent-m0-checks.json)只共享必要结论。

## 运行与交接

在 code/ 使用锁定 Node/npm，先执行常规检查。实际二进制由操作者提供，不随仓库分发：

```powershell
npm.cmd run test:teleagent -- --binary=C:/approved/TeleAgent-go.exe
```

该命令只运行独占后端、回环脚本模型/审查和合成上游；任一阶段失败均返回非零，不调用桌面账号模型额度。

真实运行通过 `--teleagent-config=<绝对路径>` 显式传入操作者配置文件。文件放在被忽略的 `.local/` 或秘密目录。字段为 binaryPath、model（baseUrl/modelId/apiKey）、review（baseUrl/accessKey/secretKey）及可选 allowRemoteServices。默认只允许回环服务；远程服务须显式设为 true，并按当次使用授权运行。桌面本地签名密钥与模型/审查凭据属于不同层，不能互换。

```powershell
npm.cmd run web -- --teleagent-config=C:/approved/private/teleagent.json
npm.cmd run desktop -- --teleagent-config=C:/approved/private/teleagent.json
```

同时修正 Node 网页入口加载源码中 .js 相对导入会失败的问题：构建后的启动器加载实际 dist 模块；Bun/Node 共用标准产物，不复制运行时代码。桌面 GUI/打包未在本轮重新验收。

[授权桌面实验脚本](../../scripts/teleagent/live-desktop-check.py)要求显式实验开关、已审阅 helper 的精确哈希及新的授权范围，不是普通启动命令。本轮两任务计数已用尽，不再次运行覆盖记录；不把过去授权延续到下一次。

## 剩余 M0

1. 为现有桌面提供稳定的签名/账号桥接；当前产品只支持明确版本的自管独占实例，没有默认进程凭据读取。
2. 真实模型与本项目专用 Skill/受限证据工具的同一条调查尚未执行；真实文本与真实后端合成工具分别留证。
3. 委派需要来源会话/请求消息证明；模型参数、静态 MCP Header、marker 或 HTTP session ID 不能代替可信来源。
4. 原对话需要外部消息、可见回执、幂等和 found/absent/unknown 保证。noReply 的 user 角色探针不满足条件，HostWire 相关能力保持不可用。
5. 独占进程退出后不自动重建未知模型任务；依靠持久映射、既有 uncertain/显式放弃流程，不声称支持跨进程继续执行。
