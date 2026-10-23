# 多人协作结构整理验证

日期：2026-10-23；执行与整理：Codex 辅助。范围只限本产品目录。业务 v4.2、工程 0.2.0、外部信封 0.1.0；设计原文和初始迁移校验值保持不变。

## 实际变化

- 按 A/B/C/D 建立结构、允许路径、模块说明和局部 AGENTS；未实现模块只有说明，不增加成功占位。
- 纯 fake 迁至 packages/testkit，移除对 storage/SQLite 的反向依赖；真实临时库夹具迁至 tests/support。
- 测试跟随 contracts/storage/testkit/desktop，工程失败场景放 tests/tooling；统一发现源测试，不执行旧构建产物。
- 通用工程脚本移到 scripts/product，本机编排移到 scripts/local，资源工具移到 scripts/assets；补齐 check:boundaries 标准入口。
- 新 T002—T005 对应四线，旧 T002 移到 history；具体状态只在任务文件维护。

## 检查

环境：Linux x64、Bun 1.4.4、TypeScript 5.9.3。全部子进程由当前 Bun 执行，未调用 Node.js 可执行程序。

| 命令/核对 | 实际结果 |
|---|---|
| 审查现有依赖与新 workspace 配置，再执行 `bun install --offline --ignore-scripts --cache-dir .cache/bun` | 通过；没有新增外部依赖，更新本地 workspace 链接与 Bun 锁 |
| `bun scripts/product/export-npm-lock.ts` | npm 锁图导出；未执行 npm |
| `bun scripts/local/check.ts` | 通过：严格类型、37 个产品源码边界、137 个原文声明、70 个 DTO/43 个桌面方法、DDL/锁图、测试、构建及标准测试代码编译 |
| 统一测试发现 | 27 个测试、6 个文件通过，0 失败；包含原有 25 个行为检查和 2 个边界失败场景 |
| 干净副本：排除依赖/缓存/生成物，执行 Bun 离线禁脚本冻结安装和统一检查 | 通过；重新安装 15 个外部包，未复用旧构建产物；同一组 27 个测试，不重复计算数量；临时副本已清理 |
| Markdown 本地链接核对 | 49 份文档、64 个本地链接通过，无缺失目标 |
| 现行源码/脚本的旧入口引用 | 已迁移；历史验证保留原命令并标明历史状态 |

最终检查无失败项。源码边界检查只覆盖静态导入与字面量 SQL，不代替运行时授权或动态 SQL 审计。

## 路径迁移

- fixtures/shared 的纯 fake → packages/testkit/src；真实目录/SQLite/预置数据 → tests/support/storage.ts。
- 原根 tests 的 contracts/storage/fixtures/desktop/lifecycle → 对应模块 tests；工程检查新增 tests/tooling。
- scripts/build、export-npm-lock、verify-foundation → scripts/product；check-local → scripts/local/check；make-tray-icon → scripts/assets。
- docs/tasks/T002-foundation → docs/history/foundation-initial-task；新版四线任务集中到 docs/development/tasks。

## 验证边界

本机没有启动 Node.js/npm/npx/Electron 或依赖安装钩子。Node/npm 锁安装、Electron/Windows/保护存储/安装包、线上 CI 与真实模型/宿主/Wazuh 均不属于本次已验证能力。

产品 Git 仓库尚未建立，无实现/合并 commit，不声称四线阶段已经合并。设计仓库 Actions 删除后的检查冲突仍由来源维护者处理，本次不写来源或父目录。
