# S09 独立证据通道

@campussec/mcp-server/channels 导出 createEvidenceChannels、createChannelAuthenticator。实现持久 grant、摘要/秘密引用、可信传输绑定、过期/撤销和主体/连接/工具代次核权，构造不启动传输。秘密不会交给 renderer，模型也不能自行选择 Actor。

认证在异步秘密访问后重新核权，撤销先持久化再清理秘密；并发创建/轮换与真实 SQLite 重开场景在 tests/channels.test.ts。真实宿主/网关装配未完成，见[T004](../../../docs/development/tasks/T004-c-integrations.md)。
