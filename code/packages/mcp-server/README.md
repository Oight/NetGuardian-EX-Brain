# S09 · 通道与 MCP 入口

channels 管理随机凭据、pending/active/revoked 和可信宿主绑定；gateway 实现回环 Streamable HTTP、鉴权与发送前复核、Host/Origin 检查、两角色目录及路由、严格参数和最多 16KiB 的回复。catalog 从公共 schema 生成嵌套参数结构。

HTTP 工具实际发送后才释放投影；中断或失去权限记 uncertain。默认没有可信宿主认证适配时，生产网络入口关闭。回环真实 HTTP 与生产组合测试已覆盖，不代表 TeleAgent 2.7.1 的实际 MCP 客户端已通过联调。
