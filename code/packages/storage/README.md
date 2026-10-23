# S02 · 存储与事件

归属 B；公开入口 `@campussec/storage`，测试在 tests/；migrations 由 B 独占维护。src 按数据库、迁移、空间、事件拆分。

本机使用 Bun 对标准 node:sqlite 接口的兼容实现；目标 Electron 支持、Windows 和打包仍未验收。同步事务、整体回滚、单写入者、主体/空间/代次核权保持不变。物理迁移不授予其他业务表写所有权。

测试可导入根 tests/support 的真实临时库夹具；公共 testkit 不依赖本包。原 0001 校验值不变，后续差异使用明确新迁移。
