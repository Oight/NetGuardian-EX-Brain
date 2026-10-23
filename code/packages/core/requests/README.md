# S07 · 请求与调度

A 负责，尚未实现。此处承载请求、队列、预算/run fence、取消、超时、uncertain 和恢复；同步预算组件放 budgets，私有仓储不跨域导出。

S07 唯一决定任务终态。外部调用在事务外，intent/observed 分开；uncertain 保留活动槽。跨所有者调用 InTx，不直接写案件/报告/投递表。
