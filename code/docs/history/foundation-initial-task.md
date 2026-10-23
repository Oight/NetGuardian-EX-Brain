# T002 · S01/S02/S03 工程基座

> 历史记录：旧授权任务与当时路径保留，仅供追溯。新版 A 线状态见 [T002-a-foundation](../development/tasks/T002-a-foundation.md)，本文件不再维护实时状态。

- 状态：checking（实现与本机检查已完成；尚未进入产品 Git main，外部验收未执行）；用户授权：在当前工作区实现 S01、S02、S03，并写入本机工具链约束。
- 实现目录是新目录，当前没有产品 Git base；只读设计源实际 commit：c8f152eae64395b24f965decfc3e434e0e0b8ae1。
- 依赖：设计 contracts/schema/architecture 0.2.0；实际版本记录在根依赖及锁文件。
- 允许路径：本项目内文件以及父目录 AGENTS.md；原设计仓库只读。
- 交付：严格契约/schema、SQLite 迁移/事务/事件、秘密存储、受控 IPC/Facade、恢复与桌面入口；共享 fake 与实际行为检查。
- 检查：Bun 执行 TypeScript 编译器、标准测试用例、构建脚本及本地约束检查。Python 如需使用通过 uv。
- 本机不启动 Node.js/npm/npx/Electron，不执行依赖安装钩子，不访问宿主/模型/Wazuh。
- 完成条件：实现行为、检查和限制可复核。无产品 Git main 时不将本任务写作已合并 done；外部 Node/Electron/Windows/安装包验收保持未执行。

## 结果

实际路径：packages/contracts、packages/storage、apps/desktop、fixtures/shared、tests、scripts、spec、docs、根配置和外部 CI 文件；父目录 AGENTS.md 记录本机约束。

S01 按十个领域保留 137 个原文声明，实现 70 个 DTO interface 和 43 个 Desktop 方法的 schema、规范化与边界校验。S02 分离空间、迁移、数据库和事件，使用原文 49 表 DDL，真实 SQLite 文件检查通过。S03 实现秘密、受控 IPC/Facade、恢复/关闭、身份切换保护和最小桌面入口；未装配业务返回明确不可用。

实际统一命令：bun scripts/check-local.ts。严格类型检查、设计/锁图/源码边界检查、25 个行为测试、标准模块及测试代码编译通过。本机只使用 Bun 执行这些命令。PR/独立复核未使用，未提交、推送或触发远端任务。

干净临时副本的 Bun 冻结锁文件离线安装和完整检查再次通过；不是新增 25 个不同测试。原设计仓库状态检查为空，确认未改动。

未执行：npm ci、Node.js/Electron/Windows、安装包、真实系统保护、模型/宿主/MCP/Wazuh。Electron 入口只完成编译；这些是后续验收条件，不能记录为通过。[详细记录](../verification/foundation-2026-10-23.md)。
