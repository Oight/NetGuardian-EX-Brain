# 手动同步与冲突处理

产品与设计共用根仓库，采用 main 与短任务分支。以下远端同步流程按当次授权执行，本次仅本地合入，不推送；不把历史同步快照当作当前分支关系。

1. 在真实仓库先运行 `git status --short --branch`、`git branch --show-current`、`git remote -v`，核对目录、分支与远端。先保护未提交工作和需要保留的忽略文件。
2. 获授权后 `git fetch --prune origin`，用 `git rev-list --left-right --count HEAD...origin/main` 与 `git log --graph --oneline --all -20` 判断差异。仅落后时可快进；分叉时先建备份分支并审阅双方改动，不强制覆盖。
3. 在独立任务分支合并，逐文件处理冲突；共享契约、锁、迁移与任务状态协调消费者，不整批选择 ours/theirs。未提交的合并需要撤回时，先保护新文件再使用 `git merge --abort`。
4. 冲突消失后检查实际变更、运行[对应验证](commands.md)，记录实现与依赖提交。PR 按需，推送与发布按当次授权执行。

stash 不包含忽略文件，不替代备份；不要为同步删除个人配置、重写旧迁移或修改原 provenance。当前实现状态见[任务](tasks/README.md)，本次结果见[验证记录](../verification/maintenance-2026-10-24.md)。
