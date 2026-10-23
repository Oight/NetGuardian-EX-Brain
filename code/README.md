# 校安智脑 · campussec

业务基线 **v4.2**，内部工程契约 **0.2.0**，外部信封 **0.1.0**。设计资料提供并署名：**Shimakaze-17900**；实现与整理：Codex 辅助。[设计快照与来源](spec/README.md)。

目前已有 S01 契约、S02 SQLite 存储和 S03 桌面宿主基座；renderer 是最小状态页。S04—S12 的业务实现、完整 P0 和真实接入尚未完成。待实现目录只有说明，没有成功占位接口。

## 从这里开始

- [结构与四线归属](docs/development/structure.md)：目录、模块入口、共享文件和测试位置。
- [任务登记](docs/development/tasks/README.md)：每条线的阶段、依赖和交接；状态只在具体任务文件维护。
- [协作流程](docs/development/workflow.md)：领取、分支、共享变更与交接。
- [运行与检查](docs/development/commands.md)：Bun 本机命令和其他成员的标准命令。
- [本次验证](docs/verification/structure-2026-10-23.md)：实际结果及未执行项。

## 四条工作线

| 工作线 | 业务归属 | 主要目录 |
|---|---|---|
| A 工程与调度 | S01、S03、S07；公共工程与 testkit | contracts、testkit、core/requests、core/investigations、desktop/main、preload、runtime |
| B 本地业务 | S02、S05、S06、S10；物理 DDL/迁移 | storage、core/alerts、core/cases、core/reports、investigation-profile |
| C 外部接入 | S04、S08、S09、S11 | wazuh-adapter、teleagent-bridge、mcp-server、core/delivery |
| D 界面与验收 | S12；用户验收场景 | desktop/renderer、tests/acceptance |

根配置、锁、公共导出、检查脚本、CI 与装配由 A 串行维护；B 维护迁移不等于拥有全部业务状态。完整目录见结构说明。

## 本机检查

在本目录执行。本机只使用 Bun，不启动 Node.js、npm、npx、Electron 或安装钩子。

```sh
bun install --ignore-scripts --frozen-lockfile --cache-dir .cache/bun
bun scripts/local/check.ts
```

其他成员使用标准 Node/npm/Python 环境，命令见[检查说明](docs/development/commands.md)。Python 保持 3.12 约定，目前产品检查无需 Python 依赖。

本机通过只证明 Bun 下的类型、真实 SQLite 与合成行为。Node/npm、Electron、Windows、系统保护和安装包仍待外部验收。当前目录尚未建立产品 Git main；旧基座不能作为新版四线阶段已合并的证明。
