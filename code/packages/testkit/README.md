# 公共 testkit

归属 A；公开入口 `@campussec/testkit`，只依赖 contracts 和本包纯代码，不加载真实 storage、SQLite、文件系统、网络或 Electron。

提供 FakeClock、FakeIds、ScriptedPort、HTTP/执行/投递脚本化 fake 和合成 ID/范围/上下文。每次外部调用必须显式排入结果；没有脚本时失败，不隐含成功。测试在 tests/。

```typescript
import { createScriptedHttp } from '@campussec/testkit';
import { fail } from '@campussec/contracts';
const { port, script } = createScriptedHttp();
script.push(async () => fail('UPSTREAM_TIMEOUT', '合成响应丢失'));
// 将 port 注入被测模块；fake 不访问真实网络。
```

真实数据库、文件与跨模块预置记录放根 tests/support。本包还没有所有模块所需 fake；DesktopApi 和存储 fake 仍需按对应阶段补齐，不能据现有出口宣布 A3 全部完成。
