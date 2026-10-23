# 轻量协作开发入口

日期：2026-10-23；协作规范版本 0.2。当前按用户要求采用[四人工作线](tasks/README.md)，实际账号不预设。用户确认以一条 main 主线、短任务分支、完成者自检并合并协作；PR 与他人复核按需使用，不设专职审查者、固定集成负责人或强制另一账号审批。本约定替代导入资料中较重的角色分工与 PR 完成门槛。

业务仍为 v4.2，内部工程契约仍为 [0.2.0](../implementation/README.md)，外部信封仍为 0.1.0。仓库初始化不表示产品基座或真实调查闭环已完成。

初始项目资料由 Shimakaze-17900 提供并署名，规范与文档由 Codex 辅助整理。共享文档以仓库根目录为路径基准；外部材料按[来源登记](../reference-index.md)说明，不要求其他成员拥有提供者的目录、账号或验证环境。

## 阅读顺序

1. 根 [AGENTS.md](../../AGENTS.md)与[贡献流程](../../CONTRIBUTING.md)。
2. [子系统边界](../implementation/boundaries.md)、自己的 Sxx 设计、[契约](../implementation/contracts.ts)和 [SQL](../implementation/schema.sql)。
3. 当前任务单、实际 base commit、允许路径、检查命令与依赖提交。

## 信息位置

| 信息 | 当前唯一位置 | 更新方式 |
|---|---|---|
| 代码、设计、接口和长期决定 | main 上已合并文件 | 完成者检查后合并，PR 可选 |
| 任务状态、范围、依赖和阻塞 | docs/development/tasks 中的任务文件 | 记录检查及准确 commit；同一文件跟进 |
| 验证结果和交接 | 对应任务文件或版本化验证记录 | 标明环境、命令、证据层级和限制 |
| GitHub Issue/PR | 尚未启用，后续按需 | 启用时明确任务状态切换，避免双份看板 |

任务完成者同时负责范围自查、检查记录与本次合并。共享契约、DDL、根配置和锁文件同一时刻只交一个任务写；跨模块变更在修改前明确消费者和兼容影响。

## 配套文件

- [工作流程](workflow.md)、[工程规则](engineering-rules.md)、[文件归属](ownership.md)
- [任务模板](task-template.md)与[四人分工及分支入口](tasks/README.md)
- [开工准备](readiness.md)、[GitHub 可选接入](github.md)与[仓库初始化记录](repository-setup.md)

尚无产品 workspace、runtime schema 或共享 fake/testkit。详细文档不能代替这些依赖，当前不能全面并行启动 12 个模块。
