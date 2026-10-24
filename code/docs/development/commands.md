# 安装、构建与检查

产品命令从 `code/` 目录执行。工具版本以 package.json 与锁文件为准；各设备的路径、工具探测和 Agent 角色保存在 Git 忽略的仓库根 AGENTS.md，不作为其他成员的环境限制。

## 标准 Node/npm 环境

使用 code/.node-version 的 Node 24.15.0（engines 允许 >=24.15 <25）及 packageManager 指定的 npm 11.12.1 与现有 npm 锁文件。.npmrc 默认开启 engine-strict 并禁用依赖钩子：

```sh
npm ci --ignore-scripts --cache .cache/npm
npm run check
npm run check:clean
```

Windows PowerShell 可使用 `npm.cmd`、`npx.cmd` 调用对应工具，不要求修改全局执行策略。产品检查不依赖 Python；设计检查使用 Python 3.12，可直接调用 `python`，不强制要求 uv。

默认禁用依赖脚本。桌面验证单独下载锁定版本官方二进制，核对已锁 npm 包中的官方 SHA256 后解压，不执行依赖安装钩子：

```sh
npm run prepare:electron
npm run test:electron
```

接受测试使用真实生产 bootstrap、preload、renderer 和 SQLite，隐藏窗口，所有数据位于独立的 .local/electron-acceptance。分别启动写入/重开两个 Electron 进程，校验 IPC、沙箱、托盘、系统保护和正常退出；不读取个人 userData。当前接受范围为 Windows x64；Linux 的系统保护/显示服务条件不同，不能推导通过。完整安装包属于后续 A4。

普通手动启动执行 `npm run prepare:electron` 后运行 `npm run desktop`，使用同一个已校验的本地 Electron 二进制；不要求重新运行依赖安装钩子。

总检查先构建再加载包，支持没有 dist 的干净检出。单独执行 check:spec 前先构建，避免缺少包导出产物。

| 检查 | 标准环境 | 可选 Bun 环境 |
|---|---|---|
| 环境门槛 | `npm run check:environment` | 标准环境另测 |
| 类型 | `npm run typecheck` | `bun node_modules/typescript/bin/tsc --noEmit` |
| 源码边界 | `npm run check:boundaries` | `bun scripts/product/check-boundaries.ts` |
| 原文/schema/权限配置（先构建） | `npm run check:spec` | `bun scripts/product/verify-foundation.ts` |
| 锁图元数据 | `npm run check:locks` | `bun scripts/product/export-npm-lock.ts --check` |
| 测试 | `npm test` | `bun scripts/product/test.ts` |
| 构建 | `npm run build` | `bun scripts/product/build.ts` |
| 全部检查 | `npm run check` | `bun scripts/local/check.ts` |

## 可选 Bun 检查环境

以下路径保留给需要 Bun 检查的设备，不限制 Node/npm 的正常使用：

```sh
bun install --ignore-scripts --frozen-lockfile --cache-dir .cache/bun
bun scripts/local/check.ts
```

Bun 统一检查用当前 Bun 可执行文件启动子命令，最后编译标准测试代码，不启动 Electron。其规范检查要求依赖目录未执行 Electron 安装钩子；已有完整 Electron 安装的设备使用标准 Node/npm 检查。切换环境前核对已有依赖，不为通过检查删除已安装二进制或改写锁。

共享代码使用标准 TypeScript、ES modules 和 npm workspaces，不要求每位成员安装 Bun。测试从 packages、apps、tests 的源码发现 `*.test.ts`，不执行旧生成物。历史 Linux/Bun 结果只代表原执行环境；Node 内置 SQLite、Electron SQLite、系统保护存储、Windows 窗口/托盘及安装包分别记录实际结果。

## 锁与检查边界

依赖变化由 A 维护两份锁。简单单版本图可使用 `bun scripts/product/export-npm-lock.ts` 导出 npm 锁；复杂图明确拒绝，不能猜测 npm 解析。锁图一致不等于 npm ci 通过。

check:boundaries 扫描全部现有产品源码，检查声明组件依赖、公共 fake 纯度、renderer 特权、Bun 专用 API 和字面量 SQL 写所有权。它不证明动态 SQL 或运行时授权正确。

check:spec 检查设计哈希、137 个声明、DTO/桌面 schema、初始迁移和桌面权限配置。原文快照不被产品脚本写入。设计检查、产品检查和线上 CI 分别记录通过、失败或未执行，不能互相替代。

根 `.github/workflows/foundation.yml` 仅 workflow_dispatch 手动触发；产品任务在 code/、设计任务在 design_document/ 执行，标准矩阵为 Linux/Windows。线上运行结果另记。A 线已有[标准运行时接手验证](../verification/a-handoff-2026-10-23.md)，不推定所有成员或 Electron 已复现。


`check:clean` 用当前 npm CLI 在不含依赖/生成物的新源码副本执行冻结离线安装与同组检查，须先将 npm ci 的包下载到 .cache/npm；不把旧 dist 或祖先目录 node_modules 当作成功依据。临时副本和报告均被忽略。

当前手动 CI 固定 .node-version，Linux/Windows 运行标准检查及干净复现；Windows 另跑真实 Electron 验收。是否已执行线上工作流另记，本次不自动触发或推送。详见[2026-10-24 完整交付验证](../verification/a-completion-2026-10-24.md)。
