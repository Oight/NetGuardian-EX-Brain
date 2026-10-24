# 手动同步远端与处理合并冲突

本说明适用于当前仓库的一条 main、短任务分支流程。产品和设计目录共用仓库根 Git；在仓库根执行以下 Git 命令。当前设备为 PowerShell，可用 npm.cmd 调用 npm。

## 1. 先保护未保存工作

```powershell
git status --short --branch
git branch --show-current
git remote -v
```

确认当前分支和远端正确。工作区有修改时，先在自己的任务分支形成有意义的提交；暂时不能提交的修改可保存到 stash：

```powershell
git stash push -u -m "before-sync"
```

`-u` 包含未跟踪文件，不包含被忽略的文件。AGENTS.md 等本机文件若可能被远端新加入的同名文件覆盖，应先另存副本。stash 不替代个人配置备份，不要为了同步强制删除本地修改。

有其他 worktree 时用 `git worktree list` 查看，避免在共享目录替另一任务切分支。

## 2. 下载变化，再判断双方关系

```powershell
git fetch --prune origin
git rev-list --left-right --count HEAD...origin/main
git log --graph --oneline --decorate --all -20
git log --oneline HEAD..origin/main
git diff --stat HEAD...origin/main
```

fetch 更新 origin/main 等远端跟踪引用，不改当前工作文件。`HEAD...origin/main` 的计数左边是本地独有提交数，右边是远端独有提交数；diff 的三点形式查看远端自共同祖先以来的改动。

| 计数  | 状态                   | 处理                                  |
| ----- | ---------------------- | ------------------------------------- |
| 0 / 0 | 已同步                 | 无需合并                              |
| 0 / N | 本地仅落后             | `git merge --ff-only origin/main`     |
| N / 0 | 本地仅领先             | 无需拉入远端；需要共享成果时普通 push |
| N / M | 双方均有新提交，已分叉 | 审阅改动后 merge，保留双方历史        |

本次实际为 3 / 6：本地有设备整理和 B0 三个提交，远端有 A 线/导航/CI 六个提交。仅快进无法处理这种分叉；盲目用远端覆盖本地会丢失 B0。

## 3. 分叉时先建备份，再合并

确认工作区干净，并且当前就是要接收更新的分支。备份分支只保存当前已提交历史，不保存未提交文件：

```powershell
$syncBackupBranch = "backup/main-before-sync-" + (Get-Date -Format yyyyMMdd-HHmmss)
git branch $syncBackupBranch HEAD
git merge --no-commit --no-ff origin/main
```

`--no-commit` 让结果停在提交前，便于复核；`--no-ff` 为整合保留合并提交。遇到冲突时命令返回非零，先处理冲突，再继续；这时重复 pull 不会解决问题。需要隔离复杂整合时，可先建独立任务分支/worktree，验证后再快进回 main。

## 4. 按文件解决冲突

```powershell
git status
git diff --name-only --diff-filter=U
```

文本冲突需编辑文件，删除冲突分隔标记，并保留双方需要的最终内容。这里处于普通 merge：HEAD 是合并前本地版本，origin/main 是这次合入的远端版本。可用以下命令查看共同基线、自己的版本和对方的版本：

```powershell
git show :1:code/README.md
git show :2:code/README.md
git show :3:code/README.md
```

修改完成后逐个登记已解决文件，例如：

```powershell
git add -- code/README.md
```

modify/delete 表示一边删除、另一边修改。决定继续删除时用 `git rm -- 文件路径`；决定保留时先整理正确内容，再 git add。不要整批选择 ours/theirs：本次 B 任务要保留本地 B0 done 和 B1 planned，同时吸收远端 A 线依据；设计目录的四份任务则保留远端的唯一任务跳转。

AGENTS.md 继续作为设备文件；远端新增的共享规则归入根 CONTRIBUTING.md。根 `.gitignore` 中的 `AGENTS.md` 匹配各级同名文件；`AGENTS.md/` 只匹配目录。忽略规则不会自动取消已跟踪文件；确定要停止跟踪且保留本机副本时可用 `git rm --cached -- AGENTS.md`，再确认忽略规则生效。

如果合并尚未提交且想整体撤回：

```powershell
git merge --abort
```

先备份新写入但未提交的重要内容；abort 返回合并前的提交状态，不是文件备份工具。

## 5. 冲突消失后仍要验证

```powershell
git diff --name-only --diff-filter=U
git diff --check
git diff --cached --check
```

第一条应无输出。后两条检查工作区和暂存区差异；还要查看文件内容，远端已经提交过的冲突标记未必在 Git 的未合并列表中。本次根 CI 文件正是这种情况。

当前项目的检查入口：

```powershell
python -B code/docs/development/workstreams/b/verify_b0.py
python -B design_document/scripts/design/verify_subsystem_designs.py
python -B design_document/scripts/design/verify_development_docs.py
Push-Location code
npm.cmd ci --ignore-scripts
npm.cmd run check
Pop-Location
```

每条命令均先确认退出码为 0；失败时先处理或记录实际原因，再执行依赖它的后续动作。产品检查通过不等于 Electron 界面或线上 CI 已运行。

复核暂存区只含预期内容，然后结束合并：

```powershell
git diff --cached --stat
git commit -m "Merge origin/main and resolve integration conflicts"
git status --short --branch
git log --graph --oneline --decorate -12
```

如果此前用了 stash，完成同步后 `git stash apply` 恢复工作，检查差异及冲突；确认内容完整后才 `git stash drop`。stash apply 的冲突也需编辑解决，不要用覆盖或清空目录处理。

## 6. 需要共享本地提交时推送

```powershell
git push origin main
```

普通 push 会拒绝覆盖其他人已提交的历史。若再次出现 non-fast-forward，说明远端又前进了，重新 fetch、审阅和合并后再推送；不要用 force push 解决多人 main 的分叉。

`git pull` 本身包含 fetch 和随后配置的 merge/rebase。需要先看清远端变化时，分开执行更容易判断。可在本仓库执行 `git config pull.ff only`，使以后直接 pull 遇到分叉时停下来，改为上述明确的合并步骤；该设置不会解决已有冲突。

本次处理证据与限制见[同步记录](../verification/sync-2026-10-23.md)。
