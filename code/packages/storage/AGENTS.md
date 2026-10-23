# 存储归属

- B / S02 维护 src、migrations 与本模块 tests；其他模块通过 DatabasePort/EventPort 和公开工厂使用。
- 物理 DDL/迁移只有 B 写；业务表状态仍属于对应业务模块，存储层不决定调查终态。
- 同步事务、错误整体回滚、禁止 await；一个核心写入者，检查空间/主体/身份代次。
- 原始 0001 校验值保持不变；新增结构差异追加迁移并协调 spec，不覆盖历史迁移。
- tests 可使用根 tests/support 的真实临时 SQLite 夹具；不得把它移入公共 testkit。
