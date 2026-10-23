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

真实数据库、文件与跨模块预置记录放根 tests/support。本包还没有所有模块所需 fake；DesktopApi 已提供 createScriptedDesktop，按方法显式排队并校验输入/输出；存储 fake 仍需按实际消费者需求补齐，不能据现有出口宣布 A3 全部完成。


界面开发可注入 `createScriptedDesktop().port`；使用 `push(method, reply)` 排入合成响应，方法乱序或无脚本时抛错，非法输入不消耗脚本。它不证明真实 IPC/业务已接通。合成错误与响应丢失须由调用者显式脚本化。
