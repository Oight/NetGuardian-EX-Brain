# S06 · 案件与证据

B 线实现；公开入口为 `@campussec/core/cases`：

```ts
const { service, atomic } = createCaseService({ db, events, clock, ids });
```

service 实现 CaseService 全部 7 个方法：案件创建/检索/分页/快照、获准证据读取、人工状态转换、双 revision 移动材料、人工背景版本。没有通用标题编辑接口；“保存案件输入”通过冻结契约中的 putContext/setStatus 等明确操作完成。

atomic 实现 CaseAtomicPort 全部 15 个方法：核权读取/CAS/审计、页采集与不可变证据版本、轮次冻结、只读视图、附案、白名单投影/释放、幂等封存、旧报告保护及留存原语。所有 InTx 均同步；调用方必须将失败 Result 作为当前事务失败返回，不能吞掉错误后提交。

索引身份来自平台/索引/原生文档 ID；资源身份来自平台/资源类别/设备/稳定行键与扫描身份。内容哈希不充当事件身份；同源变化或 expired 正文形成新版本。同页响应变化返回 CONFLICT，重复页返回该页精确 refs，覆盖只在连续无缺口的页完成后升级。

0001 冻结 DDL 不变。追加 0002 新增 S06 所有的 case_run_manifests 与 case_query_page_refs，分别解决封存事实持久化（B0/G01）和同页引用重放。manifest 保存事实、定位和哈希，不保存额外投影正文副本。物理迁移由 B 维护，检查器显式登记 S06 所有权；不改写冻结 architecture.json。

案件快照最多返回 50 条材料、100 条背景和最近 100 个查询覆盖；材料用 nextEvidenceCursor 续读，历史轮次用 inspectRunInTx 读取。证据 ID 本身不产生读取权。背景作者只取 Actor，默认 UI 提交 unverified，核实/否定保留版本并推进相交案件 revision。

S06 不构造或回调 S07 预算、S09 MCP、宿主或报告服务，不决定任务终态。capture 前的事件预算预占、清理后的工具回复缓存过期均由 S07 在同一 WriteTx 协调。S03 尚不直接暴露清理原语，避免绕过该原子边界。

真实 SQLite 场景位于 tests/cases.test.ts；跨 S07/S06 回滚与生产装配在根 tests/acceptance。Node/Electron/Windows 的新代码验收需由外部环境运行，不用 Bun 结果替代。
