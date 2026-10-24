# 工程脚本

A 串行维护。product 放标准构建、测试发现、边界/原文/锁检查；local 放 Bun 检查、干净复验与合成浏览器工具；assets 放静态资源生成。

product/test-windows-full.ts 是明确的 Windows/Node 专用入口，依次完成冻结安装、全部产品检查、干净复验和 Electron 验收，报告写入 .local/windows-full。windows-test-plan.ts 可在 Bun 下以纯假 runner 测试失败传播；不因此执行真实命令。scripts/electron/foundation-smoke.cjs 只由外部真实 Electron 加载。

业务源码不依赖这些脚本。本机所有子命令使用 process.execPath（Bun），不执行 Node/npm/Electron。标准 npm 命令仅由其他成员/外部环境执行。
