# 安装、构建与检查

所有命令从项目根执行。候选工具版本由 package.json 与锁记录；Electron/SQLite 真实兼容仍待目标环境验收，不把版本声明写成已通过组合。

## 本机 Bun/uv

本机禁止 Node.js、nodejs、npm、npx、Electron 和依赖安装钩子，不用改名或包装器绕过。先审查新增依赖生命周期脚本，再禁用脚本安装。

```sh
bun install --ignore-scripts --frozen-lockfile --cache-dir .cache/bun
bun scripts/local/check.ts
```

| 检查 | 本机 Bun | 其他成员标准环境 |
|---|---|---|
| 类型 | `bun node_modules/typescript/bin/tsc --noEmit` | `npm run typecheck` |
| 源码边界 | `bun scripts/product/check-boundaries.ts` | `npm run check:boundaries` |
| 原文/schema/权限配置 | `bun scripts/product/verify-foundation.ts` | `npm run check:spec` |
| 锁图元数据 | `bun scripts/product/export-npm-lock.ts --check` | `npm run check:locks` |
| 测试 | `bun scripts/product/test.ts` | `npm test` |
| 构建 | `bun scripts/product/build.ts` | `npm run build` |
| 全部检查 | `bun scripts/local/check.ts` | `npm run check` |

本机检查只用当前 Bun 可执行文件启动子命令，最后编译标准测试代码，不启动 Node.js/Electron。测试从源码发现 packages、apps、tests 下 *.test.ts，不执行旧生成物。Python 如需使用，通过 uv 保持 3.12；缓存与其他写入也放在授权目录。

## 其他成员的独立环境

以下命令不在本机执行。

```sh
npm ci
npm run check
npm run desktop
```

共享代码保持标准 TypeScript、ES modules、npm workspaces，其他成员不需要 Bun/uv。Node.js 为 package.json 声明的候选 24.x。Electron 窗口/SQLite/保护存储、Windows 和安装包分别记录目标环境结果。

依赖变化由 A 维护两份锁。简单单版本图可使用 `bun scripts/product/export-npm-lock.ts` 导出 npm 锁；复杂图明确拒绝，不能猜测 npm 解析。锁图一致不等于 npm ci 通过。

## 检查边界

check:boundaries 扫描全部现有产品源码，检查声明组件依赖、公共 fake 纯度、renderer 特权、Bun 专用 API 和字面量 SQL 写所有权。它不证明动态 SQL 或运行时授权正确。

check:spec 检查设计哈希、137 个声明、DTO/桌面 schema、初始迁移和桌面安全配置。设计仓库删除 Actions 后的 Python 检查问题仍需来源维护者修复，本次不越界修改。

外部 CI 文件只为标准环境准备，尚未推送或触发。原文快照不被产品脚本写入。
