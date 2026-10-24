# 安全调查工作台

入口 mountWorkbench({element, api: DesktopApi})，使用标准 TypeScript/DOM 和本地 ES modules。11 个页面覆盖概览、告警、案件、任务、设备、背景、核查、报告、连接、接入状态和设置，未装配能力明确报错。

本次补充策略回读、案件分页调查历史、冻结输入与投影/查询浏览，以及投递显式核实恢复。业务状态由服务读取，事件和最近 20 项摘要不能替代完整历史。默认装配已有案件/背景/报告；完整请求、告警和宿主投递仍待实现。

正式入口由 Electron bootstrap 加载 dist 中本地页面，renderer 无 Node.js 权限；本机仅做 Bun 静态/逻辑和独立浏览器合成验收。scripts/local/preview-workbench.ts 提供 /qa/ 与明确标注的 /showcase/，不进入产品构建。实际结果见[验证记录](../../../docs/verification/maintenance-2026-10-24.md)。
