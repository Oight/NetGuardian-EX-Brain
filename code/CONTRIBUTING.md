# 参与开发

先读[目录归属](docs/development/structure.md)、[自己的任务](docs/development/tasks/README.md)和[协作流程](docs/development/workflow.md)。设备环境与本机 Agent 角色写入 Git 忽略的仓库根 AGENTS.md，不作为共享开发规范。

只修改当次任务声明的路径；A/B/C/D 为分工参考，可串行跨目录实现。公共契约、根配置、锁、testkit、装配、CI 和迁移列为附带文件并保持单任务写入；跨模块差异写明调用场景、消费者、检查和依赖提交。

模块测试跟随模块；纯 fake 从 @campussec/testkit 导入；真实临时库和文件夹具在 tests/support。不要提交数据库、凭据、日志或生成物，不把 fake 成功当作真实接入验收。

按[命令说明](docs/development/commands.md)自检，分别记录通过、失败和未执行。done 要求真实实现提交已合并产品 main；既有产品基准为 64443ed；记录实际启动 HEAD 和依赖 commit，不能用源设计 commit 替代。
