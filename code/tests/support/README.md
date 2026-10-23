# 集成夹具

A 串行维护。storage.ts 创建真实临时 SQLite 与文件，预置合成连接/案件；不是 S04/S06 业务实现，不访问真实上游。

只供模块或集成测试导入；生产源码与 packages/testkit 禁止依赖此处。临时文件留在忽略的 .local/tests，每个夹具结束清理。
