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

## 检查

在 code/ 执行标准环境命令：

```sh
npm ci --ignore-scripts
npm run check
```

Node 版本须满足 package.json；当前 Windows 接手复验使用 Node 24.15.0，见[接手验证](docs/verification/a-handoff-2026-10-23.md)。Bun 可作为另一个验证环境，命令见运行说明。安装默认禁用依赖钩子，因此 Electron 二进制不会自动下载；GUI 和安装包需独立准备与验收。

既有产品基座已在当前仓库 main 的 64443ed 入库，不能继续将其描述为“尚无产品 Git”。四线阶段是否完成仍以各任务验收为准；当前 S06/S07 和真实调查链路未实现。
