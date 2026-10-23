# campussec 共享开发约定

先读 [README](README.md)、[设计入口](design_document/docs/README.md)、[项目阶段](design_document/docs/project-status.md)和[产品任务](code/docs/development/tasks/README.md)。设备专属环境与 Agent 角色写入各自被 Git 忽略的 AGENTS.md；共享规则保存在本文及关联文档。

- 业务基线 v4.2、内部契约 0.2.0、外部信封 0.1.0；设计权威在 design_document/docs/implementation，code/spec 为带哈希的冻结快照。
- 产品任务的唯一实时位置为 code/docs/development/tasks；设计目录的同编号四线任务只作历史导航。
- A/B/C/D 的分支入口和范围见[任务入口](code/docs/development/tasks/README.md)与[目录归属](code/docs/development/structure.md)。每项任务使用独立分支、独立目录；不自动启动子 Agent。
- 根工程、锁、公共契约/testkit、装配、检查与 CI 同时只由 A 的一个任务写；B 维护物理迁移，C 负责外部接入，D 负责 renderer。当次完成者负责自检及合并，无固定集成负责人；明确授权的跨目录整合按当次范围执行。
- S07 唯一决定任务终态；跨所有者调用同步 InTx，不在事务中 await 或直写他表。S06 不回调预算/MCP，S09 通道管理独立，S10 不决定取消。
- 默认合成离线检查。历史授权不延续为真实模型、宿主、平台、凭据或额度授权；不打印或提交凭据、数据库与个人运行日志。
- 使用当前环境可用的 Node/npm 或 Bun；历史设备限制不作为全组要求。检查环境默认禁用依赖安装脚本；Electron GUI 和打包分别记录实际结果。
- 文档使用 UTF-8 和相对链接。初始资料由 Shimakaze-17900 提供并署名，Codex 辅助整理；来源和导入哈希保留历史可追溯性。
- 设计检查在 design_document/ 执行两个 scripts/design Python 脚本；产品检查在 code/ 执行 npm run check。分层记录结果，不以静态检查或 fake 替代真实验收。
- 本地可逆实现按任务继续；远端推送、GitHub 配置及真实外部操作依据当次授权。

[日常协作流程](code/docs/development/workflow.md) · [手动同步与冲突处理](code/docs/development/git-sync.md) · [产品贡献说明](code/CONTRIBUTING.md)
