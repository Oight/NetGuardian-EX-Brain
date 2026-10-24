# 冻结基线与维护附件

contracts.ts、schema.sql、architecture.json、contract-vectors.json 保持工程 0.2.0 原始字节；[provenance.json](provenance.json)的原哈希不改写。产品类型统一从 packages/contracts 导出，这里不是运行时来源。

本次从可信设计附件恢复了三份漂移快照，并将新增接口单列为 maintenance-contracts.ts；0003 审计 DDL 为 maintenance-schema.sql，增量所有权为 maintenance-architecture.json。[maintenance-provenance.json](maintenance-provenance.json)单独记录这些附件的哈希，原基线校验继续执行。

产品扩展声明只增补 DesktopMethodMap，原 domains 声明与基线 AST 严格一致。verify-foundation 同时验证新附件、产品增量声明、47 个 Desktop 方法的 schema 与迁移。规范说明见[维护补充](../../design_document/docs/implementation/maintenance-2026-10-24.md)。
