# T010 本地网页、校园代理与多账号鉴权

来源只读 HEAD：`a06b9a5`。工作位置：`/home/eight/Project/GPT/netguardian`，本副本没有可报告的新 Git 提交；未推送。当前实现以本页及验证记录为准，T008/T009 保留来源交接。

本轮完成源代码同步与维护接口接线、网页 HTTP/下载适配、校园代理接口映射、多账号 RBAC、签名会话、加密传输/凭据/数据库/导出、第二轮调查状态修复。新增独立 AuthApi 和加密存储依赖；冻结契约附件保持不变。

检查、逐项流程范围、运行命令和未执行项见 [验证记录](../../verification/web-auth-2026-10-24.md)；加密规则和边界见 [实现增量](../../../../design_document/docs/implementation/web-auth-2026-10-24.md)。Windows 开发者执行真实 Electron 验收；本机不启动 Node.js 或 Electron。
