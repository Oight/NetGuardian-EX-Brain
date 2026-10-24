# 公共 testkit

A 维护；只从 `@campussec/testkit` 公开入口消费。src 只依赖 contracts 与包内纯代码，不访问 storage、SQLite、网络、文件或 Electron。所有 fake 都必须显式排脚本，没有隐含成功结果。

| 消费线 | 出口                                                                                                               | 用途                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| B1/B2  | FakeClock、FakeIds、SqlScript、createScriptedDatabase                                                              | 同步事务/精确 SQL 交互；真实 SQL 语义与回滚用 tests/support/storage |
| B3     | createScriptedPlatformQuery、createScriptedConnectionRead、createScriptedNotification、createScriptedRequestAtomic | G03 查询/连接/通知与同步 InTx 窄端口                                |
| C1     | createScriptedHttp、createScriptedSecrets                                                                          | HTTP 与秘密引用；只使用合成字节，用后清零借用副本                   |
| C2/C4  | createScriptedExecution、createScriptedDelivery、deferred                                                          | uncertain、回执丢失、取消晚到、核实与过期绑定                       |
| D1     | createScriptedDesktop、foundationSamples                                                                           | 显式的 47 个 DesktopApi 方法样例与严格输入/输出/响应关联校验        |

`foundationSamples()` 是合成 schema 示例，不是业务成功实现；必须显式选择样例排入 fake。示例中 partial、denied、未知覆盖和 needs_review 保持区别，不能将其排进 fake 后声称真实调查已通过。

```typescript
import {
  createScriptedPlatformQuery,
  foundationSamples,
} from "@campussec/testkit";
import { fail, ok } from "@campussec/contracts";
const fake = createScriptedPlatformQuery();
fake.query.push(async () => ok(foundationSamples().page)); // 明确的合成 partial
fake.query.push(async () => fail("UPSTREAM_DENIED", "合成 403"));
// 将 fake.port 注入模块；实际调用 ctx/input/call 可从 fake.query.calls 核对。
```

同步调用使用 `SyncScriptedPort`，拒绝 async 或含 Promise 的结果；保留 tx/ctx 供调用检查。SQL fake 只验证调用顺序、语句/参数、同步边界与事务句柄失效，记录 committed/rolled_back，不解析 SQL、不存储业务数据。不能据该记录证明真实数据库回滚；实际回滚另有真实 SQLite 测试。

```typescript
import { createScriptedDatabase, SqlScript, context } from "@campussec/testkit";
const fake = createScriptedDatabase();
fake.read(new SqlScript().expectGet("SELECT 1 AS n", [], { n: 1 }));
const value = await fake.port.read(context(), (tx) =>
  tx.get<{ n: number }>("SELECT 1 AS n"),
);
```

`deferred<T>()` 显式控制迟到响应。fake 不替被测模块做自动取消/重试/去重或额度判定；这些业务必须由真实实现验证。真实文件和跨模块夹具保留在 tests/support。新增端口需求交 A 单任务维护，不复制公共 fake。
