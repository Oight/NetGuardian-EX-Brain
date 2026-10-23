# 安装、构建与检查

所有产品命令从仓库 code/ 执行。Node 须符合 package.json 的 >=24.15 <25；系统版本不足时使用独立工具链，不修改 engines 来绕过门槛。依赖由双锁记录，默认禁用安装钩子。

```sh
npm ci --ignore-scripts
npm run check
```

| 检查 | 标准命令 |
|---|---|
| 类型 | npm run typecheck |
| 构建 | npm run build |
| 源码边界 | npm run check:boundaries |
| 原文/schema/安全配置 | npm run check:spec（先构建） |
| 双锁图元数据 | npm run check:locks |
| 构建与行为测试 | npm test |
| 全部检查 | npm run check |

总检查先构建再加载包，支持没有 dist 的干净检出。check:boundaries 覆盖静态导入与字面量 SQL，不证明动态 SQL 或运行时授权。check:spec 核对快照哈希、137 个声明、70 个 DTO、43 个桌面方法、初始迁移和宿主安全配置。

Bun 环境可执行 `bun install --ignore-scripts --frozen-lockfile --cache-dir .cache/bun` 后运行 `bun scripts/local/check.ts`。旧 Linux/Bun 的禁止启动 Node 限制仅是该执行环境记录；不是当前 Windows 或其他成员的全组要求。Python 设计检查仍在 design_document/ 执行。

## 桌面与 CI

依赖安装禁用钩子时未准备 Electron 二进制，不能直接把 npm run desktop 当作已可运行。窗口、托盘、系统保护、目标 Electron 的 SQLite 和安装包均需独立验证；当前未执行。

根 .github/workflows/foundation.yml 可从 GitHub Actions 手动触发，分别在 code/ 和 design_document/ 执行；没有 push/pull_request 自动触发，保持此前关闭自动检查的决定。标准矩阵为 Linux/Windows，线上结果待执行。

依赖变化由 A 维护两份锁。现有导出器只支持简单单版本图，复杂图明确拒绝；锁元数据一致与 npm ci 成功分别记录。当前结果见[接手验证](../verification/a-handoff-2026-10-23.md)。
