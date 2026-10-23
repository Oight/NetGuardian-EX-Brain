# 开发与贡献

当前为设计与产品基座准备阶段。先读[协作入口](docs/development/README.md)、[工程规则](docs/development/engineering-rules.md)及[开工门槛](docs/development/readiness.md)。设备环境与本机 Agent 角色保存在 Git 忽略的仓库根 AGENTS.md，不作为共享开发规范。

## 日常流程

1. 在 [tasks](docs/development/tasks/README.md) 建立具体任务，记录真实 base commit、依赖、允许修改路径及验收命令。
2. 从该基准创建短分支，例如 task/T001-foundation；并发工作时使用独立 clone/worktree，不共用未提交文件。
3. 完成者实现并自检差异、文件范围和关键行为，记录真实检查结果及未通过项。
4. 合并前检查 main 上的新变更及受影响组合；检查通过后由完成者合并。PR、另一成员或另一 Agent 复核均按需使用，不是固定门槛。
5. 在唯一任务文件中记录完成行为、检查与合并依据，更新到 done。尚未合并的本地成果保持 checking；需要外部验证的能力保留未通过。

当前按[四人工作线](docs/development/tasks/README.md)分派 A/B/C/D，具体账号领取时填写，不另设专职审查者或固定集成负责人。共享文件当次由一个任务负责；不能靠 Git 或 CODEOWNERS 自动防止覆盖。GitHub Issues 和 PR 模板仅供后续按需启用。

## 现有检查

```powershell
python -B scripts/design/verify_subsystem_designs.py
python -B scripts/design/verify_development_docs.py
```

使用能直接解析 TypeScript 的 Node 时，可增加 --node-syntax。现有检查涵盖设计链接、内嵌契约、SQL 合成约束和声明边界；不提供产品 typecheck/build/runtime schema，也不调用真实模型或 Wazuh。线上 Actions 结果尚未核实。

## 共享接口与依赖

遵循 [文件归属](docs/development/ownership.md)与[工程规则](docs/development/engineering-rules.md)。接口缺口先写具体调用场景、最小差异、消费者及兼容影响，再集中更新契约/SQL 唯一来源、版本和向量；随后 --sync 并核验。不复制影子接口或邻模块业务。

根依赖和锁文件由当次明确的任务修改。产品基座实际验证后再确定 Node/Electron/包管理器/SQLite 驱动/MCP SDK 版本，避免未经验证的版本承诺。

## 记录与授权

检查未提供、未执行、失败和通过分别记录；合成、真实文本和真实工具证据分开。测试默认使用合成夹具，不以个人秘密或现场网络作为离线检查前提。

初始项目设计和研究材料由 Shimakaze-17900 提供并署名，仓库文档由 Codex 辅助整理；第三方资料保持自身出处。后续贡献以文内说明和 Git 历史为准，不仅凭提交者推定其他原始材料的作者。

共享文档使用仓库相对链接，不写个人绝对路径或临时权限排障经过。未入库原报告标明提供者、署名和共享状态，链接指向来源登记时明确它不是报告正文。测试记录注明执行者、日期和环境，仅代表对应提交与样本，不代表全组复现或产品依赖要求。

导入和来源范围见[初始化记录](docs/development/repository-setup.md)及[来源登记](docs/reference-index.md)。远端推送、权限设置、真实平台及模型操作按当次授权执行。
