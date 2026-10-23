# core 修改归属

- 根 package.json 和公共导出接线由 A 串行维护。当前没有业务实现或可调用导出；不得增加成功占位。
- A：requests、investigations；S07 唯一决定任务终态，协调预算/留存/发布/完成。
- B：alerts、cases、reports；S06 不依赖 S07/S09，S10 不解释取消或决定执行终态。
- C：delivery；S11 自己维护 outbox、回执和投递，禁止重跑调查。
- 各域测试放各自目录的 tests/。跨域使用公开子路径和 contracts 的窄端口；跨所有者事务调用 InTx，回调同步，禁止 await 或直接写他表。
- 新子路径由相应实现者提供真实实现，A 再维护公共导出和装配，不导出私有 Repository。
