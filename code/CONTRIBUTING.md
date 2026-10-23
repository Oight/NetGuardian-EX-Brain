# 参与开发

先读 [AGENTS](AGENTS.md)、[目录归属](docs/development/structure.md)、[自己的任务](docs/development/tasks/README.md)和[协作流程](docs/development/workflow.md)。

只修改任务允许路径。公共契约、根配置、两份锁、公共 testkit、装配和 CI 由 A 的一个任务串行维护；迁移交 B。跨线请求写明调用场景、差异、消费者、检查和依赖提交。

模块测试跟随模块；纯 fake 从 @campussec/testkit 导入；真实临时库和文件夹具在 tests/support。不要提交数据库、凭据、日志或生成物，不把 fake 成功当作真实接入验收。

按[命令说明](docs/development/commands.md)自检，分别记录通过、失败和未执行。done 要求真实实现提交已合并产品 main；既有产品基准为 64443ed；记录实际启动 HEAD 和依赖 commit，不能用源设计 commit 替代。
