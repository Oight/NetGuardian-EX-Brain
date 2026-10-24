# B0：本地业务实现拆解与交接

日期：2026-10-23；执行：Codex，用户指定 B 线。产品 base 为 `1d379e11916fe03cc03e5355fc6c1ee108633b6c`，在独立 worktree 的 `task/T003-b-local-domain-b0` 开展。阶段状态与实际提交只在[T003](../../tasks/T003-b-local-domain.md)维护。

业务 v4.2、工程 0.2.0、外部信封 0.1.0。依据为[固定契约](../../../../spec/contracts.ts)、[表所有权](../../../../spec/architecture.json)、[DDL](../../../../spec/schema.sql)，以及设计目录中的[S02](../../../../../design_document/docs/implementation/02-storage.md)、[S05](../../../../../design_document/docs/implementation/05-alerts.md)、[S06](../../../../../design_document/docs/implementation/06-cases-evidence.md)、[S10](../../../../../design_document/docs/implementation/10-investigation-reports.md)和[组件边界](../../../../../design_document/docs/implementation/boundaries.md)。候选调查档案图、自动差异解释和局部重查不进入本轮。

## 1. 现有成果与证据限度

| 模块 | 当前源码                                                                  | 后续可复用内容                                                                | 仍需取得的证据                                                                                                           |
| ---- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| S02  | storage/src/{index,database,migrations,events,space,types}.ts 与 0001.sql | 工厂、单写队列、同步回调、元数据/迁移校验、事件分页；已有 7 个存储测试定义    | 本机产品测试、标准 Node 构建、Electron/Windows 打包及秘密保护兼容；现有实现只支持 migration v1，不能直接宣称有通用升级器 |
| S05  | core/alerts 仅 README                                                     | 已冻结 AlertService 与外部端口；尚无产品实现                                  | 分页接收、通知、策略代次、候选与原子受理                                                                                 |
| S06  | core/cases 仅 README                                                      | 已冻结 CaseService/CaseAtomicPort；tests/support 的 seedCase 仅是测试预置数据 | 真实服务创建/保存/重启回读、不可变证据、投影、封存和清理                                                                 |
| S10  | core/reports、investigation-profile 仅 README                             | 已冻结 ReportService 及窄视图，未接执行驱动                                   | 配置模板、引用校验、人工操作、结果包与同快照导出                                                                         |

B0 不安装产品依赖，不运行或改写上述产品实现；不将原生 DDL 探针当成 createStorage/CaseService/ReportService 已通过。

## 2. 后续工作单元与放行条件

| 单元   | 阶段 / 路径（相对 code）                                          | 行为与交付                                                                                            | 依赖 / 关键验收                                                                                     |
| ------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| B1-S02 | B1 / packages/storage                                             | 接收既有工厂；复核只读快照、关闭等待、同步拒绝/回滚、身份隔离、迁移校验；有实际需求时另做追加迁移方案 | A1/A2/A3 对应交付；现有 storage 测试在本机与目标环境实际运行，不能仅沿用旧报告                      |
| B2-C   | B2 / core/cases/{cases,repositories}                              | list/create/snapshot/evidence、案件状态图、CAS、双案迁移、审计事件；Repository 私有                   | B1/A3；无种子创建、参数化检索、双 revision 全成或全败、跨主体/连接拒绝                              |
| B2-E   | B2 / core/cases/{evidence,queries,context}                        | 稳定来源键、版本/retrieval、页幂等/覆盖累计、run 关联、背景版本与作者                                 | B1/A3；同源变化/过期再取建新版，同文异源不合并，缺时间保留 unknown，失败页不冒充完整                |
| B2-P   | B2 / core/cases/{projections,manifest,retention}                  | 白名单投影 prepared/released/uncertain、冻结输入/只读视图、封存、按 baseRevision 附案、清理计划       | B2-C/E，G01 决定后做封存持久化；S07 传入可信 metadata/protectedRunIds，不读任务私表                 |
| B3-A   | B3 / core/alerts/{watch,inbox,notifications,triggers,groups}      | 固定上界轮询、源去重、模板通知、策略 CAS/epoch、候选窗口与 flush                                      | B2、A4/C2 对应端口，G03/G04；无模型提醒，history/recovery 不自动调查，预算拒绝仍保留提醒            |
| B3-P   | B3 / investigation-profile/{profile,skill,prompt,manifest}        | prepare 使用冻结输入及 prepared 种子，生成最小 system/user 文本、工具白名单和 contextRefs             | B2 投影、A3；无种子不编造材料；准备配置不冒充宿主实际加载/释放；hash/Skill 加载实测交 C/A           |
| B3-R   | B3 / core/reports/{propose,validate,assess,finalize,repositories} | 可信引用校验、无效候选留存、assessment、显式 CompletionDecision、不可变结果包/reader                  | A4 的可信参数、B2 原子视图；G02/G05；不读 jobs/request_events、不能把无效草案自行降级成别的任务终态 |
| B3-H   | B3 / core/reports/{review,followups,export}                       | 审核/修订保留历史、案件审计、待办 CAS、同 ReadTx 的 Markdown/JSON 导出                                | B3-R、B2；G02；普通 review 不投递，文件名非路径，作者来自 Actor，不自动关案                         |
| B4-X   | B4 / 各模块自己的测试                                             | 三入口、政策撤销、预算/capture、清理/缓存、终态/结果包/outbox、人工发布的组合原子性                   | A4/C4/D3 实际提交；由 S07 协调，失败不能直写他表补偿                                                |

