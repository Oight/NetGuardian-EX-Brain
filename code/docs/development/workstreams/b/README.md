# B0 基线场景材料

本目录的 b0-mapping.json、b0-fixtures.json、b0-scenarios.json 和 verify_b0.py 保留工程 0.2.0 初始端口/表的合成场景定义。场景中的 planned_product_acceptance 和 requiresDecision 描述当时计划，不是当前产品结果；G01—G05 的当前处理只见[T003](../../tasks/T003-b-local-domain.md)。

完整入口检查原冻结哈希、29 张表映射、44 个方法、36 个计划场景及 10 个原生 SQLite DDL 探针；不等同于产品服务验收。增量端口、0002/0003 和当前产品行为由产品检查及[维护补充](../../../../../design_document/docs/implementation/maintenance-2026-10-24.md)覆盖。

在仓库根目录运行 `python -B code/docs/development/workstreams/b/verify_b0.py`，本机经 uv 使用可用解释器并将 TMPDIR 指向忽略的 code/.local；结果见[统一验证](../../../verification/maintenance-2026-10-24.md)。
