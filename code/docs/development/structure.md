# 结构、公开入口与写入归属

产品在 code/；设计在相邻 design_document/。冻结[architecture](../../spec/architecture.json)描述工程 0.2.0 原始组件和表所有者，[维护补充](../../../design_document/docs/implementation/maintenance-2026-10-24.md)单列新增端口与表。实际状态见[四线任务](tasks/README.md)。

| 工作线 | 路径 | 公开入口 / 工厂 |
|---|---|---|
| A / S01 | packages/contracts | @campussec/contracts：类型、schema、错误、规范化 |
| A / 共享 | packages/testkit | @campussec/testkit：纯脚本 fake、Clock/Id |
| A / S03 | apps/desktop/main、preload、runtime | composeRuntime / 严格 Facade；renderer 仅 DesktopApi |
| A / S07 | core/requests | core/requests/budgets → createRunBudget；core/requests/read-model → createInvestigationHistory、createReportAnchors |
| A / S07 | core/investigations/tool-runner | core/investigations/tools → createInvestigationTools |
| B / S02 | packages/storage | @campussec/storage → createStorage |
| B / S05 | core/alerts | core/alerts/policy-reader → createPolicyReader |
| B / S06 | core/cases | core/cases → createCaseService |
| B / S10 | core/reports、investigation-profile | core/reports → createReportService、createResultPackageReader；@campussec/investigation-profile → createInvestigationProfile |
| C / S04 | packages/wazuh-adapter | @campussec/wazuh-adapter → createWazuhAdapter |
| C / S08 | teleagent-bridge | 尚无真实宿主/执行实现 |
| C / S09 | mcp-server/channels | @campussec/mcp-server/channels → createEvidenceChannels、createChannelAuthenticator |
| C / S11 | core/delivery | core/delivery/recovery → createDeliveryRecovery；worker 等待实现 |
| D / S12 | apps/desktop/renderer | mountWorkbench；本地 ES modules / DOM |

表内 core/ 子路径均以 @campussec/ 为包前缀。跨模块通过公开出口，不导入私有 Repository；S10 使用 contracts 中的 ReportAnchorReadPort，由装配注入 S07 实现，不能直接查询 S07 表。

模块测试跟随模块；真实临时库/文件夹具在 tests/support；跨域验收在 tests/acceptance；纯 fake 不依赖 storage。scripts/product 是标准环境通用脚本，scripts/local 是 Bun 本机工具。

根配置、锁、contracts/testkit、公共导出、装配和 CI 由 A 单任务串行修改；物理迁移交 B，业务表仍由各所有者修改。0001 为冻结 DDL，0002 为 S06 封存/页引用，0003 为 S11 delivery_recoveries。迁移与 spec 保留原字节。

node_modules、dist、dist-test、.local、.cache、数据库和日志是生成物，不进入文档清单或交接输入。
