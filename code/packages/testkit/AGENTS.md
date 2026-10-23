# 公共 testkit

- A 负责；消费者提出具体场景，由唯一共享任务修改。
- src 只依赖 contracts 和包内纯函数/状态。禁止导入 storage、Electron、文件系统、网络或某个业务模块。
- fake 必须显式排入成功/失败步骤；没有脚本时失败，不提供隐含成功默认值。
- 真实文件、SQLite 和跨模块预置数据放根 tests/support，由集成任务维护。
- tests 验证 fake 的可观察失败与竞态；新增 fake 前检查现有公开入口，避免复制。
