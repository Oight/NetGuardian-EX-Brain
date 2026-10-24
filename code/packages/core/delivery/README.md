# S11 · 结果订阅与投递

index.ts 实现订阅、不可变 ResultPackage 的 outbox、固定 deliveryKey、单 worker、发送前权限复核、可见回执、丢失响应后的核实与恢复。仅核实 absent 后可退避重试；unknown 停止自动发送并保留本地取回，重试不调用执行器。任务完成、结果和 outbox 由同一 WriteTx 提交，失败全回滚。

生产组合测试见产品 tests/acceptance/delivery-lifecycle.test.ts。真实宿主原会话投递尚无验收。冻结接口没有 blocked 投递的显式恢复命令，当前保留结果取回路径，不冒充已具备 UI 手动重投能力。
