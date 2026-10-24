# 校安智脑 · campussec

面向高校安全运维的安全调查工作台。业务 v4.2，内部契约 0.2.0，外部信封 0.1.0。当前已接入本地业务、调度、MCP 回环入口和结果投递，并有生产装配合成验收；真实 TeleAgent/Wazuh 与当前 Windows Electron 验收仍未全部通过。

- [全项目严格核验与剩余项](code/docs/verification/project-audit-2026-10-24.md)
- [产品入口](code/README.md)、[运行与检查](code/docs/development/commands.md)
- [当前任务与历史分工](code/docs/development/tasks/README.md)、[结构归属](code/docs/development/structure.md)
- [设计入口](design_document/docs/README.md)、[设计与实现阶段说明](design_document/docs/project-status.md)
- [共享开发约定](CONTRIBUTING.md)、[手动同步与冲突处理](code/docs/development/git-sync.md)

产品命令在 code/ 执行，设计检查在 design_document/ 执行。根 .github/workflows 的检查工作流仅手动触发，保持此前关闭自动检查的决定；未执行的线上结果不记为通过。

初始设计与研究资料由 Shimakaze-17900 提供并署名；实现与文档整理由 Codex 辅助，后续贡献以 Git 历史与文内说明为准。
