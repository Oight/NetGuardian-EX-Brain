# 设计快照与来源

此处保留 contracts.ts、schema.sql、architecture.json、contract-vectors.json 原文；[provenance.json](provenance.json)登记原 commit、提供者和逐文件 SHA-256。它们不是产品运行时依赖，产品类型唯一从 packages/contracts 导出。

核对设计仓库 `120c81cfd4d8ed720c9cc70178edb9c6fd172a34`：四份附件与初始 c8f152e 完全相同，不改写快照或迁移校验值。新增四线分工见[结构](../docs/development/structure.md)和[任务](../docs/development/tasks/README.md)。

来源仓库：[NetGuardian-EX-Brain](https://github.com/Oight/NetGuardian-EX-Brain)。四线原任务位于该提交 docs/development/tasks/T002—T005；本项目不修改来源，不复制其任务执行成绩。

类型/DDL 变化须明确版本、消费者、兼容影响和迁移，再由所有者协调同步。不能为通过检查改快照哈希；.gitattributes 保留快照与初始迁移的原始字节，防止跨平台换行转换破坏校验。
