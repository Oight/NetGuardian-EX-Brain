# T004 · C 线：Wazuh、TeleAgent、MCP 与结果投递

- 负责工作线：C；具体成员账号不预设，领取者填写执行记录。
- 唯一状态位置：本文件；状态：ready（仅首阶段；其余阶段按表中依赖放行）。
- 指定分支：`task/T004-c-integrations`。
- 已核对设计 base commit：`9ea33e27bf3d488c355e4706abccaba3c19a5244`。
- 外部操作：默认无；仅本地可逆实现及离线验证。

## 允许修改路径

packages/wazuh-adapter/、packages/teleagent-bridge/、packages/mcp-server/、packages/core/delivery/、docs/development/workstreams/c/。仅维护本线包配置，SDK/驱动的根依赖与锁由 A 更新。

## 子任务与顺序

| 阶段 | 初始状态 | 依赖 | 交付 |
|---|---|---|---|
| C0 | ready | 无产品依赖 | M0 离线验证矩阵；Wazuh 查询映射、脱敏合成夹具、接入缺口及工具角色矩阵 |
| C1 | planned | A1、A2、A3 对应 HTTP fake | S04 Wazuh Server/Indexer 适配、分页、能力及受限查询 |
| C2 | planned | C1、A3 | S08 宿主 wire/执行/可信来源/投递原语；S09 独立通道、grant、可信绑定 |
| C3 | planned | C2、A4 对应应用端口 | S09 薄协议入口：委派/取证角色隔离、路由及实际响应发送确认 |
| C4 | planned | C2、B3 结果包端口、A4 发布/outbox 用例 | S11 订阅、outbox、投递 worker、回执和恢复 |
| C5 | planned | A5、D3 及当次真实操作授权 | 按 M0—M4 验证真实接入，缺口保留未通过；不能以离线成功宣布真实闭环 |

阶段依赖引用对应工作线任务文件；A1/A2/A3 等均指已合并的实际交付，不指仅有任务计划。全线状态 ready 只允许启动首阶段，不能自动放行全部产品实现。

## 实现与验收重点

C0 不连接平台：逐项写操作、输入、成功证据、失败判据和所需授权；未入库报告只引用来源登记，不假装已复核。C1 覆盖 401/403、TLS、连续分页、partial、新鲜度和覆盖范围，不扩展冻结上游。

C2 先交付公开窄端口和离线 driver，使 A4 可用 fake 接线；C3 再消费 A4，避免彼此等待整个模块。通道管理独立于网关、不回调工具用例。覆盖来源伪造、grant 过期/撤销、身份/连接世代变化、响应丢失及取消晚到。C4 验证重启、不重复投递、未知回执保留 uncertain；结果投递不重跑调查。

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
