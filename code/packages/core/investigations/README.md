# S07 · 调查应用用例

`tool-runner/` 已实现独立取证应用用例，公开入口 `@campussec/core/investigations/tools` 提供 `createInvestigationTools(deps)` 和 `createToolReplyAtomic()`；依赖注入使用现有预算、查询、案件和报告窄端口。retention、publication、completion 与请求生命周期/桌面装配仍待实现。

协调者持有事务，通过各所有者 InTx 保证原子性；实际发送未知保持 uncertain，不能提前释放材料或伪造报告校验输入。

接入方须使用 S09 已认证 evidence Actor 和可信 transportBindingId；在 analysis_runs 保存 FrozenRunInput/PreparedProfile 后调用。prepared_profile_json 仅为公开 PreparedProfile DTO，不能视为交付证明；目前背景引用必须经过 get_case_context 回复及 released 确认，未来宿主初始消息回执需由协调者接入。S09 实际发送后调用 acknowledgeReply，清理协调者在 S06 清理的同一事务调用 expireRepliesInTx。工具不决定终态，不启动监听或真实平台连接。
