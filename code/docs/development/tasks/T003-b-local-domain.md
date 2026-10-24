# T003 · B：存储与本地业务

> 此文件保留此前阶段的交接快照。当前全项目核验与剩余工作以 [T008](T008-project-completion.md) 为准；旧分工不限制本轮跨模块实现。

状态：checking（本地续作 B1/B2 已实现并完成 Bun/真实 SQLite 验证，尚无本轮提交或合并；原 B0 记录保留为来源历史）。唯一状态位置：本文件。

分工来源：`120c81cfd4d8ed720c9cc70178edb9c6fd172a34`；本轮实际产品 base：`1d379e11916fe03cc03e5355fc6c1ee108633b6c`；执行者：Codex（用户指定 B 线），2026-10-23。B0 无产品依赖，不以现有 S02 或设计提交推定 A/B 后续阶段已放行。允许 storage、core/{alerts,cases,reports}、investigation-profile、自有测试和[本线交接目录](../workstreams/b/README.md)。本轮实际写入限本任务文件与本线交接目录。物理迁移由 B 独占，根锁/公共导出交 A。

| 阶段 | 状态     | 前置实际交付        | 目标                                                                 |
| ---- | -------- | ------------------- | -------------------------------------------------------------------- |
| B0   | done     | 无产品依赖          | 表/事务/端口映射与合成验收材料；实现提交 88cd3f8 已快进合入本地 main |
| B1   | checking | A1/A2、A3 对应 fake | S02 初始化/迁移/同步事务/事件                                        |
| B2   | checking | B1、A3              | S06 案件/证据/背景/投影，真实保存与重启回读                          |
| B3   | planned  | B2、A4/C2 对应接口  | S05 告警与触发；S10 配置/核查/结果包/导出                            |
| B4   | planned  | A4、C4、D3          | 三入口、留存与冲突组合验收                                           |

## 可复用成果与交接

[S02](../../../packages/storage/README.md)已有真实 SQLite 合成检查，初始 DDL 校验值不变；目标 Electron 兼容未验收。S05/S06/S10 当前只有目录说明。

S06 不回调预算/MCP；S10 不决定任务终态、不读任务私表解释取消。禁止直写 S07/S11 表修补组合错误。按[统一命令](../commands.md)和[交接模板](../workflow.md)记录结果，未合并依赖不放行后续阶段。

## B0 执行与交接（2026-10-23）

- 执行者：Codex，用户确认承担 B 线。实际启动 base 为 `1d379e11916fe03cc03e5355fc6c1ee108633b6c`，从 main 建立独立 worktree 和 `task/T003-b-local-domain-b0`。此前环境清理单独保存为该准备提交，不计入 B0 文件范围。
- 实际允许/修改路径：本任务文件，以及 `code/docs/development/workstreams/b/` 下 README、b0-plan.md、b0-boundaries.md、b0-acceptance.md、b0-mapping.json、b0-fixtures.json、b0-scenarios.json、verify_b0.py。未修改产品源码、契约、DDL、迁移、根配置或锁文件。
- 交付入口：[B0 材料导航](../workstreams/b/README.md)。实现拆为 B1—B4 的 9 个单元；映射完整覆盖 S02/S05/S06/S10 的 29 张表、44 个服务方法、4 个窄 Pick 视图和 12 类事务安排；36 个场景包含具体合成输入、操作和未来预期。
- 跨线请求：[G01—G05](../workstreams/b/b0-plan.md)分别涉及封存持久化、处理备注入口、公共 fake、自动受理失败原子性、结构引用与语义核查口径。均未擅自修改产品接口；后续相关实现前由 A/B/C/D 对应所有者协调。
- 执行环境：Windows 11 x64，PowerShell 5.1，Python 3.12.6 / SQLite 3.45.3；本轮核验无需 Node/npm/Bun/Electron 或项目依赖。

