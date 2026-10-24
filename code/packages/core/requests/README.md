# S07 · 请求与调度

A 负责。已实现独立原子预算组件 `budgets.ts`，通过 `@campussec/core/requests/budgets` 导出 createRunBudget；返回冻结契约的 RunBudgetPort/RunBudgetAtomicPort。依赖仅为 DatabasePort、ClockPort、IdPort，不调用宿主、MCP、案件、报告或投递。

它对工具/读取/平台请求/不同来源事件计数；校验身份、连接/工具代次、取消、过期和 recovery hold。工具与事件预占在调用者 WriteTx 内；网络请求额度通过独立短事务预占，已提交请求不退款，重新打开数据库不重置额度。只写 S07 的 tool_reservations、platform_attempts、run_event_keys。

fence 的只读聚合限于当前 analysis_runs/jobs/request 主体、space_metadata 与 connections.generation；不读取案件内容或第三方私有 Repository。预算不自行改变 JobState，取消与终态仍由未来 S07 协调器决定。

请求受理/调度、跨所有者工具用例、每日自动尝试/token 派发策略、留存、发布和完成协调尚未实现；依赖 B2/C2 等实际端口。不得把预算单组件通过写成整个 S07 完成。
