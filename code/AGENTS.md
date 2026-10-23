# campussec 实现约定

- 遵守父目录 AGENTS.md，尤其本机禁止启动 Node.js、npm、npx 和 Electron。共享 package.json 中的标准命令只供其他成员/外部环境使用，本机只执行明确的 Bun/uv 命令。
- 业务实现来源为只读设计仓库的 c8f152eae64395b24f965decfc3e434e0e0b8ae1；四线分工核对到 120c81cfd4d8ed720c9cc70178edb9c6fd172a34。业务 v4.2、工程 0.2.0、外部 0.1.0。
- spec/ 保留本次原文快照。packages/contracts 是产品唯一类型/schema 出口；spec 不是运行时代码依赖。
- 构建产物使用标准 ES modules；包之间只通过 @campussec 公开出口访问。
- 各功能必须明确真实、合成或不可用。未完成 S04—S12 不用空数组/成功占位代替。
- 本机检查只证明 Bun 下的严格类型、SQLite 和合成业务行为；Node.js/Electron/Windows/打包验收另记待执行。

## 多人协作

- 先读 [目录与归属](docs/development/structure.md)、[工作流程](docs/development/workflow.md)和[任务入口](docs/development/tasks/README.md)。A 负责 S01/S03/S07 和共享工程；B 负责 S02/S05/S06/S10 及物理迁移；C 负责 S04/S08/S09/S11；D 负责 S12 和用户验收。
- 当前用户授权本次整理覆盖以上路径，只做结构、检查入口与交接整理；不表示四线业务任务已领取或依赖已放行。之后按具体任务允许路径工作，不自行启动子 Agent。
- 根配置、两份锁、packages/contracts、packages/testkit、scripts、桌面装配和 CI 同一时刻仅 A 的一个任务修改；迁移由 B 修改；renderer 由 D 修改。跨线需求写入自己的交接段。
- 公共 fake 位于 packages/testkit，只依赖 contracts 和包内文件；真实 SQLite/文件夹具位于 tests/support，不得反向进入公共 fake 或产品入口。
- 模块测试跟随模块，跨模块夹具及工程检查位于 tests；测试运行器只选择源码对应测试，忽略旧构建产物。新增业务包不得暴露私有 Repository。
- docs/development/tasks 是本实现目录的唯一实时任务位置；docs/history 与旧验证记录只供追溯。未合并、不具备准确产品 commit 的成果保持 checking/planned，不写 done。
- 本机统一运行 `bun scripts/local/check.ts`；源码边界单独运行 `bun scripts/product/check-boundaries.ts`。npm 命令仅供其他成员/外部环境。
