# T005 · D 线：界面、用户流程与验收场景

- 负责工作线：D；具体成员账号不预设，领取者填写执行记录。
- 唯一状态位置：本文件；状态：ready（仅首阶段；其余阶段按表中依赖放行）。
- 指定分支：`task/T005-d-workbench`。
- 已核对设计 base commit：`9ea33e27bf3d488c355e4706abccaba3c19a5244`。
- 外部操作：默认无；仅本地可逆实现及离线验证。

## 允许修改路径

apps/desktop/renderer/、tests/acceptance/、docs/development/workstreams/d/。不写 main/preload/runtime、公共 testkit、根配置、锁或业务数据库。

## 子任务与顺序

| 阶段 | 初始状态 | 依赖 | 交付 |
|---|---|---|---|
| D0 | ready | 无产品依赖 | S12 页面流程与低保真原型、合成案例、三入口/无宿主/权限不足/取消恢复验收矩阵；先放 docs/development/workstreams/d/ |
| D1 | planned | A1、A2；A3 对应 DesktopApi fake | S12 typed client 和案件列表、证据、步骤、背景、人工核查及明确错误状态界面 |
| D2 | planned | D1、B2、A4 最小 IPC | 最小桌面链路：真实“创建案件→保存→重启回读”，配合最小安装包验证 |
| D3 | planned | D2、B3、C3/C4、A4 | 三入口交互、预算/取消/恢复/导出/投递状态验收场景，逐项替换 fake |
| D4 | planned | A5；真实场景另需当次授权 | 记录可复现用户流程、安装使用说明、证据层级及剩余问题 |

阶段依赖引用对应工作线任务文件；A1/A2/A3 等均指已合并的实际交付，不指仅有任务计划。全线状态 ready 只允许启动首阶段，不能自动放行全部产品实现。

## 实现与验收重点

D0 只依赖基线，不单独搭一套正式产品 workspace 或复制 DesktopApi。需要可交互原型时使用隔离的静态 HTML/CSS 与合成数据，放本线文档目录，明确后续需接真实 API。

D1 UI 只消费 DesktopApi，禁止直接调用 Wazuh、数据库或 Electron 特权；产品页面不展示内部实现细节来代替可用功能。区分 queued/running/uncertain/failed、任务完成/案件解决/投递状态。D2 使用真实存储而非刷新即丢的假数据。D3 检查不可用、空状态、权限失败与竞态，使用共享 fake，不把本线验收夹具写成第二套公共 testkit。D4 是实际交付与验证工作，不是其他成员的强制审批角色。

## 启动、依赖与共享规则

只指定本任务分支名即可按本文件开始；先读 README、贡献流程、开发入口、boundaries、对应 Sxx 设计和权威 contracts.ts/schema.sql。业务 v4.2、内部契约 0.2.0、外部信封 0.1.0。

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
