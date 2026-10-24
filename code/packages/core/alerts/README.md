# S05 · 告警与提醒

index.ts 实现固定上界轮询、来源去重、真实 S06 证据采集、收件箱/通知意图、策略 CAS/epoch、候选窗口与原子派发。首次历史、重启补收、失败后恢复不自动调查；缺身份的材料不合并为共享主体。原生通知提供者由 Electron main 注入。

模块测试在 tests/alerts.test.ts，生产 S04/S06/S07 合成组合见产品 tests/acceptance/automatic-flow.test.ts。真实平台持续性、迟到数据回放和 Windows 通知可见性尚未验收；查询缺口仍保留，不声明持续无遗漏。
