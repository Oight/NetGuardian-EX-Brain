# S11 结果订阅、原对话投递与回执恢复

工程契约版本：0.2.0；修订日期：2026-10-23。状态：新增实现设计，真实宿主异步回传尚无通过证据。本文含独立端口和恢复规则。

## 1. 范围与目录

实现 `packages/core/delivery/{subscriptions,outbox,worker,results,repositories}.ts`，导出DeliveryService与内部SubscriptionAtomicPort。结果在客户端始终可见，发起TeleAgent对话还应收到对应调查响应；调查执行与结果投递是两个独立状态机。

依赖HostDeliveryPort、ResultPackageReadPort、DatabasePort/EventPort、ClockPort/IdPort。不依赖ExecutionPort，不创建模型轮次或查询Wazuh。拥有result_subscriptions/result_deliveries；结果通过S10只读端口取得，绑定状态通过HostDeliveryPort.binding取得，不能直接读写对方私表。

## 2. 来源绑定和订阅权限

绑定必须来自S08.resolveOrigin的可信宿主/账号/工作区/会话/请求消息。subscribeInTx在S07受理请求的同一事务保存；原请求发起来源canCancel=true，后续等价任务订阅者canCancel=false。订阅授权不能扩大案件或数据范围。

getResult/status检查当前Actor：UI可读本主体授权请求；委派角色必须持有同binding的active订阅；取证角色不可读来源投递状态。知道requestId/sessionId不是权限。来源账号切换、会话撤销、绑定过期时停止投递，保留本地结果。

普通订阅者cancel只把自己的subscription设withdrawn，不更改共享request/job；本次回执subscriptionCancelled=true，后续读取被拒绝。请求所有者明确cancel进入S07的统一取消流程。

## 3. 结果版本与同事务排队

ResultPackage包含请求/任务/案件、可选runId、resultVersion、终态、审核、摘要、依据/缺口/核查和覆盖。未启动任务省略runId。getResult先检查UI主体或委派订阅再调用只读结果端口，缺结果返回RESULT_NOT_READY；状态另查S07 status，不在投递模块反向查询任务。

S07完成时在同一个WriteTx调用S10.finalizeInTx与S11.enqueueInTx；任何一个失败整笔回滚。enqueue对全部有效订阅分别创建delivery，结果包已由S10写入。UI入口没有来源订阅时只保存结果，不伪造一个待回传目标。

deliveryKey为SHA-256(canonicalJson([spaceId,bindingId,requestId,runId或'unstarted',resultVersion]))。唯一键重复返回原行，同键不同结果CONFLICT。当前固定使用已获来源完整最小权限的不可变结果包，最多5项主要依据；不同来源无法接收同一最小包则blocked，不临时各自裁剪，也不保存不存在的payload列。重试不读取最新草案。

数据库result_deliveries引用result_packages；若来源裁剪需要单独保存，初始实现增加专用delivery_payload_json列并作为迁移提交S02，或在enqueue时确认ResultPackage本身已是该来源获准最小包。本版固定选择后者：所有订阅必须具有该结果包的完整最小权限，否则blocked，不做每次临时不同裁剪。新增更细来源差异是后续契约变更。

## 4. 状态机

| 当前 | 后续 | 条件 |
|---|---|---|
| pending | sending/blocked | 当前绑定与外发权限有效/无效 |
| sending | delivered/uncertain/retryable_failed/blocked | 可核实可见回执/发送可能成功但未证实/确定未受理且可重试/身份失效 |
| uncertain | delivered/pending/blocked | reconcile found/确定absent且可安全重试/无法安全处理或绑定失效 |
| retryable_failed | pending/blocked | 退避到期且仍有效/次数或权限条件不满足 |
| delivered | 无 | 同版本不重复投递；不代表用户已读 |
| blocked | pending | 仅用户明确恢复且重新核实原绑定，不能改投另一个活跃对话 |

进入sending前持久attempts+1，提交后调用HostDeliveryPort.deliver。HostReceipt.messageId非空、visible=true、身份匹配才delivered。HTTP 2xx或工具返回接受不足；visible=false记uncertain。回执只证明可见，不声称用户已读。

## 5. worker、重试与恢复

全局一次一个投递，不占调查活动槽；按createdAt顺序。来源忙碌时依宿主实际契约排队，不能强插打断。确定未受理的临时故障退避5s/15s/60s，最多3次自动尝试；失败达上限blocked，保留主动取回路径。配置值是本包工程起始建议，不是宿主保证。

发送后断线/超时或进程重启留下sending一律uncertain。先reconcileDelivery：found且可见→delivered；absent且宿主支持幂等或能保证前次未写入→pending；unknown→blocked/待人工确认，不能盲目追加。默认无deliveryReconcile能力时不自动重试uncertain。

恢复只重试投递，不调用ExecutionPort.start、不让模型重新生成同一报告。更换账号/工作区后原结果仍锁在原主体空间；不能把“当前对话”当路由目的地。

## 6. 防递归与人工更新

包裹标记为`external_investigation_result`，携带requestId/jobId/resultVersion与未审核状态，宿主适配器使用真实支持的外部结果交付方式。内容不得冒充新的用户调查指令。来源Agent不因该结果自动再次request_investigation；S07幂等与来源事件类型共同阻止重入。

人工审核只改变本地审核记录；用户明确选择“向原来源发送修订结果”才调用S07 ReviewPublicationPort.publishReview。该用例校验来源与expectedCaseRevision/expectedResultVersion，再调用S10.publishReviewedInTx和enqueue同事务，summary标人工修订。旧delivered保留，不能原地覆盖。

## 7. 独立验收与交接

