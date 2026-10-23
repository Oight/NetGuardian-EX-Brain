# S02 本地存储、事务与业务事件

工程契约版本：0.2.0；修订日期：2026-10-23。状态：新增实现设计，未实现/未联调；业务基线 v4.2。文末包含所需接口和完整 DDL，可单独交给实现 Agent。

## 1. 范围与代码

实现 `packages/storage/src/{database,migrations,events,space}.ts`。本应用在使用者电脑保存案件、证据和任务，只使用一个本地业务核心写 SQLite；S02 负责物理连接、事务、迁移、事件序号和主体空间隔离，不决定调查结论。

唯一导出端口为 `DatabasePort`、`EventPort`；驱动对象不泄露给 UI/MCP。各业务模块实现自己表的 Repository，使用同步 ReadTx/WriteTx 执行固定 SQL。SQL 只存在受信任核心源码，不接受模型或 UI 提交的 SQL。

## 2. 数据布局与初始化

```text
<Electron userData>/campussec/
  settings.json                  # 托盘等非秘密设置
  spaces/<spaceId>/state.sqlite   # 每个主体空间独立
  spaces/<spaceId>/exports/       # 仅用户明确导出的临时文件
  secrets/                       # 仅系统保护后的内容/不透明索引
```

spaceId 是核心创建的 UUID，由 `space_metadata` 验证 principalId/identityEpoch；不采用用户输入路径。切换身份由 S03 先停止受理、撤销旧工具、核实/标记旧任务、关闭旧库，再打开匹配空间；不在不同空间复用缓存、事件序号或句柄。跨电脑共享数据库不支持。

数据库驱动先验证 Electron 打包后的读写与 ABI，再冻结版本。连接设置：foreign_keys=ON、WAL、busy_timeout=5000ms、synchronous=FULL。只允许核心持有写连接；首轮 read 也串行执行，保证 snapshot 的序号与业务数据一致。不能把同步驱动扔进 Renderer。

初始化：创建父目录 → 打开数据库 → 验证空间元数据 → 校验既有迁移校验值 → 执行缺失迁移 → integrity_check/foreign_key_check → 发布 ready。已存在非空库不得重复执行初始化 DDL；迁移失败回滚并返回 STORAGE_UNAVAILABLE，保留原库，不删除重建。

## 3. 事务语义

`read` 在单一只读快照中运行同步回调；`write` 使用 BEGIN IMMEDIATE。回调返回 `{ok:false}` 或抛出异常都回滚；返回成功则提交。异常映射为安全错误，不把 SQL 参数原样写日志。禁止 Promise/thenable 回调结果，开发与生产都应拒绝，避免事务内外部 I/O。

跨模块原子用例示例：

```typescript
// 示例中的 repos/services 为注入对象，不是其他模块全局单例。
db.write(ctx, tx => {
  // 先完成所有 CAS/权限检查；任一步失败都返回错误并整笔回滚。
  const result = reports.finalizeInTx(tx, ctx, finalization);
  if (!result.ok) return result;
  if (bindingId) {
    const queued = deliveries.enqueueInTx(tx, ctx, { bindingId, result: result.value });
    if (!queued.ok) return queued;
  }
  return { ok: true, value: result.value };
});
```

事务之间的网络调用先持久化 intent，提交后执行，再开新事务写 observed。S02 不自动重跑包含外部副作用的业务回调。写队列串行；CAS `UPDATE ... WHERE id=? AND revision=?` 的 changes=0 返回 REVISION_CONFLICT。

## 4. 表的业务写所有者

