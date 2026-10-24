# 校安智脑 · campussec

业务基线 **v4.2**，内部工程契约 **0.2.0**，外部信封 **0.1.0**。设计资料提供并署名：**Shimakaze-17900**；实现与整理：Codex 辅助。[设计快照与来源](spec/README.md)。

目前已有 S01 契约、S02 SQLite 存储和 S03 桌面宿主基座；renderer 是最小状态页。已有独立 S07 原子预算实现；其余 S04—S12 业务、完整 P0 和真实接入尚未完成。待实现目录只有说明，没有成功占位接口。

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

根配置、锁、公共导出、检查脚本、CI 与装配由 A 串行维护；B 维护迁移不等于拥有全部业务状态。完整目录见结构说明。

## 安装与检查

在本目录执行。使用 package.json 声明的 Node.js 版本和现有锁文件；设备专属环境与 Agent 角色保存在 Git 忽略的仓库根 AGENTS.md。

```sh
npm ci --ignore-scripts
npm run check
```

Windows PowerShell 可使用 npm.cmd 调用同一命令；Bun 可选检查路径见[检查说明](docs/development/commands.md)。Python 保持 3.12 约定，目前产品检查无需 Python 依赖。

默认禁用依赖安装钩子，因此不自动准备 Electron 二进制；GUI 和安装包需另外准备并验收。标准检查先构建再加载包，支持没有 dist 的干净检出。

历史 Bun 检查只证明对应环境下的类型、真实 SQLite 与合成行为，不代表当前设备复现。Node/npm、Electron、Windows、系统保护和安装包分别记录实际验收结果。工程基座已纳入本仓库 Git；各工作线阶段是否完成仍以任务单及准确实现/合并记录为准。

当前 A 线完整基座、真实 Electron 启动与原子预算验证见[2026-10-24 记录](docs/verification/a-completion-2026-10-24.md)。任务是否完成只以 T002 的已合并依据为准。
