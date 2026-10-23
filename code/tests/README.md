# 测试分布

模块测试跟随模块：packages/contracts/tests、packages/storage/tests、packages/testkit/tests、apps/desktop/tests；各未来业务域也使用自有 tests/。

本目录只放跨模块公共 support、工具链失败检查 tooling 和用户流程 acceptance。support 是 A 维护的集成夹具，需要真实 SQLite/文件；不能被产品或纯 testkit 导入。

统一从 code/ 执行 `npm test`，或在可选 Bun 环境运行 `bun scripts/product/test.ts`；运行器只发现源码测试，忽略 dist/dist-test/node_modules。Electron 实机验收单独记录。
