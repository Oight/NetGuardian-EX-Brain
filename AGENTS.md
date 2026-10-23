# campussec 仓库入口

- 先读 README.md、design_document/docs/README.md、design_document/docs/project-status.md 和 code/docs/development/tasks/README.md。
- 业务基线 v4.2、内部契约 0.2.0、外部信封 0.1.0；设计权威在 design_document/docs/implementation，code/spec 是带哈希的冻结快照。
- 产品唯一实时任务位置为 code/docs/development/tasks；design_document 内同编号四线任务只作历史分工导航，不维护第二份状态。
- A/B/C/D 分支入口和权限见 code/docs/development/tasks/README.md 与 code/docs/development/structure.md。独立任务分支、独立目录；不自动启动子 Agent。
- 根工程、锁、公共契约/testkit、装配、检查与 CI 同时只由 A 一个任务写；B 维护物理迁移，C 负责外部接入，D 负责 renderer；当次完成者自检合并，无固定集成负责人。
- S07 唯一决定任务终态；跨所有者调用同步 InTx，不在事务中 await 或直写他表。S06 不回调预算/MCP，S09 通道管理独立，S10 不决定取消。
- 默认合成离线检查；历史授权不延续为真实模型、宿主、平台、凭据或额度授权。不打印/提交凭据、数据库与个人运行日志。
- 使用当前环境可用的 Node/npm 或 Bun；历史电脑限制不写成全组要求。安装默认禁用依赖脚本，真实 Electron GUI/打包分别记录。
- 文档 UTF-8、相对链接。初始资料由 Shimakaze-17900 提供并署名，Codex 辅助整理；来源和导入哈希保持历史可追溯。
- 设计检查在 design_document/ 执行两个 scripts/design Python 脚本；产品检查在 code/ 执行 npm run check。分层记录结果，不以静态检查或 fake 代替真实验收。
- 本地可逆实现按任务继续；远端推送、GitHub 配置及真实外部操作按当次授权。
