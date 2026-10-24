# 产品协作入口

遵守[根协作约定](../CONTRIBUTING.md)、[工程规则](../design_document/docs/development/engineering-rules.md)、[当前任务](docs/development/tasks/README.md)与[目录归属](docs/development/structure.md)。产品命令统一见[运行说明](docs/development/commands.md)。

模块测试跟随模块；纯 fake 来自 `@campussec/testkit`，真实临时库夹具在 `tests/support`。公共导出与类型、schema、消费者、锁及检查同步更新。不得通过更新原 provenance 或重写旧迁移消除失败。
