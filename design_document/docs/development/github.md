# Git 与 GitHub 接入

日期：2026-10-23；协作规范 0.2。origin 为 [Oight/NetGuardian-EX-Brain](https://github.com/Oight/NetGuardian-EX-Brain)。用户确认后已完成首次 main 推送并设置 origin/main 跟踪；未创建 Issue/PR 或修改 GitHub 权限。线上 Actions 状态尚未核实，状态及证据见[首次同步记录](remote-sync.md)。

## 当前本地用法

使用短任务分支，完成者自检、记录结果并合并。任务状态保存在 [tasks](tasks/README.md)。PR 按需使用，不要求专职审查者或另一账号批准；GitHub 接入不是本地基座开发的前置条件。

仓库只纳入开发所需文档、契约、SQL、合成向量及离线检查。private、数据库、日志、研究二进制和个人会话不入库；[来源索引](../reference-index.md)说明未导入的原件。

## 首次同步准备

用户提供的 HTTPS 地址为 https://github.com/Oight/NetGuardian-EX-Brain.git。只读检查发现远端 main 指向 d51096a5cbdae282e6d7c28ca3752e980c2c0cfb，当前文件树为空；其前序仍有 Initial commit。本地首次同步保留远端历史，与本地初始化历史合并，不强推或恢复已删除的 LICENSE。

最初授权为检查和准备推送；本地整合、文件范围及离线检查与 dry-run 通过后，用户明确确认“好，推送吧”。正式推送使用 git push --set-upstream origin main，并在推送前后核对远端 HEAD，未覆盖新增历史。后续推送同样先确认目标及最新远端状态。

账号权限和仓库设置由有权限的实际账号操作。不读取或输出凭据，不自动启动新的登录会话；若既有 Git 认证不能完成预演，如实记录限制。

Issue、PR 模板已准备，可选择性使用。若切换到 Issue 维护状态，在原任务文件标明链接和切换时间，不维护双份实时看板。CODEOWNERS.example 只是可选示例，当前不启用，也不当作文件锁。

## 检查与合并

日常保留本地检查与准确提交记录。分支保护及线上检查若后续启用，以实际权限与仓库能力为准，不增加强制另一账号审查的流程。

现有 design-checks 工作流已推送，仅运行离线设计/规范检查，权限为 contents: read，不注入业务秘密，action 固定提交。匿名 GitHub API 返回 404，尚不能核实线上运行结果，不能声称 GitHub CI 已通过。产品基座落地后再补实际类型、边界、关键集成和构建检查；默认不访问真实模型或 Wazuh。
