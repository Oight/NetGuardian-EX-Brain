# T000 · 首次 GitHub 同步准备

- 完成者：当前用户授权的本地执行 Agent；不设专职审查者。
- 唯一状态位置：本文件。
- 状态：done（本地推送准备完成；实际推送待确认）。
- 分支：task/github-bootstrap。
- 本地实际 base commit：af60d1e5c67d6a114f07b49c42aa3cc8776075e6。
- 依赖：本地初始化 d2a10dc 和克隆核验 af60d1e 已在 main；远端 main 基准为 d51096a5cbdae282e6d7c28ca3752e980c2c0cfb。
- 版本：业务 v4.2；内部工程 0.2.0；外部协议 0.1.0，均不变。

## 范围与完成条件

用户要求查看指定 GitHub 仓库并准备推至线上。允许修改根 README、docs/development/github.md、readiness.md、remote-sync.md、tasks/README.md 及本任务文件，并配置本地 origin、fetch、整合历史和执行 push dry-run。contracts.ts、schema.sql、设计基线、源码和根依赖只读。

不创建产品代码，不改变上游，不调用模型/宿主/Wazuh。本轮不实际推送，不创建 Issue/PR、分支保护或权限设置，也不读取/打印凭据。初始材料及运行记录的排除边界继续保留。

完成条件：核实远端内容和历史；在本地保留远端 main 的祖先关系；自查纳入文件；两个离线检查通过；记录 dry-run 实际结果与限制；准备结果合并到本地 main。若预演受认证或规则限制，不将其写成通过。

## 检查命令

在仓库根目录执行：

```powershell
python -B scripts/design/verify_subsystem_designs.py --node-syntax
python -B scripts/design/verify_development_docs.py
git diff --cached --check
git push --dry-run --porcelain origin main:refs/heads/main
```

本机 full access 使用的 Windows 账号与原 sandbox 不同，Git 命令必要时仅临时增加 -c safe.directory=D:/design_agent/campussec；不写全局信任或凭据配置。

## 进度与交接

已核实远端文件树为空，但存在 d01b76c Initial commit → d51096a Delete LICENSE 历史；fetch 后的整合提交为 753cd96，保留两段历史，无内容冲突，origin/main 是该提交的祖先。

两个离线检查通过：17 份工程文档、137 个契约声明、49 张 SQL 表和合成约束、13 份 TypeScript 语法，以及 48 份 Markdown、238 个本地链接、19 个声明组件。六项授权文档变化、60 份纳入文件和四份权威附件已核对，本轮增量空白检查通过。

对 753cd96 执行 push --dry-run --porcelain origin HEAD:refs/heads/main 返回 0，预演结果为 d51096a..753cd96 可更新。随后仅补记验证结果，并将任务分支快进合并到本地 main；本任务完成的是推送准备，实际推送和线上 CI 保持未执行。

实际结果和待确认项见[首次同步记录](../remote-sync.md)。PR/他人复核未使用，完成者自检。实际准备提交和 main 合并依据以 Git 历史为准，避免虚构自引用提交号。
