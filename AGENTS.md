# campussec 工作约定

## 入口与基线

- 先读根 README、docs/README.md、docs/project-status.md 和 [开发入口](docs/development/README.md)。
- 业务基线是 [v4.2](docs/current/security-triage-client-design-v4.md)，文件名中的 v4 不代表旧版。内部工程契约为 0.2.0，外部 IPC/MCP/导出信封为 0.1.0；以 [边界](docs/implementation/boundaries.md)、contracts.ts 和 schema.sql 唯一原文为准。
- docs/proposals 是候选讨论，不自动替代基线。调查档案、版本对照和局部重查仍非已确认完成条件；docs/history 仅供追溯。
- Wazuh 是冻结的首个上游；本次仓库初始化不授权扩展上游选型、部署或改造。

## 三账号轻量协作

- 2026-10-23 用户确认采用轻量流程：一条 main 主线、短任务分支、完成者自检并合并。PR 和他人复核按需使用，不要求专职审查者、固定集成负责人或另一账号审批。
- 当前任务状态唯一位置为 docs/development/tasks 内的具体任务文件；若将来迁往 Issue，明确切换位置，避免维护两份状态。
- 产品实现任务开始前填写实际 base commit、依赖、允许路径、检查命令和交接要求。无产品基座时不声称 12 模块全面可开工。
- 同时工作的任务使用独立分支与独立目录；不得在共享目录并发切分支。共享契约、DDL、根配置、锁、装配和 CI 同一时刻仅一个任务写入；当次完成者负责协调，不设长期专人。
- 合并前自查差异和实际文件清单，执行本任务检查及受影响组合检查。记录失败、未执行和限制；以准确 commit 保存依据。
- 不自行启动多个子 Agent；是否委派依当前用户任务的明确要求。

## 实现与证据边界

- S07 独占任务终态和跨模块应用用例；S06 不回调预算/MCP，S10 不读任务私表决定取消，S09 通道管理独立于协议入口。跨所有者事务调用 InTx，禁止事务内 await 或直写他表。
- 区分设计静态、合成业务、模拟模型、真实文本、真实工具及结果投递。不得用成功占位检查、空数组或 unavailable 改成功来通过验收。
- 现有材料未证明真实模型、专用 Skill、两类 MCP 与实际 Wazuh 的完整调查闭环。历史授权不延续为读取进程凭据、创建真实会话、消耗模型额度或访问平台的授权。
- 不打印或提交凭据、会话密钥、数据库及个人运行日志。不要自动运行历史研究脚本；未入库材料由提供者另行共享，其署名和访问范围见[来源登记](docs/reference-index.md)。

## 维护与检查

- 文档使用 UTF-8 和相对链接，协作说明不写个人绝对路径或临时权限处理过程。来源、署名和个人环境说明的维护不视为新的业务版本；导入依据见[初始化记录](docs/development/repository-setup.md)和 docs/source-imports.json。
- 初始项目设计与研究材料由 Shimakaze-17900 提供并署名；仓库文字整理标明 Codex 辅助，后续贡献按文内说明及 Git 历史归属。第三方资料保留自身出处，Git 提交署名不自动证明其他来源的原作者。
- 引用必须区分仓库内可读文件和未入库来源；来源登记不是报告正文。历史结果记录执行者、日期、环境和验证层级，不将某次电脑环境或结果写成全组条件、当前状态或共同验收成绩。
- 本地检查：python -B scripts/design/verify_subsystem_designs.py；python -B scripts/design/verify_development_docs.py。--sync 只用于有意更新工程包内嵌块，CI 只读检查。
- Node --check 仅语法；源码依赖检查、runtime schema、产品 tsc/构建和共享 testkit 仍待产品基座实现。
- 本地可逆工作按任务授权继续；远端推送、GitHub 配置及真实外部操作依当次授权。