源码包首次新增公开子路径和依赖时交 A 维护 core/package.json、公共导出和装配。B 的测试跟随模块；真实 SQLite 夹具消费 tests/support，公共 fake 请求交 A，不复制邻模块服务。

## 3. 跨线请求与兼容影响

以下均是基于当前规范的静态缺口，不修改契约/DDL，也不影响 B0 材料交付。A 统一协调公共契约，B 仅在决定明确后追加物理迁移。

| 编号 / 接收线    | 具体场景与当前依据                                                                                                                                                                   | 建议决定及影响                                                                                                                                                                  | 需在何时明确                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| G01 / A+B        | sealInTx 要求同 metadata 幂等、不同 metadata CONFLICT，但 S06 拥有的表没有 run 级 manifest/metadata 存档；analysis_runs.manifest_hash 属 S07，S06 禁止读写它                         | A 明确核对旧封存内容的端口/归属。候选为 S06 追加 run_manifest 存档，或改成由 S07 明确传入并核对旧封存事实；需同步契约/所有权/DDL/测试，不用 query_runs.coverage_json 塞影子状态 | B2-P 的封存实现前；不阻塞基本案件/证据              |
| G02 / A+B+D      | S10 拥有 response_notes(source=human_statement/observed)，但 ReportService/DesktopApi 没有独立处理备注入口，FollowupRecord 也没有 source；不能从附带证据自动推断人工陈述已被观测证实 | 确定 putFollowup 是否同时写 human_statement 审计备注，以及 observed 的受信任写入/读取入口；或明确该表首版保留不写。A/D 决定可见行为，B 实现对应事务；当前不私造 DTO 字段        | B3-H 的备注实现前；reader/普通待办可先做            |
| G03 / A          | 现有 testkit 只有 HTTP、Execution、Delivery scripted fake；B3 需 PlatformQueryPort/ConnectionReadPort/RequestAtomicPort/NotificationPort，且 InTx 必须同步                           | 在公共 testkit 交付可记录调用、显式脚本成功/失败/响应丢失的窄 fake；B0 JSON 可作输入，不能把默认成功写进 fake。B1/B2 优先消费真实临时库及 Clock/Id                              | B1/B2/B3 各自消费前；不要求整组 fake 一次到齐       |
| G04 / A（S07）+B | flushCandidates 若 createAutoInTx 返回 QUEUE_FULL/BUDGET_EXHAUSTED 等，S05 要保留未调查原因；吞掉错误后提交可能连带提交 S07 部分写入                                                 | 约定拒绝型 InTx 在返回失败前无可提交副作用；否则外层整笔回滚，另开事务记录拒绝原因。禁止 S05 修写 S07 表。成功受理与 dispatched 必须同事务                                      | B3-A，配合 A4；新 fake 要覆盖失败发生在写入后的回滚 |
| G05 / A+B+D      | ReportStatement 只有自然语言 text 和 refs，无结构化字段级声明；“未交付字段/partial 却完整排除都拒绝”无法只凭 DTO/引用存在性证明                                                      | 区分可确定拒绝的跨轮/未释放/失效引用，与需人工核查的语义越界。约定 validationIssues/needs_review 的具体规则，不能宣称引用有效即语义正确，也不默默新增 field claim 接口          | B3-R 的验收口径前；B0 同时保留两类反例              |

## 4. 交接给 A/C/D 的最小信息

- A：需要 CaseAtomicPort 的 get/snapshot/inspect/create/capture/project/release/seal/apply/cleanup 与 ReportProposal/Completion 窄端口；应保存实际 FrozenRunInput、PreparedProfile、contextRefs 和 CompletionDecision，协调清理缓存及 outbox。G01—G05 见上表。
- C：PlatformPage 必须保留真实 queryId/pageId/pageOrdinal、来源定位、coverage、partial/denied/unavailable/failed 和平台尝试次数；不把 403 当零匹配。S08/S09 的交付核实结果交 S07，再由 S07 release；不直接调用 B 的私有 Repository。
- D：CaseService、AlertService、ReportService 经 DesktopApi 使用；冲突时刷新版本、展示未审核与未知覆盖。普通审核和显式发布分开，导出内容交 S03 保存，不让 renderer 选择本地路径或直接查库。

后续依赖以消费者任务中的实际合并提交为准。当前基座提交存在，不等于 A1—A4、B1 或真实接入已验收；本轮止于 B0。