| 所有者 | 表 |
|---|---|
| S02 | schema_migrations、space_metadata、domain_events、diagnostic_events |
| S03 | runtime_settings（非秘密设置，CAS更新） |
| S04 | connections、capabilities |
| S05 | alerts_inbox、watch_checkpoints、trigger_policies、auto_candidates、trigger_decisions、notifications |
| S06 | cases、case_changes、evidence_sources、evidence_versions、evidence_retrievals、evidence_links、business_context、context_versions、query_runs、query_pages、query_evidence、run_evidence、evidence_projections、cleanup_plans |
| S07 | investigation_requests、request_keys、request_events、deferred_inputs、jobs、analysis_runs、quota_ledger、tool_reservations、platform_attempts、run_event_keys、mcp_calls、investigation_steps |
| S08 | execution_attempts、origin_bindings |
| S09 | mcp_grants |
| S10 | report_drafts、reviews、followups、response_notes、result_packages |
| S11 | result_subscriptions、result_deliveries |

跨所有者写操作调用对方InTx方法。例：S05调用S06 captureInTx（无run预算）；S07封存调用S06 sealInTx，受理委派调用S11 subscribeInTx；S07先调用S10 finalize写结果，再调用S11 enqueue，二者同事务。InTx仅从约定核心端口入口导出，不能穿过IPC/MCP；不把Repository类作为公共接口。

## 5. DDL 与 Repository 映射

下方 DDL 是共同初始 schema；按 0001 初始迁移打包。DTO 的业务状态从关系列读出，不能同时另存一份完整 JSON 状态再任选其一。JSON 列只保存范围、材料、覆盖、不可变候选等结构；读取时也做 schema 验证。时间统一 UTC 毫秒文本，可比较；本地日期预算另外保存 time_zone/local_date。

关键约束：告警源身份唯一、请求幂等键唯一、逻辑查询每页唯一、工具 ordinal 唯一、一个 active job、每个 run 一个业务任务、结果版本唯一、投递键唯一。`uncertain` 默认占用活动槽位；用户明确放弃并撤销上下文后，由 S07 记录原因转换到 needs_review/failed 才释放。全应用仍由 S03 锁定一个活动空间，不靠每库索引跨空间互斥。

FK 不做 CASCADE，避免清理案件时误删历史证据。清理作为受控用例逐表执行：先检查活动轮次/引用，清除获准内容后保留失效引用标记；本轮 P0 可先提供留存配置与人工清理预览，不自动删正在使用内容。

## 6. 事件与恢复

appendInTx 使用 `domain_events.seq` 自增序号，返回实际插入值。事件和业务变更一起提交；通知只提示“可读取新事件”，丢失通知不会丢数据。read(afterSeq,limit) 按 seq 递增，limit<=200；清理使 afterSeq 早于保留起点时 resetRequired=true，返回空 events 和当前 lastSeq。

workspace.snapshot 必须在同一个 ReadTx 中读业务数据与 MAX(seq)，不能先后两次查询数据库。事件接口只对当前主体空间可见；事件payload按固定白名单，不保存平台正文。

崩溃恢复不会重做模型请求。S02 只保证已提交事务可读；S03/S07/S08/S11 决定 submitting、running、sending 等业务状态如何核实。诊断记录仅含 traceId、错误码、耗时和条数；控制字符转义并限长。

## 7. 独立验收与交接

使用临时数据库验证：迁移幂等与校验值冲突；FK 生效；重复源身份/幂等键/投递键拒绝；两个 active jobs 拒绝；CAS 竞争只成功一个；回调失败后业务行与事件都不存在；事务里意外返回 Promise 被拒绝；snapshot+seq 一致；空间不匹配无法读取；清理后的事件要求 reset。

交付数据库端口、迁移加载器、完整 DDL、表映射说明、临时库检查和打包后 smoke 命令。数据库文件、运行日志和秘密不进入仓库。已有迁移原件校验规则保持不变，本目录新增 schema 不是原件替换。

## 8. 装配入口与内嵌接口

固定导出`createStorage(deps)`，返回`Promise<Result<{db:DatabasePort;events:EventPort;close:()=>Promise<void>}>>`。deps字段固定为`dataDir:string,spaceId:Id,principalId:Id,identityEpoch:number,clock:ClockPort,ids:IdPort`；具体驱动放模块内部。close停止受理新读写，等待已提交操作后关闭连接，不删除数据库。

### 本轮存储边界补充

