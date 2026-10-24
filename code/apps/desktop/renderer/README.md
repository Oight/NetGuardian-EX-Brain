# 安全调查工作台

融合 `campusguard-mui` 的导航、概览、图表、表格、主题与资产展示，以及原工作台的真实案件、背景版本、证据引用与冲突处理。入口仍为 `mountWorkbench({element, api: DesktopApi})`；使用标准 TypeScript、浏览器 DOM 和本地 ES modules，无新增运行依赖。

11 个页面入口覆盖概览、告警、案件、任务、设备、背景、核查、报告、连接、接入状态与设置。业务只调用现有 DesktopApi；未装配的调查、报告、核查、投递与留存服务明确返回不可用，界面入口完成不代表后端实现或真实平台验收完成。

`/showcase/` 为明确标注的只读合成界面示例；`/qa/` 自动验证交互与 1160/780/390px 布局，结果写入忽略的 `.local/frontend-integration/browser-result.json`。

已对照目标仓库 `9e7687b` 的 DesktopApi、main、preload、IPC 与构建入口整合。正式页面由 `bootstrapDesktop` 加载 `dist/apps/desktop/renderer/index.html`，在 `file://` 下以文档内导航保持 IPC 来源 URL。无需启动 MUI、Vite 或 HTTP 服务，也不依赖原型目录、环境文件、真实数据或凭据。

`scripts/product/verify-renderer.ts` 已加入标准 npm 检查，验证打包模块、CSP、本地资源和常见隐私模式。临时真实 API 兼容工具及其联测数据已清理；后续真实接入通过正式 DesktopApi 配置，不能继承原型中的实验 TLS 设置。

Windows 桌面验收继续使用 `npm.cmd run test:windows:full`；实现细节与边界见各模块代码注释。
