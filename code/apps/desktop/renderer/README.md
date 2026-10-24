# S12 · 本地案件工作台

D 线实现；固定导出 `mountWorkbench({element,api: DesktopApi}): {unmount()}`，生产传 window.campusSec。无 React/Vite 运行时依赖，使用标准 TypeScript、浏览器 DOM 和 ES modules；不引入 Node/Electron/SQLite 特权。

本轮完成案件列表/筛选/分页、无告警建案、详情、观测材料读取、查询覆盖、人工背景新增/版本修改、状态变更与理由、双版本移动证据、连接离线保存、运行设置和宿主能力状态。业务数据保存在主进程真实服务和数据库，页面不维护第二套业务状态机。

表单有 pending/error/success；REVISION_CONFLICT 保留输入并提示重新读取，背景默认 unverified；UTC 半开范围和时区明确。调查请求只发送 client_user，未接入宿主/编排时展示明确错误并保留问题和重试业务键。报告历史按服务响应展示；告警、核查导航在模块未装配时明确报错，不显示虚构零数据。

事件每秒有界读取，不在无新增时重绘列表；详情有新 revision 时保留表单，resetRequired 重新读取，身份空间变化清空旧数据；unmount 清理计时器与页面内存，不自动取消后端业务任务。正文使用 textContent/pre，不执行 HTML。

仍待对应阶段：完整告警交互、调查步骤/轮次/投影引用、审核/导出、清理预览/应用、恢复与投递 UI。这些不算 D1/D3 全部完成。

本机合成浏览器验收：先 `bun scripts/product/build.ts`，再 `bun scripts/local/preview-workbench.ts`。该独立工具使用临时真实 SQLite 与标明的测试桥接，禁止真实平台请求，测试 CSP 仅允许同源测试桥接；生产 CSP 仍禁止网络。浏览器环境不等于 Electron 验收。

Windows 开发者运行 `npm.cmd run test:windows:full`，其中真实 Electron 验收通过生产页面创建/保存、验证冲突并启动第二进程回读。
