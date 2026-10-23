# 任务入口

本实现目录的实时状态只在具体任务文件维护，本页只导航。分工源为设计仓库 `120c81c` 的四线任务，不复制来源执行成绩、不推定成员身份。

| 工作线 | 分支入口约定 | 唯一任务文件 | 子系统 |
|---|---|---|---|
| A | task/T002-a-foundation | [T002](T002-a-foundation.md) | S01/S03/S07、共享工程 |
| B | task/T003-b-local-domain | [T003](T003-b-local-domain.md) | S02/S05/S06/S10、迁移 |
| C | task/T004-c-integrations | [T004](T004-c-integrations.md) | S04/S08/S09/S11 |
| D | task/T005-d-workbench | [T005](T005-d-workbench.md) | S12、用户验收 |

当前整理任务：[T007](T007-project-structure.md)。旧 S01/S02/S03“T002”存入[历史记录](../../history/foundation-initial-task.md)，不再与新版 A 线共用身份。

开始前填写执行者、真实产品 base、依赖合并 commit、路径与检查。尚无产品 Git main，不用设计 commit 代替实现提交；现有代码可复用不等于阶段已放行。
