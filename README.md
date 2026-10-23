# 校安智脑 · campussec

面向高校安全运维的安全调查工作台。以 Wazuh 为首个上游，使用 Node.js/Electron 管理请求、案件与证据，由 TeleAgent 按需查询，形成带引用的调查草案。

业务基线 **v4.2**；内部工程契约 **0.2.0**；外部 IPC/MCP/导出信封 **0.1.0**。

## 当前阶段

仓库目前提供设计、契约、SQL、离线检查脚本与轻量协作规范。产品 workspace、依赖锁文件、共享 testkit、客户端代码和安装包仍待实现。

历史研究记录涉及静态分析、模拟验证、真实模型文本和 Wazuh API 读取；这些记录不等于真实模型、专用 Skill、两类 MCP 与 Wazuh 的完整调查闭环已完成。

## 资料归属与可访问范围

初始导入的项目设计和研究资料由 **Shimakaze-17900** 提供并署名，仓库文档由 Codex 辅助整理。官方文档、开源项目和公开数据集保留各自出处；后续维护贡献以文内说明和 Git 历史为准。

[来源登记](docs/reference-index.md)区分仓库内可读副本与未入库材料。指向来源登记的链接只说明出处，不是原报告正文；未共享材料需要由提供者另行分享。其他成员无需拥有任何个人电脑目录即可阅读仓库文档和运行下列离线检查。

## 阅读入口

- [项目现状](docs/project-status.md)与[文档目录](docs/README.md)
- [v4.2 主设计](docs/current/security-triage-client-design-v4.md)与[实验计划](docs/current/security-triage-client-experiments-v4.md)
- [子系统工程设计](docs/implementation/README.md)、[契约](docs/implementation/contracts.ts)与[SQL](docs/implementation/schema.sql)
- [开发准备清单](docs/development/readiness.md)、[贡献流程](CONTRIBUTING.md)与[Agent 约定](AGENTS.md)

## 离线检查

使用 Python 3.12，在仓库根目录执行：

```powershell
python -B scripts/design/verify_subsystem_designs.py
python -B scripts/design/verify_development_docs.py
```

若安装的 Node 支持直接解析 TypeScript，可额外运行：

```powershell
python -B scripts/design/verify_subsystem_designs.py --node-syntax
```

这些检查只核对设计与规范，不等同于产品 tsc、构建或真实链路验收。GitHub Actions 工作流已提交，线上结果尚未核实。

## 小组协作

使用一条 main 主线和短任务分支。完成者负责自检、记录结果及合并，PR 按需使用。任务状态统一记录在 [tasks](docs/development/tasks/README.md)，共享文件一次只由一个任务修改。

远端为 [Oight/NetGuardian-EX-Brain](https://github.com/Oight/NetGuardian-EX-Brain)。初始化与首次同步的历史记录见[建库说明](docs/development/repository-setup.md)和[同步记录](docs/development/remote-sync.md)；这些记录中的环境版本只描述对应执行，不是其他成员必须复刻的电脑配置。
