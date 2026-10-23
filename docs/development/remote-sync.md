# 首次 GitHub 同步记录

日期：2026-10-23。任务状态唯一位置为 [T000](tasks/T000-github-bootstrap.md)。本记录保存已观察事实与验证依据，不维护第二份任务看板。

## 目标与授权

- HTTPS origin：https://github.com/Oight/NetGuardian-EX-Brain.git。
- 目标分支：main。
- 用户要求：先查看线上仓库并准备推至线上，随后明确确认“好，推送吧”。本轮已执行读取、本地整合、dry-run 及正式 main 推送。
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

上述准备完成后，正式推送的实际结果另列于下一节，不将 dry-run 当作实际上传证明。线上 Actions 状态尚未核实。

## 正式推送与回读

用户确认后，重新核对 main、origin URL、干净工作区、待推送 a11a11b 及远端 d51096a 均与预演一致，执行：

```powershell
git push --set-upstream origin main
```

命令返回 0，线上 main 从 d51096a 更新到 a11a11ba0e9d8d1c374584a0163aeb6c643731bb。再次 ls-remote 取得同一完整 SHA，本地 main 已跟踪 origin/main，工作区干净。没有使用 force、mirror 或批量标签推送。

GitHub Actions 匿名 API 请求返回 HTTP 404，无法核实线上工作流是否运行或通过；不将该响应解释为仓库不存在、检查未运行或检查成功，也不读取/打印 Git 凭据来调用其他接口。

本记录及相关说明随实际推送状态补记一笔文档提交并同步 main，最终 HEAD 以 Git 历史及线上回读为准。远端任务功能与保护设置继续按三账号小组需要安排，不增加强制另一账号审查门槛。
