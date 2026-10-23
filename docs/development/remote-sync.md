# 首次 GitHub 同步准备

日期：2026-10-23。任务状态唯一位置为 [T000](tasks/T000-github-bootstrap.md)。本记录保存已观察事实与验证依据，不维护第二份任务看板。

## 目标与授权

- HTTPS origin：https://github.com/Oight/NetGuardian-EX-Brain.git。
- 目标分支：main。
- 用户要求：查看线上仓库并准备推至线上。本轮执行读取、本地整合和 dry-run；实际推送待确认。
- 不创建 Issue/PR，不修改仓库权限或分支保护，不启动模型、宿主或 Wazuh 操作。

## 远端观察

git ls-remote --symref 与 fetch 结果一致：HEAD 指向 main，main 为 d51096a5cbdae282e6d7c28ca3752e980c2c0cfb。

远端当前文件树为空，历史包含 d01b76c Initial commit 与 d51096a Delete LICENSE。它是内容为空但有历史的仓库，不能将现有历史当作不存在或直接强推覆盖。

本地基准为 af60d1e5c67d6a114f07b49c42aa3cc8776075e6。首次整合使用保留两段独立历史的合并；远端 LICENSE 删除维持，不引入或选择新的项目许可证。实际发布采用普通 main 推送，远端若出现新提交则先重新整合。

## 验证

整合提交为 753cd96，保留本地基准和远端 main 两个父历史；merge-base --is-ancestor origin/main HEAD 通过。整合后六项授权文档变化及 60 份 UTF-8 文本/规范文件已核对，未纳入 private、研究、归档、迁移或运行材料；定向检查未发现私钥、长 JWT 和指定 API key 格式。该定向检查不代表完整秘密检测认证。

contracts.ts、schema.sql、contract-vectors.json、architecture.json 与原资料工作区字节一致。source-imports.json 继续表示初次导入快照，不因本轮后续有意修改文档而重算原始哈希。

执行结果：

| 检查 | 实际结果 |
|---|---|
| verify_subsystem_designs.py --node-syntax | 通过；17 份工程文档、137 个契约声明、49 张表和合成约束；13 份 TypeScript 仅语法解析 |
| verify_development_docs.py | 通过；48 份 Markdown、238 个本地链接、19 个声明组件和49张表所有者 |
| git diff --cached --check | 本轮六份文档的增量检查通过；不改写此前历史格式提示 |
| push --dry-run --porcelain origin HEAD:refs/heads/main | 对 753cd96 返回 0，显示 d51096a..753cd96 可更新；没有实际更新线上分支 |

后续补记结果的文档提交随任务分支快进合并到本地 main，准确最终 HEAD 由 Git 历史记录。现有产品 workspace、runtime schema、客户端与安装包仍未实现。

未实际推送，未执行线上 Actions。即使 dry-run 通过，也不能据此证明线上 CI、分支规则或包含 workflow 的实际上传一定通过。

## 确认后的推送方式

复核 origin/main 没有新增提交、待推送内容与检查后，执行：

```powershell
git push --set-upstream origin main
```

只推送准备好的 main 分支，不使用 force、mirror 或批量标签推送；推送后再核对线上 HEAD 和 Actions 实际结果。远端任务功能与保护设置继续按三账号小组需要安排，不增加强制另一账号审查门槛。
