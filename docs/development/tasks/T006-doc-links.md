# T006 · 删除历史文档后的引用清理

- 执行与整理：Codex 辅助；状态：checking（本地检查通过，尚未合并记录）。
- 唯一状态位置：本文件。
- 实际 base commit：616f40cfcda6aa3d594ef65bcad11d6824bb7f88。
- 依赖：c8f152e 删除历史文件；不恢复 history 目录。
- 范围：AGENTS.md、docs/README.md、docs/version-history.md、docs/current/security-triage-client-design-v4.md、docs/reference-index.md、docs/source-imports.json、本任务文件和任务登记入口。
- 行为：历史文档链接改指来源登记，明确其不含原报告正文；来源副本标记已移除并注明 Git 追溯方式；初始导入路径、哈希、署名、referencedAtImport 作为历史快照保持不变。
- 版本：业务 v4.2、内部工程 0.2.0、外部信封 0.1.0 不变。
- 外部操作：无；由用户手动提交/推送，未访问真实模型或平台。

## 检查与交接

检查命令：`python -B scripts/design/verify_subsystem_designs.py`、`python -B scripts/design/verify_development_docs.py`、`git diff --check`。

执行结果：两个离线检查与 git diff --check 均通过，覆盖 17 份工程文档、137 个契约声明、49 张表、50 份 Markdown 与 225 个本地链接；source-imports.json 的 files 初次导入记录通过 JSON 结构比较确认不变。线上 CI 未核实。提交与合并依据由完成者在提交后补记，不填写未来自引用 commit。
