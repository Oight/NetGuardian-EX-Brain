# S07 · 请求与调度

service.ts 实现请求幂等、范围补充、队列/单活动槽、冻结准备、执行观测、取消、未知核实、重启 hold、每日持久额度以及跨 S06/S10/S11 的完成事务。budgets.ts 保留独立工具/读取/平台/事件预算，实际工具用例在 investigations/tool-runner，留存与人工发布协调在 investigations/retention.ts 和 publication.ts。

请求 TTL 与从 preparing 起的 run TTL 独立；未知执行不重新提交，自动核实最多三次，持久保存计数；只有实际观测取消才可写 cancelled。预算失败不撤销此前已消耗额度。

生产装配、原子失败、重启和真实 HTTP 工具链的合成测试见 tests/acceptance（产品根目录）。真实 TeleAgent 接入未放行，不能将这些结果写作完整真实 S07 调查验收。