表归属以[architecture.json](architecture.json)为准。mcp_calls/investigation_steps现归S07，S09只写mcp_grants；保留表名避免不必要迁移。analysis_runs新增prepared_profile_json和completion_decision_json，由S07保存实际准备配置及决定，S06/S10不得直接查询该表。

WriteTx是同事务基础设施，不授予跨所有者写权限。产品工程须以包公开入口、私有Repository和依赖检查约束；明确定义的读取投影可以跨域汇总，禁止临时SQL穿透。现有设计检查尚不能证明未来源码遵守这些规则。

<!-- CONTRACT:BEGIN roots=DatabasePort,EventPort,ReadTx,WriteTx -->
```typescript
export type Id = string;

export const ENGINEERING_CONTRACT_VERSION = '0.2.0' as const;

export const WIRE_SCHEMA_VERSION = '0.1.0' as const;

export type Instant = string;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type JsonObject = { [key: string]: Json };

export type ErrorCode =
  | 'INVALID_INPUT' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND'
  | 'CONFLICT' | 'REVISION_CONFLICT' | 'NEEDS_INPUT' | 'QUEUE_FULL'
  | 'SCOPE_EXCEEDED' | 'CAPABILITY_UNAVAILABLE' | 'HOST_UNAVAILABLE'
  | 'BUDGET_EXHAUSTED' | 'EXPIRED' | 'CANCELLED' | 'UNCERTAIN'
  | 'UPSTREAM_AUTH' | 'UPSTREAM_DENIED' | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_UNAVAILABLE' | 'TLS_UNTRUSTED' | 'PARTIAL_RESULT'
  | 'CURSOR_INVALID' | 'RESULT_NOT_READY' | 'VALIDATION_FAILED' | 'SECRET_STORE_UNAVAILABLE'
  | 'IDENTITY_CHANGED' | 'STORAGE_UNAVAILABLE' | 'INTERNAL';

export interface AppError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: JsonObject;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

export interface Actor {
  spaceId: Id;
  principalId: Id;
  identityEpoch: number;
  role: 'ui' | 'system' | 'delegation' | 'evidence';
  originBindingId?: Id;
  runId?: Id;
}

export interface CallContext { actor: Actor; traceId: Id }

export interface ClockPort { now(): Instant; monotonicMs(): number }

export interface IdPort { next(): Id }

export const DEFAULT_LIMITS = {
  activeInvestigations: 1, queueCapacity: 20, maxRunAgents: 5, maxRunWindowMs: 3600000,
  requestTtlMs: 900000, autoQueueTtlMs: 900000, runTtlMs: 300000, queryTimeoutMs: 10000,
  toolCalls: 12, readCalls: 10, platformAttempts: 20, distinctEvents: 300, toolTextBytes: 16384,
  platformConcurrency: 2, pageSize: 50, maxPages: 4, watchIntervalMs: 10000,
  watchOverlapMs: 30000, recoveryWindowMs: 1800000, coalesceMs: 10000,
  candidateMaxSpanMs: 1800000, candidateIdleMs: 600000, autoDailyAttempts: 10,
  questionChars: 2000, noteChars: 8000, idempotencyChars: 128,
} as const;

export type SqlValue = string | number | null | Uint8Array;

export interface ReadTx {
  get<T>(sql: string, parameters?: readonly SqlValue[]): T | undefined;
  all<T>(sql: string, parameters?: readonly SqlValue[]): T[];
}

export interface WriteTx extends ReadTx {
  run(sql: string, parameters?: readonly SqlValue[]): { changes: number };
}

export interface DatabasePort {
  read<T>(ctx: CallContext, work: (tx: ReadTx) => T): Promise<Result<T>>;
  write<T>(ctx: CallContext, work: (tx: WriteTx) => Result<T>): Promise<Result<T>>;
}

export interface EvidenceRef { evidenceId: Id; version: number }

export interface ContextRef { contextId: Id; version: number }

export interface DeliveredRef extends EvidenceRef { projectionId: Id }

export type RequestState = 'awaiting_scope' | 'accepted' | 'rejected' | 'withdrawn';

export type JobState = 'coalescing' | 'queued' | 'preparing' | 'submitting' | 'running'
  | 'verifying' | 'succeeded' | 'needs_review' | 'failed'
  | 'cancel_requested' | 'cancelled' | 'uncertain';

export type StopReason = 'answered_with_limits' | 'evidence_unavailable' | 'budget_exhausted'
  | 'user_cancelled' | 'execution_failed' | 'scope_expansion_needed';

export interface ReportStatement { text: string; evidenceRefs: DeliveredRef[]; queryIds: Id[]; contextRefs: ContextRef[] }

export interface FollowupDraft { question: string; suggestedAction: string; responsibleRole?: string }

export interface ReportCandidate {
  caseId: Id; runId: Id; question: string;
  facts: ReportStatement[]; analysis: ReportStatement[]; conflicts: ReportStatement[];
  gaps: string[]; classification: 'needs_investigation' | 'explained' | 'insufficient_evidence';
  stopReason: StopReason; followups: FollowupDraft[];
}

export interface ReportRecord {
  id: Id; caseId: Id; runId: Id; version: number; baseRevision: number;
  candidate: ReportCandidate; validation: 'valid' | 'invalid' | 'needs_review';
  review: 'unreviewed' | 'accepted' | 'revised' | 'rejected';
  validationIssues: string[]; createdAt: Instant;
}

export type DeliveryState = 'pending' | 'sending' | 'delivered' | 'uncertain' | 'retryable_failed' | 'blocked';

export interface EventPayloadMap {
  'connection.changed': { connectionId: Id; generation: number };
  'alerts.received': { connectionId: Id; alertIds: Id[]; receiveSeq: number };
  'policy.changed': { policyId: Id; epoch: number; enabled: boolean };
  'case.changed': { caseId: Id; revision: number; reason: string };
  'request.changed': { requestId: Id; state: RequestState };
  'job.changed': { jobId: Id; runId?: Id; state: JobState; revision: number };
  'investigation.step': { runId: Id; stepId: Id; summary: string };
  'report.changed': { reportId: Id; caseId: Id; review: ReportRecord['review'] };
  'delivery.changed': { deliveryId: Id; requestId: Id; state: DeliveryState };
  'runtime.changed': { state: 'ready' | 'degraded' | 'stopping' };
}

export type DomainEvent = { [K in keyof EventPayloadMap]: {
  seq: number; type: K; spaceId: Id; aggregateId: Id; revision: number;
  occurredAt: Instant; traceId: Id; payload: EventPayloadMap[K];
} }[keyof EventPayloadMap];

export interface EventPort {
  appendInTx<K extends keyof EventPayloadMap>(tx: WriteTx, ctx: CallContext,
    input: { type: K; aggregateId: Id; revision: number; payload: EventPayloadMap[K] }): number;
  read(ctx: CallContext, input: { afterSeq: number; limit: number }): Promise<Result<{ events: DomainEvent[]; lastSeq: number; resetRequired: boolean }>>;
}
```
<!-- CONTRACT:END -->

