# T002 · A 线：工程基座、桌面装配与任务核心

- 负责工作线：A；具体成员账号不预设，领取者填写执行记录。
- 唯一状态位置：本文件；状态：ready（仅首阶段；其余阶段按表中依赖放行）。
- 指定分支：`task/T002-a-foundation`。
- 已核对设计 base commit：`9ea33e27bf3d488c355e4706abccaba3c19a5244`。
- 外部操作：默认无；仅本地可逆实现及离线验证。

## 允许修改路径

根 package.json、packages/core/package.json、package-lock.json、tsconfig*.json、npm 配置、.gitignore（仅产品生成物规则）、packages/contracts/、packages/testkit/、apps/desktop/main/、apps/desktop/preload/、apps/desktop/runtime/、桌面根构建/打包配置、packages/core/requests/、packages/core/investigations/、scripts/product/、.github/workflows/ 产品检查文件。根 README 和开发文档仅在单独串行交接窗口更新。不得写 renderer、其他业务模块或物理 SQL。

## 子任务与顺序

| 阶段 | 初始状态 | 依赖 | 交付 |
|---|---|---|---|
| A1 | ready | 无产品依赖 | T002 工程骨架：npm workspace、锁定工具链、ESM/strict、最小 Electron 启动与构建；为 B/C/D 建立统一包接入方式 |
| A2 | planned | A1 | S01 runtime schema：公开包入口、严格外部信封解析、错误和默认限制；拒绝未知键/枚举，秘密仅 SecretRef |
| A3 | planned | A2 | 共享 testkit：FakeClock/Id、HTTP/执行/投递脚本化 fake、失败与竞态向量；真实检查脚本与产品 CI |
| A4 | planned | A3、B1/B2、C2 窄端口；C3/D2 不作为 A4 前置 | S07 请求/预算/run fence/工具用例/终态/恢复；S03 接线、秘密引用、有限 IPC、安装包 |
| A5 | planned | B3、C4、D3 | 三入口装配、组合检查和故障恢复；登记 M0—M4 证据，真实能力缺失时不宣告 P0 完成 |

阶段依赖引用对应工作线任务文件；A1/A2/A3 等均指已合并的实际交付，不指仅有任务计划。全线状态 ready 只允许启动首阶段，不能自动放行全部产品实现。

## 实现与验收重点

A1—A3 先作为其他线的放行点，不能等 S07 全部完成才交付。A1 固定实际 Node/npm/Electron/SQLite 接入约束，锁定版本依据来自小验证，不预填兼容版本。A2 按 contracts.ts 实现，不擅自缩窄整个业务契约以通过检查。A3 至少提供 B/C/D 首阶段所需窄端口，并记录尚未覆盖的端口。

A4 覆盖任务接收、预算预占、取消晚到、超时、uncertain、重启和幂等；S07 唯一决定终态。跨所有者事务调用 InTx、事务内禁止 await。A5 验证调用链，不接管 B/C/D 的业务实现。A 只是本轮共享配置唯一写者，不是长期固定集成负责人。

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
