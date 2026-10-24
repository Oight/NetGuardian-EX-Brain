# 校安智脑 · campussec

业务基线 **v4.2**，内部工程契约 **0.2.0**，外部信封 **0.1.0**。设计资料提供并署名：**Shimakaze-17900**；实现与整理：Codex 辅助。[设计快照与来源](spec/README.md)。

目前已有 S01 契约、S02 SQLite、S03 桌面宿主、独立 S07 原子预算与取证工具执行器、S06 案件/证据、S04 Wazuh 只读适配、S09 独立证据通道，以及 S10 调查配置/报告/人工核查/导出后端。案件工作台可创建案件、保存背景并重开回读；S10 已经 DesktopApi 装配。完整调查编排、告警业务、MCP 协议入口、宿主执行、回传与完整报告交互仍待后续阶段。[案件验证](docs/verification/local-cases-2026-10-24.md) · [报告任务与验证](docs/development/tasks/T003-b-local-domain.md) · [工具任务与接入](docs/development/tasks/T002-a-foundation.md)。

## 从这里开始

- [结构与四线归属](docs/development/structure.md)：目录、模块入口、共享文件和测试位置。
- [任务登记](docs/development/tasks/README.md)：每条线的阶段、依赖和交接；状态只在具体任务文件维护。
- [协作流程](docs/development/workflow.md)：领取、分支、共享变更与交接。
- [运行与检查](docs/development/commands.md)：标准 Node/npm 和可选 Bun 命令。
- [A 线接手验证](docs/verification/a-handoff-2026-10-23.md)与[B0 材料](docs/development/workstreams/b/README.md)：分别记录对应环境的结果及限制。

## 四条工作线

| 工作线       | 业务归属                          | 主要目录                                                                               |
| ------------ | --------------------------------- | -------------------------------------------------------------------------------------- |
| A 工程与调度 | S01、S03、S07；公共工程与 testkit | contracts、testkit、core/requests、core/investigations、desktop/main、preload、runtime |
| B 本地业务   | S02、S05、S06、S10；物理 DDL/迁移 | storage、core/alerts、core/cases、core/reports、investigation-profile                  |
| C 外部接入   | S04、S08、S09、S11                | wazuh-adapter、teleagent-bridge、mcp-server、core/delivery                             |
| D 界面与验收 | S12；用户验收场景                 | desktop/renderer、tests/acceptance                                                     |

上表为原分工参考，实际按任务路径认领；根配置、锁、公共导出、检查、CI、装配与迁移纳入当次范围并由单任务串行维护，物理迁移维护不等于拥有全部业务状态。完整目录见结构说明。

## 安装与检查

Windows 开发者使用 Node.js 24.15.0 / npm 11.12.1，可在本目录执行一键全量自动化与真实 Electron 验收：

```powershell
npm.cmd run test:windows:full
```

该命令自动完成冻结依赖安装、产品检查、干净副本复验和 Electron 双进程验收；结果写入忽略的 `.local/windows-full/`。首次需要下载官方依赖与 Electron，完整安装包和真实平台联调另行验收。详细前置和失败处理见[运行与检查](docs/development/commands.md)。本机 Bun/uv 开发设备不执行此命令。

在本目录执行。使用 package.json 声明的 Node.js 版本和现有锁文件；设备专属环境与 Agent 角色保存在 Git 忽略的仓库根 AGENTS.md。

```sh
npm ci --ignore-scripts
npm run check
```

Windows PowerShell 可使用 npm.cmd 调用同一命令；Bun 可选检查路径见[检查说明](docs/development/commands.md)。Python 保持 3.12 约定，目前产品检查无需 Python 依赖。

默认禁用依赖安装钩子，因此不自动准备 Electron 二进制；GUI 和安装包需另外准备并验收。标准检查先构建再加载包，支持没有 dist 的干净检出。

历史 Bun 检查只证明对应环境下的类型、真实 SQLite 与合成行为，不代表当前设备复现。Node/npm、Electron、Windows、系统保护和安装包分别记录实际验收结果。工程基座已纳入本仓库 Git；各工作线阶段是否完成仍以任务单及准确实现/合并记录为准。

当前 A 线完整基座、真实 Electron 启动与原子预算验证见[2026-10-24 记录](docs/verification/a-completion-2026-10-24.md)。任务是否完成只以 T002 的已合并依据为准。
