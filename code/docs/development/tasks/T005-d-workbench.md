# T005 · D：工作台与用户验收

状态：checking（本地案件路径已通过合成浏览器与真实 SQLite 验证；完整 D1/D3 和真实 Electron 验收尚未完成，未提交/合并）。唯一状态位置：本文件。

分工来源：`120c81cfd4d8ed720c9cc70178edb9c6fd172a34`；可领取产品基准：64443ed；执行者、实际启动 HEAD 与依赖验收 commit 在领取时填写。允许 renderer、tests/acceptance 和[本线交接目录](../workstreams/d/README.md)，不写 main/preload/runtime、公共 fake、根锁或业务数据库。

| 阶段 | 状态    | 前置实际交付                   | 目标                                       |
| ---- | ------- | ------------------------------ | ------------------------------------------ |
| D0 | checking | 无产品依赖                     | 页面流程、隔离静态原型、合成案例和验收矩阵 |
| D1 | checking | A1/A2、A3 对应 DesktopApi fake | typed client、完整工作台与明确错误状态     |
| D2 | checking | D1、B2、A4 最小 IPC            | 真实创建案件/保存/重启回读与最小安装包     |
| D3   | planned | D2、B3、C3/C4、A4              | 三入口、预算/取消/恢复/导出/投递场景       |
| D4   | planned | A5；真实场景另需授权           | 使用说明、可复现流程、证据与剩余问题       |

## 交接

现有 [renderer](../../../apps/desktop/renderer/README.md)显示真实摘要，没有完整案件操作，不能宣布 S12/D1 完成。UI 只消费 DesktopApi，不用内部模块名代替功能；D0 不另搭正式 workspace 或公共 fake。

按[统一命令](../commands.md)和[交接模板](../workflow.md)记录结果；真实 Electron 验证独立记录，不继承旧机器限制。

接手说明：根仓库与 code/ 共用 Git 历史。64443ed 只证明现有基座入库；A 当前复验未合并前，不自动放行本线后续阶段。A 的实际标准运行时结果见 T002。

## 2026-10-24 本地续作交接

用户授权跨 A/B/C/D 串行推进，实际代码基准 cc610cb6447ca70659030cc597b486a12cd8d872，依赖 A1—A3 已合入的 3ee347c / 157e956。只写 /home/eight/Project/GPT/campussec；来源仓库只读。本地目录未建立产品 Git，本轮无实现/合并 commit，不把 checking 写成 main 已验收。

本轮功能、公开入口、失败与未执行项统一见[本地案件闭环验证](../../verification/local-cases-2026-10-24.md)。Windows 开发者可运行 `npm.cmd run test:windows:full`；本机未执行 Node/Electron。后续阶段按原表依赖推进，不用本轮合成材料放行真实接入。
