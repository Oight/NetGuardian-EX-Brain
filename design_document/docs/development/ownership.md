# 文件与模块修改归属

日期：2026-10-23；协作规范版本0.2。归属用于任务分派与审查，不构成Git写入锁。每条可写路径同一时刻只有一个任务；每任务明确当次完成者，不设长期专人；GitHub账号接入时再填写，本文不虚构成员。[组件/表清单](../implementation/architecture.json)。

| 归属 | 产品代码路径 | 负责修改 |
|---|---|---|
| S01契约任务 | packages/contracts | 类型/schema/默认限制/规范序列化 |
| S02存储任务 | packages/storage | 驱动、迁移、事件、物理DDL |
| S03集成任务 | apps/desktop/main、preload、runtime | 组合入口、秘密、有限IPC、恢复/打包 |
| S04 | packages/wazuh-adapter | Wazuh认证/映射/分页/能力 |
| S05 | packages/core/alerts | 轮询/收件箱/候选/提醒 |
| S06 | packages/core/cases | 案件/证据/背景/投影/清理原语 |
| S07预算组件 | packages/core/requests/budgets | 原子预算与run fence |
| S07请求组件 | packages/core/requests（其余文件） | 请求/状态/队列/恢复 |
| S07调查用例 | packages/core/investigations | 取证工具/缓存/步骤/留存/发布/完成协调 |
| S08 | packages/teleagent-bridge | 宿主接入、wire、执行、来源和投递原语 |
| S09通道组件 | packages/mcp-server/channels | grant和可信通道绑定 |
| S09入口 | packages/mcp-server/gateway | 传输/认证接入/角色路由 |
| S10 | packages/investigation-profile、packages/core/reports | 配置/草案/核查/导出 |
| S11 | packages/core/delivery | 订阅/outbox/worker/回执 |
| S12 | apps/desktop/renderer | UI/typed client/局部表单 |

S07拆分任务须列精确文件，目录前缀重叠时不能同时授权；模块测试/夹具路径也列入任务单。表的业务写所有者与物理DDL维护者不同：S02集中迁移，不替业务模块决定状态。

## 共享文件

根package.json、锁、tsconfig、公共测试工具、CI、runtime装配、契约原文、schema原文、architecture.json、任务模板和根AGENTS由当次明确的唯一任务集中处理。模块Agent不在自己的提交夹带共享修改；需要时先提交具体差异与影响。

任务授权可以明确包括跨模块修复，由集成角色协调已有任务后进行。此规则不要求所有小改动都让用户逐条批准，也不能成为停止已授权工作的借口。

## 归档边界

archive/sources/design、research/teleagent迁入原件、migration/manifest.jsonl和凭据校验不随产品开发重写。设计与开发规范是可维护工作副本，变化记修订日期和验证范围。

## 本轮四人工作线映射

分支入口及具体可写路径以[任务登记](tasks/README.md)链接的任务文件为准；本节不维护任务状态。

| 工作线 | 子系统 | 本轮共享职责 |
|---|---|---|
| A / T002 | S01、S03、S07 | 根配置、锁、公共 contracts/testkit、装配、产品 CI；契约设计同步单独串行处理 |
| B / T003 | S02、S05、S06、S10 | 物理 DDL 和迁移唯一写者；其他模块提供迁移需求 |
| C / T004 | S04、S08、S09、S11 | 上游与宿主适配、角色通道、投递；不修改装配和根锁 |
| D / T005 | S12 | renderer 和 tests/acceptance；不修改业务模块与公共 fake |

所有线只能更新自己的任务文件；共享导航/规范变更由当次串行文档任务处理，阶段放行与依赖 commit 记录在消费者自己的文件。现有设计原文默认只读；变更前明确消费者和兼容影响，不因模块归属自动授权改变业务基线。
