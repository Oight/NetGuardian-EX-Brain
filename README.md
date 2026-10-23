# 校安智脑 · campussec

面向高校安全运维的安全调查工作台。以 Wazuh 为首个上游，使用 Node.js/Electron 管理请求、案件与证据，由 TeleAgent 按需查询、形成带引用的调查草案。

业务基线 **v4.2**；内部工程契约 **0.2.0**；外部 IPC/MCP/导出信封 **0.1.0**。

## 当前阶段

2026-10-23 初始化本地 Git 仓库，默认分支 `main`。仓库内已有设计、契约、SQL、离线检查脚本与轻量协作规范；产品 workspace、依赖锁文件、共享 testkit、客户端代码和安装包仍待实现。

现有研究分别包含静态分析、模拟验证、真实模型文本和 Wazuh API 读取，尚未证明真实模型、专用 Skill、两类 MCP 与 Wazuh 的完整调查闭环。原始研究材料保留在原资料工作区，见[来源索引](docs/reference-index.md)。

## 阅读入口

- [项目现状](docs/project-status.md)与[文档目录](docs/README.md)
- [v4.2 主设计](docs/current/security-triage-client-design-v4.md)与[实验计划](docs/current/security-triage-client-experiments-v4.md)
- [子系统工程设计](docs/implementation/README.md)、[契约](docs/implementation/contracts.ts)与[SQL](docs/implementation/schema.sql)
- [开发准备清单](docs/development/readiness.md)、[贡献流程](CONTRIBUTING.md)与[Agent 约定](AGENTS.md)
- [仓库初始化记录](docs/development/repository-setup.md)与[来源快照清单](docs/source-imports.json)

## 本地检查

使用 Python 3.12，在仓库根目录执行：

```powershell
python -B scripts/design/verify_subsystem_designs.py
python -B scripts/design/verify_development_docs.py
```

若本机 Node 支持直接解析 TypeScript，可额外运行：

```powershell
python -B scripts/design/verify_subsystem_designs.py --node-syntax
```

上述命令只做离线设计与规范检查；不等同于产品 tsc、构建或真实链路验收。`.github/workflows/design-checks.yml` 已准备，GitHub 远端与线上执行尚未配置。

## 三账号小组协作

使用一条 `main` 主线和短任务分支。完成者负责自检、记录结果及合并；PR 按需使用，不设置专职审查者或另一账号审批门槛。初期任务状态统一记录在 [docs/development/tasks](docs/development/tasks/README.md)。共享文件一次只交一个任务修改。

本轮仅初始化本地仓库。下一步建立具有实际 base commit、允许路径和验收命令的产品基座任务；尚不启动全部子系统或真实外部实验。
