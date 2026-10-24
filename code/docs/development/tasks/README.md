# 任务入口

当前执行任务为 [T008 全项目严格核验与补全](T008-project-completion.md)，分支 `task/project-completion-audit`。用户已取消旧分工限制，本轮串行跨模块推进；旧表保留历史导航，不能据其推定项目已经全部完成。

本实现目录的实时状态只在具体任务文件维护，本页只导航。分工源为设计仓库 `120c81c` 的四线任务，不复制来源执行成绩、不推定成员身份。

| 工作线 | 分支入口约定             | 唯一任务文件                   | 子系统                |
| ------ | ------------------------ | ------------------------------ | --------------------- |
| A      | task/T002-a-foundation   | [T002](T002-a-foundation.md)   | S01/S03/S07、共享工程 |
| B      | task/T003-b-local-domain | [T003](T003-b-local-domain.md) | S02/S05/S06/S10、迁移 |
| C      | task/T004-c-integrations | [T004](T004-c-integrations.md) | S04/S08/S09/S11       |
| D      | task/T005-d-workbench    | [T005](T005-d-workbench.md)    | S12、用户验收         |

已入库的结构整理记录：[T007](T007-project-structure.md)。旧 S01/S02/S03“T002”存入[历史记录](../../history/foundation-initial-task.md)，不再与新版 A 线共用身份。

既有产品成果已随 64443ed 进入仓库 main；全仓唯一产品任务状态在本目录，design_document 的四线文件只转发。开始前填写执行者、实际 HEAD、依赖合并 commit、路径与检查；代码入库不等于全部阶段验收通过。指定上表分支名即可读取相应任务并创建独立本地分支；实体分支是否存在由执行者先核对。
