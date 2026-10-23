# 子系统工程设计包

工程契约 **0.2.0**；修订日期2026-10-23；业务基线仍为[v4.2](../current/security-triage-client-design-v4.md)，外部Desktop/MCP/导出信封仍0.1.0。当前是实现设计，尚无产品workspace/安装包/真实闭环。

本轮按耦合评审修订内部职责与装配，详见[修订记录](changes-0.2.0.md)、[边界说明](boundaries.md)。保留12个逻辑子系统、一个本地核心、一个SQLite写入者；不增加服务数量或新业务范围。

## 1. 模块与端口

| ID | 文档 | 代码归属 | 主要出口 |
|---|---|---|---|
| S01 | [公共契约](01-contracts.md) | packages/contracts | DTO、runtime schema、错误与限制 |
| S02 | [存储与事件](02-storage.md) | packages/storage | DatabasePort、EventPort |
| S03 | [桌面宿主](03-desktop-runtime.md) | apps/desktop/main、preload、runtime | SecretPort、Facade、装配/恢复/打包 |
| S04 | [Wazuh适配](04-wazuh.md) | packages/wazuh-adapter | ConnectionService及查询/读取窄视图 |
| S05 | [告警与提醒](05-alerts.md) | packages/core/alerts | AlertService |
| S06 | [案件与证据](06-cases-evidence.md) | packages/core/cases | CaseService、CaseAtomicPort，无预算/MCP回调 |
| S07 | [请求与调查用例](07-requests-scheduler.md) | packages/core/requests、investigations | 请求、预算、工具、留存、发布与终态协调 |
| S08 | [宿主与执行](08-teleagent.md) | packages/teleagent-bridge | ExecutionPort、来源/投递窄端口 |
| S09 | [通道与MCP入口](09-mcp.md) | packages/mcp-server/channels、gateway | 独立EvidenceChannelPort、薄McpGatewayPort |
| S10 | [配置与报告](10-investigation-reports.md) | packages/investigation-profile、core/reports | 配置/提案/完成窄端口；不决定执行终态 |
| S11 | [结果投递](11-delivery.md) | packages/core/delivery | DeliveryService、SubscriptionAtomicPort |
| S12 | [界面](12-workbench.md) | apps/desktop/renderer | DesktopApi消费者 |

权威附件：[contracts.ts](contracts.ts)、[schema.sql](schema.sql)、[组件/表归属](architecture.json)、[合成向量](contract-vectors.json)。模块内嵌块由同一来源同步，SQL附件中的外键依赖不授予写所有权。

## 2. 依赖与装配

下层证据/报告不回调上层调度；S09通道组件不回调工具路由。先构造基础设施和通道，再构造宿主/执行、证据/报告/投递、S07预算与应用用例，最后装配S09入口和Facade。详见[集成设计](integration.md)。

UI与MCP复用同一应用用例，关键事务由协调者调用各所有者InTx，外部请求在事务外。事件用于观察/UI同步，不替代原子写。S07唯一决定任务终态，S08规范化执行事实，S10校验草案，S11独立维护投递。

## 3. 已确定与保留项

首轮Electron Main装配核心，核心不import Electron；独立Node业务进程仍候选。UI建议React/TypeScript/Vite，驱动/SDK/实际版本待安装包小验证锁定。只适配冻结Wazuh，不部署或改造上游。

调查档案图、自动差异解释和局部重查仍非P0。宿主能力逐项available/unavailable/unverified，默认未验证关闭。本文的端口定义不证明宿主有相应API。

## 4. 独立开发前提

单模块文档说明实现行为，但任务还必须具备固定base、实际contracts与共享fake/testkit、可运行检查和路径授权。先读[Agent协作规范](../development/README.md)与[准备清单](../development/readiness.md)，不能把文档详细等同于12模块可全面并行。

依赖用共享fake，不复制其他模块业务；交付代码、独有风险检查、合成夹具、运行说明、依赖记录和未通过项。真实模型/平台试验按当次授权，不继承历史实验权限。

## 5. 一致性维护

```powershell
python scripts/design/verify_subsystem_designs.py --sync
python scripts/design/verify_subsystem_designs.py --node-syntax
python scripts/design/verify_development_docs.py
```

sync只由集中契约任务运行，CI只核验不修复。第三条检查规范链接、组件DAG、表所有者和关键接口边界；不检查不存在的产品源码。Node仅语法，不能当作tsc或打包通过。[核验记录](verification.md)区分所有证明范围。
