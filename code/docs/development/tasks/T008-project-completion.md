# T008 · 全项目实现审计与补全

状态：in_progress。用户取消旧分工限制，授权串行跨目录严格核验并修复完整项目。

- 实际 base：28c5185；分支 task/project-completion-audit；执行者 Codex。
- 范围：code/ 的全部产品模块、测试、锁、装配、renderer、Electron 与构建工具；根工作流、项目说明与必要设计一致性记录。保留 .idea/ 和个人数据，不运行历史研究脚本。
- 依据：业务 v4.2，内部契约 0.2.0、外部信封 0.1.0；候选提案不自动扩大范围。
- 检查：npm run check、check:clean、test:electron、两个设计 Python 检查；新增真实模块组合与故障/竞态测试，不以 fake 或空成功替代业务验收。
- 外部范围：公开依赖/官方 Electron 的下载与本地隔离合成 GUI 验证。真实模型/宿主/Wazuh/额度操作需可核实的接口资料与当次授权，未执行项不得写成通过。

## 首轮实际发现

- 标准类型检查失败：报告/工具/Profile 缺少公开包出口或 workspace 登记，源码存在不等于可运行。
- S05、S08、S09 gateway、S11 无实现；S07 只有预算和工具用例，没有请求生命周期/终态协调。
- 生产 compose 只接案件/Wazuh；报告和工具实现未接生产入口。UI 页面存在不代表功能已打通。
- 完整 P0 与 M0—M4 未完成；后续逐模块记录实际代码、检查和剩余限制。


## 机器可读的当前交接

```json
{
  "task": "T008",
  "status": "in_progress",
  "branch": "task/project-completion-audit",
  "base": "28c5185",
  "implementation": "local_services_and_synthetic_flow_implemented",
  "automated_checks": "passed",
  "clean_copy_tests": 232,
  "live_teleagent": "unverified_adapter_missing",
  "live_wazuh": "not_run",
  "electron": "failed_environment",
  "distribution": "not_built",
  "merged_to_main": false
}
```

本轮新增或补全 S05、S07、S08 本地执行/宿主边界、S09 HTTP 网关与 schema 目录、S11 和生产装配；修复公开出口、workspace、冻结哈希、案件附案、预算/期限/取消/投递问题。代码位置、组合测试、全部结果与真实接入缺口统一见[全项目核验](../../verification/project-audit-2026-10-24.md)。不以 Node 测试通过替代真实宿主、Electron 或安装包验收。

下一位 agent 从本分支继续，先复核该报告的剩余项；不要按旧四线任务表把模块整体标记为完成。禁止读取个人宿主会话或凭据来猜接口，未经当次授权不运行真实模型/平台测试。
