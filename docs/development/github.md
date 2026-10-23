# Git 与 GitHub 接入

日期：2026-10-23；协作规范 0.2。本地仓库已在 main 初始化，origin 已配置为 [Oight/NetGuardian-EX-Brain](https://github.com/Oight/NetGuardian-EX-Brain)。本轮首次同步准备及 dry-run 已通过，尚未实际推送、创建 Issue/PR 或修改 GitHub 权限；状态及证据见[首次同步记录](remote-sync.md)。

## 当前本地用法

使用短任务分支，完成者自检、记录结果并合并。任务状态保存在 [tasks](tasks/README.md)。PR 按需使用，不要求专职审查者或另一账号批准；GitHub 接入不是本地基座开发的前置条件。

仓库只纳入开发所需文档、契约、SQL、合成向量及离线检查。private、数据库、日志、研究二进制和个人会话不入库；[来源索引](../reference-index.md)说明未导入的原件。

## 首次同步准备

用户提供的 HTTPS 地址为 https://github.com/Oight/NetGuardian-EX-Brain.git。只读检查发现远端 main 指向 d51096a5cbdae282e6d7c28ca3752e980c2c0cfb，当前文件树为空；其前序仍有 Initial commit。本地首次同步保留远端历史，与本地初始化历史合并，不强推或恢复已删除的 LICENSE。

本轮授权为检查和准备推送；先完成本地整合、文件范围及离线检查，再以 git push --dry-run --porcelain origin main:refs/heads/main 预演。dry-run 不更新线上分支，也不证明 GitHub Actions 已执行。实际推送在用户确认后使用 git push --set-upstream origin main，并重新核对远端是否出现新提交。

账号权限和仓库设置由有权限的实际账号操作。不读取或输出凭据，不自动启动新的登录会话；若既有 Git 认证不能完成预演，如实记录限制。

Issue、PR 模板已准备，可选择性使用。若切换到 Issue 维护状态，在原任务文件标明链接和切换时间，不维护双份实时看板。CODEOWNERS.example 只是可选示例，当前不启用，也不当作文件锁。

## 检查与合并

日常保留本地检查与准确提交记录。分支保护及线上检查若后续启用，以实际权限与仓库能力为准，不增加强制另一账号审查的流程。

现有 design-checks 工作流仅运行离线设计/规范检查，权限为 contents: read，不注入业务秘密，action 固定提交。远端首次运行前不能声称 GitHub CI 已通过。产品基座落地后再补实际类型、边界、关键集成和构建检查；默认不访问真实模型或 Wazuh。
