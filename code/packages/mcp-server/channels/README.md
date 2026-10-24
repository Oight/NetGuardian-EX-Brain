# 独立证据通道

公开入口 `@campussec/mcp-server/channels`：`createEvidenceChannels({db,secrets,clock,ids})` 实现 EvidenceChannelPort；`createChannelAuthenticator({db,secrets,clock})` 提供 transport 内部的 `authenticate(systemContext,{channelId,token,trustedSessionBindingId})`，返回受限 evidence Context 与 transportBindingId。

构造不监听网络。管理和认证入口只接受可信 system Context；认证检查 pending/active/revoked、角色、主体、身份/连接/工具代次、恢复屏障、取消和期限，并在异步秘密访问后再次检查。只写 mcp_grants，不回调工具、预算或调度。

令牌使用 256bit 随机值的 UTF-8 base64url 表示，仅存于 SecretPort（persist=false）；库保存 SHA-256。宿主适配器用 handle.secretRef 和导出的 channelSecretPurpose(handle.id) 借用令牌，不写 URL、提示词或工具参数。重启后须撤销旧 grant，并由 S07 推进 toolEpoch 后重新准备。

bindChannel 的 trustedSessionBindingId 由可信宿主适配器提供；字符串或合成测试不证明真实宿主绑定。认证器也不接收模型自报身份。transport 字段仅描述候选协议，未启动 MCP 服务或核实真实协议。

测试在 tests/，使用真实临时 SQLite 和项目 SecretStore；运行结果与环境限制见 [T004 本次记录](../../../docs/development/tasks/T004-c-integrations.md#2026-10-24独立证据通道按路径认领)。gateway、真实宿主、工具路由和桌面装配仍由后续任务接入。