## 9. 内嵌初始 DDL

<!-- SQL:BEGIN -->
```sql
-- 设计附件 0.2.0（2026-10-23）；每个主体空间独立数据库；仅核心进程可打开写连接。
-- JSON 列由运行时 schema 校验；业务状态以关系列为准。
PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
CREATE TABLE space_metadata(space_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, identity_epoch INTEGER NOT NULL CHECK(identity_epoch>0));
CREATE TABLE runtime_settings(key TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0), value_json TEXT NOT NULL);
CREATE TABLE connections(
  id TEXT PRIMARY KEY, platform_instance_id TEXT NOT NULL, display_name TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>0), indexer_base_url TEXT, server_base_url TEXT,
  indexer_secret_ref TEXT, server_secret_ref TEXT, ca_ref TEXT,
  alerts_pattern TEXT NOT NULL, archives_pattern TEXT, mapping_version TEXT NOT NULL,
  principal_fingerprint TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE capabilities(
  connection_id TEXT NOT NULL REFERENCES connections(id), name TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('available','denied','unreachable','unsupported','unverified')),
  checked_at TEXT NOT NULL, evidence TEXT NOT NULL, endpoint_kind TEXT NOT NULL,
  PRIMARY KEY(connection_id,name)
);
CREATE TABLE cases(
  id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0), title TEXT NOT NULL,
  connection_id TEXT NOT NULL REFERENCES connections(id), scope_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','investigating','resolved','reopened')),
  current_report_id TEXT, latest_report_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE case_changes(
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), revision INTEGER NOT NULL,
  reason TEXT NOT NULL, actor_id TEXT NOT NULL, change_json TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(case_id,revision)
);
CREATE TABLE evidence_sources(
  source_key TEXT PRIMARY KEY, evidence_id TEXT NOT NULL UNIQUE,
  connection_id TEXT NOT NULL REFERENCES connections(id), locator_json TEXT NOT NULL
);
CREATE TABLE evidence_versions(
  evidence_id TEXT NOT NULL REFERENCES evidence_sources(evidence_id), version INTEGER NOT NULL CHECK(version>0),
  kind TEXT NOT NULL, observed_at TEXT, time_quality TEXT NOT NULL,
  retrieved_at TEXT NOT NULL, content_hash TEXT NOT NULL, fields_json TEXT NOT NULL,
  availability TEXT NOT NULL DEFAULT 'available' CHECK(availability IN ('available','expired')),
  PRIMARY KEY(evidence_id,version)
);
CREATE TABLE evidence_retrievals(
  id TEXT PRIMARY KEY, evidence_id TEXT NOT NULL, version INTEGER NOT NULL, retrieved_at TEXT NOT NULL,
  query_id TEXT, FOREIGN KEY(evidence_id,version) REFERENCES evidence_versions(evidence_id,version)
);
CREATE TABLE evidence_links(
  case_id TEXT NOT NULL REFERENCES cases(id), evidence_id TEXT NOT NULL, evidence_version INTEGER NOT NULL,
  attached_revision INTEGER NOT NULL, removed_revision INTEGER,
  PRIMARY KEY(case_id,evidence_id,evidence_version),
  FOREIGN KEY(evidence_id,evidence_version) REFERENCES evidence_versions(evidence_id,version)
);
CREATE TABLE business_context(
  id TEXT PRIMARY KEY, case_id TEXT REFERENCES cases(id), connection_id TEXT NOT NULL REFERENCES connections(id),
  latest_version INTEGER NOT NULL
);
CREATE TABLE context_versions(
  context_id TEXT NOT NULL REFERENCES business_context(id), version INTEGER NOT NULL,
  agent_ids_json TEXT NOT NULL, text TEXT NOT NULL, department TEXT, purpose TEXT,
  valid_from TEXT NOT NULL, valid_to TEXT NOT NULL, source_label TEXT NOT NULL,
  verification TEXT NOT NULL CHECK(verification IN ('unverified','verified','rejected')), author_id TEXT NOT NULL,
  PRIMARY KEY(context_id,version)
);
CREATE TABLE query_runs(
  id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections(id), run_id TEXT, case_id TEXT REFERENCES cases(id),
  query_json TEXT NOT NULL, coverage_json TEXT NOT NULL, status TEXT NOT NULL,
  sealed INTEGER NOT NULL DEFAULT 0 CHECK(sealed IN (0,1)), created_at TEXT NOT NULL
);
CREATE TABLE query_pages(
  page_id TEXT PRIMARY KEY, query_id TEXT NOT NULL REFERENCES query_runs(id), page_ordinal INTEGER NOT NULL,
  content_hash TEXT NOT NULL, coverage_json TEXT NOT NULL, next_cursor_ref TEXT,
  UNIQUE(query_id,page_ordinal)
);
CREATE TABLE query_evidence(
  query_id TEXT NOT NULL REFERENCES query_runs(id), evidence_id TEXT NOT NULL, evidence_version INTEGER NOT NULL,
  PRIMARY KEY(query_id,evidence_id,evidence_version),
  FOREIGN KEY(evidence_id,evidence_version) REFERENCES evidence_versions(evidence_id,version)
);
CREATE TABLE alerts_inbox(
  id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections(id), source_key TEXT NOT NULL,
  receive_seq INTEGER NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('realtime','history','recovery')),
  evidence_id TEXT NOT NULL, evidence_version INTEGER NOT NULL, agent_id TEXT, rule_id TEXT,
  rule_groups_json TEXT NOT NULL, level INTEGER, observed_at TEXT, received_at TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0, decision_reason TEXT NOT NULL,
  UNIQUE(connection_id,source_key),
  FOREIGN KEY(evidence_id,evidence_version) REFERENCES evidence_versions(evidence_id,version)
);
CREATE TABLE watch_checkpoints(
  connection_id TEXT PRIMARY KEY REFERENCES connections(id), completed_upper TEXT,
  receive_seq INTEGER NOT NULL, state TEXT NOT NULL, gap_json TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE trigger_policies(
  id TEXT PRIMARY KEY, connection_id TEXT NOT NULL UNIQUE REFERENCES connections(id), revision INTEGER NOT NULL,
  epoch INTEGER NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  enabled_after_receive_seq INTEGER NOT NULL, policy_json TEXT NOT NULL
);
CREATE TABLE auto_candidates(
  id TEXT PRIMARY KEY, policy_id TEXT NOT NULL REFERENCES trigger_policies(id), policy_epoch INTEGER NOT NULL,
  case_id TEXT NOT NULL REFERENCES cases(id), group_key TEXT NOT NULL, first_received_at TEXT NOT NULL,
  last_received_at TEXT NOT NULL, coalesce_until TEXT NOT NULL, expires_at TEXT NOT NULL,
  state TEXT NOT NULL, candidate_json TEXT NOT NULL
);
CREATE INDEX idx_candidate_group ON auto_candidates(policy_id,policy_epoch,group_key,last_received_at);
CREATE TABLE trigger_decisions(
  id TEXT PRIMARY KEY, alert_id TEXT NOT NULL REFERENCES alerts_inbox(id), policy_id TEXT,
  policy_epoch INTEGER NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL,
  candidate_id TEXT REFERENCES auto_candidates(id), created_at TEXT NOT NULL,
  UNIQUE(alert_id,policy_epoch)
);
CREATE TABLE notifications(
  id TEXT PRIMARY KEY, notification_key TEXT NOT NULL UNIQUE, alert_ids_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','shown','uncertain','muted')), created_at TEXT NOT NULL
);
CREATE TABLE origin_bindings(
  id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, host_id TEXT NOT NULL, host_account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, request_message_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','revoked','expired')), created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE investigation_requests(
  id TEXT PRIMARY KEY, origin TEXT NOT NULL CHECK(origin IN ('alert_auto','client_user','teleagent_user')),
  state TEXT NOT NULL CHECK(state IN ('awaiting_scope','accepted','rejected','withdrawn')),
  principal_id TEXT NOT NULL, connection_id TEXT NOT NULL REFERENCES connections(id), question TEXT NOT NULL,
  requested_scope_json TEXT, effective_scope_json TEXT, seed_refs_json TEXT NOT NULL,
  case_id TEXT REFERENCES cases(id), job_id TEXT, origin_binding_id TEXT REFERENCES origin_bindings(id),
  auto_candidate_id TEXT REFERENCES auto_candidates(id), missing_fields_json TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE request_keys(
  principal_id TEXT NOT NULL, origin_key TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL, request_id TEXT NOT NULL REFERENCES investigation_requests(id),
  PRIMARY KEY(principal_id,origin_key,idempotency_key)
);
CREATE TABLE request_events(
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES investigation_requests(id),
  event_type TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE deferred_inputs(
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES investigation_requests(id),
  input_key TEXT NOT NULL, text TEXT NOT NULL, consumed_by_request_id TEXT REFERENCES investigation_requests(id),
  created_at TEXT NOT NULL, UNIQUE(request_id,input_key)
);
CREATE TABLE result_subscriptions(
  request_id TEXT NOT NULL REFERENCES investigation_requests(id), binding_id TEXT NOT NULL REFERENCES origin_bindings(id),
  can_cancel INTEGER NOT NULL CHECK(can_cancel IN (0,1)), state TEXT NOT NULL,
  PRIMARY KEY(request_id,binding_id)
);
CREATE TABLE jobs(
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES investigation_requests(id),
  case_id TEXT NOT NULL REFERENCES cases(id), run_id TEXT UNIQUE,
  origin TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN (
    'coalescing','queued','preparing','submitting','running','verifying','succeeded',
    'needs_review','failed','cancel_requested','cancelled','uncertain')),
  revision INTEGER NOT NULL, recovery_hold INTEGER NOT NULL DEFAULT 0 CHECK(recovery_hold IN (0,1)),
  policy_id TEXT REFERENCES trigger_policies(id), policy_epoch INTEGER,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error_json TEXT
);
CREATE UNIQUE INDEX uq_one_active_job ON jobs((1)) WHERE state IN ('preparing','submitting','running','verifying','cancel_requested','uncertain');
CREATE INDEX idx_jobs_queue ON jobs(state,origin,created_at);
CREATE TABLE analysis_runs(
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id), case_id TEXT NOT NULL REFERENCES cases(id),
  base_revision INTEGER NOT NULL, scope_json TEXT NOT NULL, connection_generation INTEGER NOT NULL,
  identity_epoch INTEGER NOT NULL, profile_version TEXT NOT NULL, tool_epoch INTEGER NOT NULL,
  expires_at TEXT NOT NULL, initial_input_json TEXT NOT NULL, prepared_profile_json TEXT,
  completion_decision_json TEXT, manifest_hash TEXT, sealed_at TEXT
);
CREATE TABLE run_evidence(
  run_id TEXT NOT NULL REFERENCES analysis_runs(id), evidence_id TEXT NOT NULL, evidence_version INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('seed','tool')), PRIMARY KEY(run_id,evidence_id,evidence_version),
  FOREIGN KEY(evidence_id,evidence_version) REFERENCES evidence_versions(evidence_id,version)
);
CREATE TABLE evidence_projections(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES analysis_runs(id), evidence_id TEXT NOT NULL,
  evidence_version INTEGER NOT NULL, content_json TEXT NOT NULL, content_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','released','uncertain')), prepared_at TEXT NOT NULL, released_at TEXT,
  availability TEXT NOT NULL DEFAULT 'available' CHECK(availability IN ('available','expired')),
  FOREIGN KEY(evidence_id,evidence_version) REFERENCES evidence_versions(evidence_id,version)
);
CREATE TABLE run_event_keys(
  run_id TEXT NOT NULL REFERENCES analysis_runs(id), source_key TEXT NOT NULL, PRIMARY KEY(run_id,source_key)
);
CREATE TABLE quota_ledger(
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), run_id TEXT REFERENCES analysis_runs(id),
  connection_id TEXT NOT NULL REFERENCES connections(id), origin TEXT NOT NULL, local_date TEXT NOT NULL,
  time_zone TEXT NOT NULL, attempt INTEGER NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL,
  usage_json TEXT, created_at TEXT NOT NULL, UNIQUE(job_id,attempt,kind)
);
CREATE TABLE tool_reservations(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES analysis_runs(id), tool_name TEXT NOT NULL,
  tool_ordinal INTEGER NOT NULL, is_read INTEGER NOT NULL, expires_at TEXT NOT NULL,
  tool_epoch INTEGER NOT NULL, identity_epoch INTEGER NOT NULL, connection_generation INTEGER NOT NULL,
  UNIQUE(run_id,tool_ordinal)
);
CREATE TABLE platform_attempts(
  id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL REFERENCES tool_reservations(id),
  run_id TEXT NOT NULL REFERENCES analysis_runs(id), attempted_at TEXT NOT NULL
);
CREATE TABLE execution_attempts(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES analysis_runs(id), attempt INTEGER NOT NULL,
  operation TEXT NOT NULL, phase TEXT NOT NULL, host_identity_json TEXT NOT NULL,
  session_id TEXT, user_message_id TEXT, result_message_id TEXT, snapshot_json TEXT,
  intent_at TEXT NOT NULL, observed_at TEXT, UNIQUE(run_id,attempt,operation)
);
CREATE TABLE mcp_grants(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES analysis_runs(id), role TEXT NOT NULL,
  token_digest TEXT NOT NULL UNIQUE, secret_ref TEXT NOT NULL, tool_epoch INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','active','revoked')), binding_json TEXT,
  expires_at TEXT NOT NULL
);
CREATE TABLE mcp_calls(
  id TEXT PRIMARY KEY, transport_binding_id TEXT NOT NULL, call_id TEXT NOT NULL,
  argument_hash TEXT NOT NULL, tool_name TEXT NOT NULL, run_id TEXT REFERENCES analysis_runs(id),
  reservation_id TEXT REFERENCES tool_reservations(id), state TEXT NOT NULL,
  reply_json TEXT, projection_ids_json TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(transport_binding_id,call_id)
);
CREATE TABLE investigation_steps(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES analysis_runs(id),
  phase TEXT NOT NULL, summary TEXT NOT NULL, purpose TEXT, evidence_refs_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE report_drafts(
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), run_id TEXT NOT NULL REFERENCES analysis_runs(id),
  version INTEGER NOT NULL, base_revision INTEGER NOT NULL, candidate_json TEXT NOT NULL,
  validation TEXT NOT NULL CHECK(validation IN ('valid','invalid','needs_review')),
  review TEXT NOT NULL CHECK(review IN ('unreviewed','accepted','revised','rejected')),
  validation_issues_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id,version)
);
CREATE TABLE reviews(
  id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES report_drafts(id), case_revision INTEGER NOT NULL,
  disposition TEXT NOT NULL, human_conclusion TEXT NOT NULL, note TEXT NOT NULL,
  revised_report_id TEXT REFERENCES report_drafts(id), author_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE followups(
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), report_id TEXT REFERENCES report_drafts(id),
  revision INTEGER NOT NULL, question TEXT NOT NULL, suggested_action TEXT NOT NULL, responsible_role TEXT,
  state TEXT NOT NULL CHECK(state IN ('open','waiting','completed')), due_at TEXT, note TEXT,
  evidence_refs_json TEXT NOT NULL
);
CREATE TABLE response_notes(
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), followup_id TEXT REFERENCES followups(id),
  source TEXT NOT NULL CHECK(source IN ('human_statement','observed')), text TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL, author_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE result_packages(
  request_id TEXT NOT NULL REFERENCES investigation_requests(id), run_id TEXT REFERENCES analysis_runs(id),
  result_version INTEGER NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(request_id,result_version)
);
CREATE TABLE result_deliveries(
  id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES origin_bindings(id),
  request_id TEXT NOT NULL, run_id TEXT, result_version INTEGER NOT NULL,
  delivery_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('pending','sending','delivered','uncertain','retryable_failed','blocked')),
  attempts INTEGER NOT NULL, receipt_json TEXT, last_error_json TEXT, next_attempt_at TEXT,
  FOREIGN KEY(request_id,result_version) REFERENCES result_packages(request_id,result_version)
);
CREATE TABLE domain_events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
  revision INTEGER NOT NULL, trace_id TEXT NOT NULL, occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL
);
CREATE INDEX idx_events_aggregate ON domain_events(aggregate_id,seq);
CREATE TABLE diagnostic_events(
  id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, code TEXT NOT NULL, safe_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE cleanup_plans(
  id TEXT PRIMARY KEY, plan_hash TEXT NOT NULL, plan_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('preview','applied','expired')), expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
```
<!-- SQL:END -->