用HostDeliveryPort和ResultPackageReadPort共享fake覆盖：提交后崩溃、回执丢失、接受但不可见、来源忙/撤权、unknown不盲重发、重投递不重跑、同键冲突、只退订、人工新版本和无结果。组合验收再替换真实结果读取与SQLite。

交付outbox/订阅Repository、worker、状态说明和宿主fake；真实异步投递未通过时明确显示“需主动查询/回传不可用”，不把get_result通过记为全部P0通过。

## 8. 内嵌统一契约

固定导出`createDeliveryService(deps):{service:DeliveryService;atomic:SubscriptionAtomicPort}`；deps为`db,events,clock,ids,hostDelivery:HostDeliveryPort,results:ResultPackageReadPort`。subscribe/list/withdraw的InTx方法只访问本模块订阅，S07不直查私表。构造不启动worker，S03定时tick；不注入ExecutionPort。

### 发送边界

S11将已保存的获准最小ResultPackage规范序列化为HostMessage.text，kind固定external_investigation_result、mediaType固定application/json。每次重试使用同一结果版本的相同字节，不临时读取最新草案；HostDeliveryPort不接收领域ResultPackage。发布与清理的应用协调归S07，S11不反向依赖ReportService或RequestService。

<!-- CONTRACT:BEGIN roots=DeliveryService,SubscriptionAtomicPort,DeliveryRecord,ResultPackage,ResultPackageReadPort,HostDeliveryPort,HostMessage,DatabasePort,EventPort -->
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

export interface Scope {
  connectionId: Id;
  agentIds: string[];
  from: Instant;
  to: Instant;
  timeZone: string;
}

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

export interface OriginBinding {
  id: Id; spaceId: Id; principalId: Id; hostId: Id; hostAccountId: Id;
  workspaceId: Id; sessionId: string; requestMessageId: string;
  state: 'active' | 'revoked' | 'expired'; createdAt: Instant; expiresAt: Instant;
}

export interface HostReceipt { messageId: string; visible: boolean; observedAt: Instant }

export interface HostMessage {
  kind: 'external_investigation_result'; mediaType: 'application/json'; text: string;
}

export interface HostDeliveryPort {
  binding(ctx: CallContext, bindingId: Id): Promise<Result<OriginBinding>>;
  deliver(ctx: CallContext, input: { binding: OriginBinding; deliveryKey: string; message: HostMessage }): Promise<Result<HostReceipt>>;
  reconcileDelivery(ctx: CallContext, input: { binding: OriginBinding; deliveryKey: string }): Promise<Result<{ state: 'found' | 'absent' | 'unknown'; receipt?: HostReceipt }>>;
}

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

export interface ResultPackage {
  schemaVersion: '0.1.0'; requestId: Id; jobId: Id; caseId: Id; runId?: Id;
  resultVersion: number; terminalState: 'succeeded' | 'needs_review' | 'failed' | 'cancelled';
  review: ReportRecord['review']; summary: string; reportId?: Id;
  mainEvidence: ReportStatement[]; gaps: string[]; followups: FollowupDraft[];
  scope: Scope; error?: AppError;
}

export interface ResultPackageReadPort {
  getInTx(tx: ReadTx, ctx: CallContext, input: { requestId: Id; resultVersion?: number }): Result<ResultPackage>;
}

export type DeliveryState = 'pending' | 'sending' | 'delivered' | 'uncertain' | 'retryable_failed' | 'blocked';

export interface DeliveryRecord {
  id: Id; originBindingId: Id; requestId: Id; runId?: Id; resultVersion: number;
  deliveryKey: string; state: DeliveryState; attempts: number; result: ResultPackage;
  receipt?: HostReceipt; lastError?: AppError; nextAttemptAt?: Instant;
}

export interface DeliveryService {
  enqueueInTx(tx: WriteTx, ctx: CallContext, input: { bindingId: Id; result: ResultPackage }): Result<DeliveryRecord>;
  tick(ctx: CallContext): Promise<Result<number>>;
  status(ctx: CallContext, requestId: Id): Promise<Result<DeliveryRecord[]>>;
  getResult(ctx: CallContext, input: { requestId: Id; resultVersion?: number }): Promise<Result<ResultPackage>>;
}

export interface SubscriptionAtomicPort {
  subscribeInTx(tx: WriteTx, ctx: CallContext, input: { requestId: Id; bindingId: Id; canCancel: boolean }): Result<void>;
  listInTx(tx: ReadTx, ctx: CallContext, requestId: Id): Result<ResultSubscription[]>;
  withdrawInTx(tx: WriteTx, ctx: CallContext, input: { requestId: Id; bindingId: Id }): Result<void>;
}

export interface ResultSubscription {
  requestId: Id; bindingId: Id; canCancel: boolean; state: 'active' | 'withdrawn';
}

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

## 本模块 SQL 映射附件

以下包含本模块表及外键依赖表的统一结构。仅本模块拥有的表可直接写入，其余表通过公开端口或同步 InTx 方法操作；不得自行改列名或状态。

<!-- SQL:BEGIN tables=result_subscriptions,result_deliveries -->
```sql
PRAGMA foreign_keys = ON;

CREATE TABLE connections(
  id TEXT PRIMARY KEY, platform_instance_id TEXT NOT NULL, display_name TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>0), indexer_base_url TEXT, server_base_url TEXT,
  indexer_secret_ref TEXT, server_secret_ref TEXT, ca_ref TEXT,
  alerts_pattern TEXT NOT NULL, archives_pattern TEXT, mapping_version TEXT NOT NULL,
  principal_fingerprint TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE cases(
  id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0), title TEXT NOT NULL,
  connection_id TEXT NOT NULL REFERENCES connections(id), scope_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','investigating','resolved','reopened')),
  current_report_id TEXT, latest_report_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
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
```
<!-- SQL:END -->
