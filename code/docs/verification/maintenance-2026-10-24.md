# 2026-10-24 文档整理与修复验证

整理阶段首先在 GPT/netguardian 独立副本进行，基准为 28c5185f3e197381c0bc2bfadf89ec11781e31a1；该阶段未修改来源，已有其他项目未覆盖。随后用户授权将修订合入原仓库，合入阶段结果另列。业务 v4.2 / 工程 0.2.0 / 外部信封 0.1.0，增量接口见[维护补充](../../../design_document/docs/implementation/maintenance-2026-10-24.md)。

清理 28 份被替代的历史执行、重复交接与转发任务文档，历史 Wazuh 观察移至 research；[删除与迁移清单](document-cleanup.json)保留原路径与哈希。当前任务统一在[四线入口](../development/tasks/README.md)。基线、实验计划、待评审提案和有用研究材料保留；source-imports.json 明确仅记录初始导入，不冒充当前清单。

## 修复范围

| 审阅项 | 处理 |
|---|---|
| R1 | 恢复冻结附件原字节，不更新原 provenance；新增维护附件单独校验 |
| R2 | 增加持久策略读取及 Desktop/UI 回读，未配置与非法持久数据明确区分 |
| R3 | 增加显式投递核实恢复、原绑定/订阅复核、CAS、安全重试保证及同步审计；默认真实宿主未装配 |
| R4 | 增加案件全历史分页及冻结输入/投影/查询浏览，含无报告失败/取消请求 |
| R5 | G05 区分入口拒绝、结构 invalid、保守 needs_review 与人工语义核查 |
| R6 | S10 改用 S07 ReportAnchorReadPort，保留核权/冻结问题检查，并加 SQL 读取边界检查 |
| R7 | 重写模块与当前任务，区分源码、公开出口、生产装配和目标验收 |

同时修复缺少的包公开导出、TypeScript 路径、workspace 锁图和本机检查顺序；默认 runtime 增加 S10/策略与历史读取。0003 仅追加 S11 恢复审计，0001/0002 保持原字节。

## 本次执行

环境：Bun 1.4.4；uv 调用已有 Python 3.14.8 / SQLite 3.54.0。Python 3.12 不可用，未下载或更改系统解释器。15 份缓存依赖生命周期脚本已检查；安装全部使用 --ignore-scripts，未执行 Node.js 或 Electron。npm v3 锁仅从 Bun 完整性数据导出。

| 检查 | 状态与范围 |
|---|---|
| 原快照/初始基准 | 初始冻结安装、类型/构建及原哈希失败已定位；锁/导出/原字节修复后复测 |
| Bun 统一检查 | 通过：212 项测试、严格类型、标准测试编译、构建、边界、47 方法 schema、锁图与 renderer 静态检查 |
| 干净副本冻结离线安装及同组检查 | 通过：无既有 dist/node_modules 的新副本，禁用钩子冻结离线安装，212 项测试与同组检查通过 |
| 设计两项检查、B0、全项目文档链接与增量附件 | 通过：18 份工程文档/137 原声明/49 基线表，19 组件 DAG；B0 29 表/44 方法/36 计划场景与 10 项原生 DDL 探针；77 份项目 Markdown 的本地文件链接及原/新增快照一致 |
| 浏览器合成交互 | 通过 22/22，含新策略读取、历史分页/冻结背景/过期投影和投递恢复；真实 DOM/CSS + 合成 DesktopApi，不计 Electron 通过 |
| 整理阶段来源逐文件/HEAD 复核 | 通过：283 个入库文件、572 份原审阅 Markdown 哈希未变；HEAD 未变，Git 工作树干净 |
| Node.js/npm、Electron、Windows、安装包、线上 CI | 未执行 |
| 真实模型、TeleAgent、Wazuh、投递或凭据访问 | 未执行 |

原基准的冻结锁、包导出/类型与附件哈希检查曾失败；修复过程中还发现固定方法数、严格身份投影、SQLite 返回对象原型/表数量及测试泛型断言需同步，均在最终检查前修正，未放宽生产 schema 或取消断言。首次本地浏览器服务因沙箱拒绝监听而失败，经批准后仅绑定 127.0.0.1 运行。历史成绩不继承为本次验收。完整 S05/S07/S08/S09 网关/S11 worker、G02 observed 入口、G04 自动受理组合和真实宿主 M0 仍见任务单；本次未宣告完整 P0 通过。

机器结果见[maintenance-checks.json](maintenance-checks.json)。原始本机日志在忽略的 code/.local/maintenance-check.log 与 maintenance-clean-check.log；合成浏览器结果在 code/.local/frontend-integration/browser-result.json。文档检查只验证本地文件目标，未逐个验证标题片段或外链可用性。
