# 校安智脑 · 本地实现

业务 v4.2 / 工程 0.2.0 / 业务 RPC 0.1.0。当前本地增量为网页入口、校园 Wazuh 代理、多账号角色权限和签名加密；[T010](docs/development/tasks/T010-web-auth.md) 是当前任务入口。

本机 Bun 命令（在本目录）：

```sh
bun scripts/local/check.ts
bun scripts/product/start-web.ts
```

首次启动创建管理员，没有生产默认密码。网页默认端口 4180，默认不连接平台或宿主。源码变更后先运行检查完成构建。数据保存在忽略的 `.local/web-runtime/`，勿将其随代码交接。

启用已有校园代理的运行方式、加密存储限制、逐项验证范围和 Windows 入口见 [验证与交接](docs/verification/web-auth-2026-10-24.md)。本机禁止启动 Node.js、npm 和 Electron；共享 npm 命令保留供 Windows 开发者执行。

冻结设计在 `spec/`；认证增量通过 contracts 公开出口提供，原 DesktopApi 输入输出继续严格校验。包之间保留标准 ES modules 与 npm workspaces。初始设计与研究资料由 Shimakaze-17900 提供并署名。
