# T003 · B 线：存储、案件证据、告警与报告

- 负责工作线：B；具体成员账号不预设，领取者填写执行记录。
- 唯一状态位置：本文件；状态：ready（仅首阶段；其余阶段按表中依赖放行）。
- 指定分支：`task/T003-b-local-domain`。
- 已核对设计 base commit：`9ea33e27bf3d488c355e4706abccaba3c19a5244`。
- 外部操作：默认无；仅本地可逆实现及离线验证。

## 允许修改路径

packages/storage/、packages/core/alerts/、packages/core/cases/、packages/core/reports/、packages/investigation-profile/、docs/development/workstreams/b/。docs/implementation/schema.sql 仅确有迁移差异且完成跨线协调时修改；设计内嵌块同步交 A 串行处理。

## 子任务与顺序

| 阶段 | 初始状态 | 依赖 | 交付 |
|---|---|---|---|
| B0 | ready | 无产品依赖 | S02/S05/S06/S10 实现拆解、表/事务与端口映射、案件/证据/报告合成验收材料；先放 docs/development/workstreams/b/ |
| B1 | planned | A1、A2；A3 对应存储 fake 已合并 | S02 SQLite 初始化、版本迁移、同步事务和事件端口 |
| B2 | planned | B1、A3 | S06 案件/背景/证据/投影；为最小桌面链路提供创建、保存、重启回读的真实业务接口 |
| B3 | planned | B2；A4/C2 对应接口可消费 | S05 告警去重/收件箱/触发决策；S10 配置、草案引用校验、核查、结果包与导出 |
| B4 | planned | A4、C4、D3 | 配合三入口业务组合验收、证据留存和版本冲突修复 |

阶段依赖引用对应工作线任务文件；A1/A2/A3 等均指已合并的实际交付，不指仅有任务计划。全线状态 ready 只允许启动首阶段，不能自动放行全部产品实现。

## 实现与验收重点

B0 可立即交付合成 JSON、预期结果和实现清单；不得据此宣布存储实现通过。B1 检查迁移、约束、整体回滚、重启回读、单写入者及表所有权。驱动选型与根依赖由 A 根据实际打包验证写锁。

B2 覆盖不可变证据、revision/CAS、重复写、覆盖缺口、过期与引用，不回调预算或 MCP。B3 保持 S10 不决定任务终态、不读任务私表决定取消；告警事务调用 S06 InTx；报告校验使用可信 ReportValidationInput。B4 不通过直写 S07/S11 表修补组合错误。

## 启动、依赖与共享规则

只指定本任务分支名即可按本文件开始；先读根 AGENTS、README、开发入口、boundaries、对应 Sxx 设计和权威 contracts.ts/schema.sql。业务 v4.2、内部契约 0.2.0、外部信封 0.1.0。

分支名是待创建的本地工作线名称，不表示已创建或已推送。以包含本分工文件的 main 提交创建独立 clone/worktree，再记录 `git rev-parse HEAD` 的实际启动 commit；下列设计 base 是已存在的设计基准，不是未来实现依赖已交付的声明。不要从旧 base 创建一个缺少本任务文件的工作目录。启动前执行 `git status --short`、`git branch --show-current` 和 `git rev-parse HEAD`，保留他人改动。独立目录不得放入版本控制；工作区外创建目录须遵守环境权限。

先把当前阶段改为 in_progress，记录执行 Agent/成员和实际 base。阶段编号是本文件内的子任务，实时状态只维护在此。前置未合并时继续可独立完成的离线阶段，不复制邻模块业务、不另造公共接口。依赖合并后记录准确 commit，合入 main、核对 API 与检查命令后才将下一阶段置 ready。分阶段小步合并，后续可使用原分支名加阶段后缀的短分支；每次更新实际 base。done 必须已合并 main 且有检查证据。

每条线只能修改本任务文件及列出的允许路径；模块自有 package.json、测试和合成夹具包含在对应包目录授权内。根配置/锁/公共 testkit/公共契约/装配/CI 由 A 独占写；物理 DDL 与迁移由 B 独占写。其他线将具体接口或依赖请求写入自己的交接段，交给所有者处理，不自行夹带共享变更。需要调整权威设计时先由 A 协调消费者，DDL 内容交 B；同步内嵌块由 A 单独串行执行。

真实模型、宿主会话、Wazuh、凭据、额度及远端操作均未由本任务预先授权。默认合成离线验证，禁止读取进程凭据或自动运行历史研究脚本。真实验证条件不足时保持 unverified，不把 fake 成功写成真实能力完成。

## 每阶段检查与交接

现有检查：`python -B scripts/design/verify_subsystem_designs.py`、`python -B scripts/design/verify_development_docs.py`、`git diff --check`；同时核对 `git diff --name-only` 的实际路径。

A 交付前，产品检查命令属于未提供；仅离线阶段可据自身交付验收。A 交付后统一使用 `npm run typecheck`、`npm run build`、`npm test`、`npm run check:boundaries`；A 必须实现这些真实命令，不能提供空脚本。模块任务运行相关模块测试，合并前运行受影响组合检查；全量命令无法运行时记录原因，不能宣称产品阶段通过。首次安装以锁文件执行 `npm ci`，驱动或工具链不可用时记录限制。

每阶段交接填写：实际 base 与依赖 commit、实际修改文件、公开入口及消费示例、行为与失败场景、命令/执行环境/结果、证据层级、未执行项、未提交内容、准确实现及合并 commit。不得填写未来自引用 commit；后续记录提交补充依据。PR/他人复核按需，不设固定审批者。

## 执行记录

- 当前执行者：尚未领取；分配到本工作线的成员或 Agent 启动时填写。
- 实际启动 commit、依赖合并 commit：尚未启动，按上述规则填写。
- 检查与交付：尚未执行产品实现；本文件为分工，不是完成证据。
