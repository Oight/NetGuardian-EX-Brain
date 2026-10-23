# 桌面目录归属

- A / S03：main、preload、runtime、assets、桌面 package.json 和构建装配；tests/desktop.test.ts、tests/lifecycle.test.ts 为现有宿主合成测试。
- D / S12：renderer 及其中自有 tests；跨模块用户流程放根 tests/acceptance。
- renderer 只消费 DesktopApi；不能直接读数据库、调用平台、使用 Electron/Node 特权。现有页面只是基座状态页，完整工作台尚未实现。
- main/preload 的权限配置不可因 UI 方便而放宽。秘密不进入 renderer、快照、事件或错误正文。
- 本机不得启动 Electron；宿主逻辑在 Bun 下使用合成适配验证，实际窗口/托盘/安装包由外部环境验收。