| 命令 / 核对                                                               | 实际结果与证明范围                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `python -B code/docs/development/workstreams/b/verify_b0.py`（仓库根）    | 通过：29 表/44 方法、材料引用及哈希、36 个后续场景、B0 文档链接；10 个原生 SQLite DDL 探针覆盖唯一约束、FK、active/uncertain 互斥、CAS、业务/事件回滚和临时文件重开。未执行产品服务 |
| 材料核验反例（临时副本）                                                  | 缺表、虚构方法、失效 fixture 引用、篡改投影哈希均被拒绝，4 项通过；不计为产品测试                                                                                                   |
| `python -B scripts/design/verify_subsystem_designs.py`（design_document） | 通过：17 文档、137 契约声明、49 SQL 表、内嵌块/合成向量/事务约束                                                                                                                    |
| `python -B scripts/design/verify_development_docs.py`（design_document）  | 失败：尝试读取 base 已不存在的 `.github/workflows/design-checks.yml`，FileNotFoundError。保留失败，不恢复 CI 或降低检查                                                             |
| 开发规范脚本的 `check_links()` / `check_boundaries()` 单独运行            | 通过：46 文档/220 本地链接、19 组件/49 表及边界；仅代表已执行部分，不将上一行失败改记为成功                                                                                         |
| verify_b0.py 语法、`git diff --check`、实际路径核对                       | 通过；修改限本任务与 B 线交接目录                                                                                                                                                   |
| 产品 typecheck/build/test、Electron/安装包、Wazuh/宿主/模型/MCP/投递      | 未执行；B0 不提供这些验收结论，36 个场景的 expected 仍是后续产品验收预期                                                                                                            |

首轮 DDL 核验曾因重开连接未显式关闭，导致 Windows 临时库清理失败；已用显式 closing 修复并复验通过。首次遗留的一个 512 KiB 合成临时库位于系统临时目录，自动审批以 `blocked by policy` 拒绝清理；后续核验的临时库正常关闭与清理。

实现/合并 commit：`88cd3f86b16c2af8b1c41c66901aa0b8126ffa89`（docs(b): prepare B0 domain plan and acceptance materials）；2026-10-23 从阶段分支以 fast-forward 合入本地 main，无独立 merge commit。本段在合并完成后补记，不预填自身提交哈希。B1 及后续阶段继续 planned，本轮止于 B0；未推送远端。

## 远端整合补记（2026-10-23）

合入远端 `6d033ba` 及其 A 线交接：产品基座源提交为 `64443ed`，A 的标准运行时复验依据见[T002](T002-a-foundation.md)和[接手验证](../../verification/a-handoff-2026-10-23.md)。现有代码已入库不替代阶段验收；远端将 B1 写为 checking 的接手标记不视为本机已启动 B1，用户指定的 B0 完成状态及 B1—B4 planned 保留。

B0 表中的完整开发规范检查失败属于当时执行快照。远端将检查入口迁至根工作流；本次同步修正工作流原有残留冲突标记并重新核验，当前结果另见[同步记录](../../verification/sync-2026-10-23.md)，不改写 B0 历史结果。

## 2026-10-24 本地续作交接

用户授权跨 A/B/C/D 串行推进，实际代码基准 cc610cb6447ca70659030cc597b486a12cd8d872，依赖 A1—A3 已合入的 3ee347c / 157e956。只写 campussec；来源仓库只读。本地目录未建立产品 Git，本轮无实现/合并 commit，不把 checking 写成 main 已验收。

本轮功能、公开入口、失败与未执行项统一见[本地案件闭环验证](../../verification/local-cases-2026-10-24.md)。Windows 开发者可运行 `npm.cmd run test:windows:full`；本机未执行 Node/Electron。后续阶段按原表依赖推进，不用本轮合成材料放行真实接入。

2026-10-24 Review 补记：修复公开入参规范化、背景作用域/容量与平台来源/覆盖问题；Bun 干净检查 135/0，未提交/合并，外部 Windows/Node/Electron 未执行。见[本地 Review](../../reviews/local-implementation-2026-10-24.md)。
