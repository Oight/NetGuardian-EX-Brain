# 本地仓库初始化记录

日期：2026-10-23。用户同意在原工作区下建立 campussec 本地仓库，并确认三账号小组采用轻量协作。

## 范围和结果

- 仓库目录：D:\design_agent\campussec；默认分支 main。初次建库前没有 base commit；第一笔初始化提交建立后续任务的真实基准，不能虚构前置提交。
- 选择性导入 docs 设计/规范、scripts/design 两个离线检查及 .github 文本模板/工作流；根入口、协作规范和忽略规则按本次决定更新。
- 不创建产品 package.json、锁、runtime schema、fake/testkit、客户端代码或安装包。产品基座和真实调查闭环仍未完成。
- 原资料工作区不是 Git 仓库，sourceGitCommit 为 null。来源文件 SHA-256 保存在 [source-imports.json](../source-imports.json)，表示导入时的工作副本快照，不替代原迁移清单或归档原件哈希。
- 未导入 private、research、archive、reports 或 migration。原研究和实验报告引用改为 [来源索引](../reference-index.md)，保留原路径与引用关系；仓库外报告不伪装为仓库内可读证据。
- 原工作区文件和归档原件不修改；新仓库的文档副本适配不构成新的业务设计版本，契约/SQL/合成向量原文保持。
- 仅本地初始化和提交；没有配置远端、推送、创建 Issue/PR、修改 GitHub 权限或执行线上 CI，也未调用模型、宿主或 Wazuh。

## 已确认的协作决定

main 保存检查通过的共同版本，每任务使用短分支；并发工作使用独立目录。完成者自检、保存检查记录并合并，PR 和另一成员/Agent 复核按需使用，不设专职审查者、固定集成负责人或强制另一账号审批。

初期任务状态统一保存在 docs/development/tasks，后续按需切换到 Issue；共享文件一次只交一个任务写入。本决定覆盖导入资料中较重的角色/PR流程要求，技术边界和证据标准继续保留。

## 核验方式

在仓库根目录运行两个离线设计检查，并在支持 TypeScript 解析的 Node 上增加 --node-syntax；核对文档链接、来源快照和契约/SQL原文。提交前检查纳入文件清单、忽略规则和 git diff --cached --check；提交后检查分支、HEAD、工作区状态及远端为空。

具体执行结果见[本次核验记录](repository-verification.md)。这些检查不能证明产品 tsc、构建、安装包、真实宿主/MCP/模型/Wazuh 或线上 CI 已通过。

## 后续起点

从初始化后的实际 main commit 建立产品基座任务，明确允许路径、依赖版本小验证和实际验收命令。不要用初始化仓库的完成替代产品基座 R03—R07，或宣称 12 个子系统已可全面开工。
