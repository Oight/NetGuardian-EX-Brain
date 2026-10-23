# S09 两角色 MCP 入口与证据通道管理

工程契约版本：0.2.0；修订日期：2026-10-23。状态：实现设计，未联调；业务基线 v4.2。[修订记录](changes-0.2.0.md)。传输与真实宿主能力未获证据的项默认关闭。

## 1. 范围与两个组件

`packages/mcp-server/channels` 是独立通道管理组件，仅依赖 db/secrets/clock/ids 和公共契约，拥有 mcp_grants；导出 `createEvidenceChannels(deps):EvidenceChannelPort`。open 创建 pending，可信 bind 后 active，revoke 失效；它不回调业务应用、工具处理器或网关。

`packages/mcp-server/gateway` 实现传输、认证、schema 与角色路由，导出 `createMcpGateway(deps):McpGatewayPort`。deps 为 clock、channels、delegationCommands:RequestCommandPort、delegationReads:RequestReadPort、scope:ConnectionReadPort、results:Pick<DeliveryService,'getResult'>、origins:TrustedOriginPort、tools:InvestigationToolPort 和协议 transport；不注入数据库、预算、S04.query、CaseService 或 ReportService。

通道组件另导出只读 `createChannelAuthenticator`，使用同模块 grant Repository/SecretPort 检查凭据，作为 transport 的内部依赖，不能成为模型参数。网关认证后的 Actor 由服务器建立，再交应用用例。McpGatewayPort 仅 start/stop/invoke，调度只拿 EvidenceChannelControlPort，S08 只拿 EvidenceChannelBindingPort。

原 mcp_calls/investigation_steps 转由 S07 工具应用用例拥有，表名不变。S09 不保存业务步骤、扣预算、生成证据投影或决定任务终态，因此没有回调式装配环。

## 2. 传输与授权

首个候选仍为回环 Streamable HTTP，独立 stdio 为未默认启用候选；协议/SDK按宿主实测锁定。仅127.0.0.1/::1，核对Host/Origin；无Origin客户端按明确凭据策略处理。随机端口与Mcp-Session-Id均不构成授权。

委派与取证独立角色/凭据。每轮token随机>=256bit，明文只入SecretPort，库保存摘要；不放URL、prompt、参数或日志。tools/list 与 tools/call 都检查身份、角色、run、toolEpoch、generation、deadline。实际grant来自可信宿主绑定，模型自报sessionId不激活通道。

S07 先推进 epoch/关闭 run，再调用 channels.revoke；网关调用前与实际发送前检查授权，应用用例在平台请求前后检查持久 run fence。取消后晚到响应不能交付，不能因减少依赖删除复核。

## 3. 委派工具契约

工具名 snake_case，参数 camelCase，未知字段拒绝。originBindingId/Actor 来自认证 transport 与 TrustedOriginPort，不从arguments取得。

| 工具 | 参数要点 | 业务端口 |
|---|---|---|
| list_investigation_scope | connectionId?、page | scope.list/capabilities/agents；无秘密摘要 |
| request_investigation | connectionId/question/requestedScope?/seedRefs/caseId?/idempotencyKey | commands.create，补 origin=teleagent_user 和可信来源 |
| provide_investigation_input | requestId/scope?/text?/idempotencyKey | commands.provideInput |
| get_investigation_status | requestId | reads.status |
| get_investigation_result | requestId/resultVersion? | results.getResult |
| cancel_investigation | requestId/reason | commands.cancel，普通订阅者仅退订 |

ControlToolEnvelope 保持 schemaVersion=0.1.0、status=ok/needs_input/failed、data/warnings；错误置data.error并isError。accepted 快速回执，不长挂、不无限轮询。提交/补范围的重试由业务幂等键处理，不在协议层再造另一套任务幂等。

## 4. 取证工具目录与路由

工具参数和外部工具信封0.1.0保持原范围。gateway 完成工具参数校验后原样交 S07 InvestigationToolPort，工具是否可见由grant能力决定。runId来自grant，可选参数只校验一致。

| 工具 | 受控参数 | 应用处理 |
|---|---|---|
| get_case_context | 空对象 | 冻结问题、scope、能力、已交付背景/种子 |
| search_related_alerts | agentIds/from/to/filter/page/purpose?/step? | alerts 查询 |
| search_authentication_events | agentIds/from/to/outcome/account?/sourceIp?/page/purpose?/step? | 经确认映射的认证查询 |
| get_evidence | ref、fieldNames | 当前run证据版本的白名单投影 |
| get_host_inventory | agentId/category/page/purpose?/step? | 单台os/hardware/packages/processes/ports |
| search_file_changes | agentIds/from/to/pathEquals?/page/purpose?/step? | 仅FIM事件能力；不临时读文件 |
| get_host_findings | agentId/category/page/purpose?/step? | sca/vulnerabilities，按能力启用 |
| record_investigation_step | InvestigationStepInput | 保存声明摘要，不记录私有思维链 |
| propose_report | ReportCandidate | 保存/校验候选，不修改job终态 |

account含namespace/name；page含cursor?/limit。scope.connectionId/timeZone取run，设备/时间必须为子集。purpose<=500字，随查询携带step不额外计工具，但不能隐藏第二次查询。新工具须集中修改schema/能力映射/应用handler/验收，不把任意JSON透传给平台。

## 5. 执行、发送与重试

S07 处理call幂等、预算、查询、证据与回复缓存；gateway不复制这些逻辑。取证回复以content文本JSON为兼容基线，可附相同structuredContent。读取使用EvidenceToolEnvelope，步骤/提案使用带budget的ControlToolEnvelope。

完整发送后tools.acknowledgeReply({transportBindingId,callId,outcome:'released'})，发送不明则uncertain；S07核对call/run/binding后释放投影。此回调不在准备时调用。单次UTF-8<=16KiB，网关可再次检查但不自行删字段/截断JSON。stop使用channels.revokeAll失效本空间旧grant后关闭监听，调度仍只持有单run控制端口。

零匹配与denied/failed/unavailable/partial分别显示；records.length是本次投影数，Coverage.returned是已保存源记录数，缩减投影保留warnings而不改造平台完成事实。已清理缓存由S07返回EXPIRED，不自行重新查询。

## 6. 独立验收与交接

通道组件独立验证 pending/active/revoked、token摘要、可信绑定、过期与旧epoch；gateway使用共享的请求/工具应用fake，验证角色交叉、伪造来源、未知参数、发送完成/中断回调、文本JSON和structured一致。真实协议适配另验认证头、工具隔离和实际发送语义。

S07负责预算竞争、capture回滚、回复幂等和清理缓存；S09验收必须证明这些请求被路由到相同应用用例，不能另写一套实现。构造不监听，S03恢复后start；stop先使通道失效再关闭监听。

## 7. 内嵌统一契约

<!-- CONTRACT:BEGIN roots=McpGatewayPort,EvidenceChannelPort,InvestigationToolPort,RequestCommandPort,RequestReadPort,ConnectionReadPort,DeliveryService,TrustedOriginPort,DatabasePort,EventPort,SecretPort,EvidenceToolEnvelope,ControlToolEnvelope -->
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

export interface PageRequest { cursor?: string; limit: number }

export interface Count { value: number; relation: 'eq' | 'gte' }

export interface Scope {
  connectionId: Id;
  agentIds: string[];
  from: Instant;
  to: Instant;
  timeZone: string;
}

export interface Coverage {
  requestedScope: Scope;
  effectiveScope: Scope;
  queryCompleteness: 'complete' | 'partial' | 'not_executed';
  collectionCoverage: 'known' | 'partial' | 'unknown';
  sourceTypes: string[];
  reasons: string[];
  retrievedAt: Instant;
  observedFrom?: Instant;
  observedTo?: Instant;
  returned: number;
  total?: Count;
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

export interface SecretPort {
  put(input: { owner: Id; purpose: string; value: Uint8Array; persist: boolean }): Promise<Result<Id>>;
  use<T>(ref: Id, purpose: string, work: (value: Uint8Array) => Promise<T>): Promise<Result<T>>;
  remove(ref: Id): Promise<Result<void>>;
}

export interface ConnectionProfile {
  id: Id; spaceId: Id; platformInstanceId: Id; displayName: string;
  generation: number; indexerBaseUrl?: string; serverBaseUrl?: string;
  indexerSecretRef?: Id; serverSecretRef?: Id; caRef?: Id;
  alertsPattern: string; archivesPattern?: string; mappingVersion: string;
  principalFingerprint: string; updatedAt: Instant;
}

export type CapabilityName = 'alerts' | 'archives' | 'authentication_events' | 'agents'
  | 'inventory_os' | 'inventory_hardware' | 'inventory_packages' | 'inventory_processes'
  | 'inventory_ports' | 'fim_objects' | 'fim_events' | 'sca' | 'vulnerabilities'
  | 'stable_alert_pagination';

export interface Capability {
  name: CapabilityName;
  state: 'available' | 'denied' | 'unreachable' | 'unsupported' | 'unverified';
  checkedAt: Instant; evidence: string; endpointKind: 'indexer' | 'server';
}

export interface AgentSummary { id: string; name?: string; status?: string; version?: string }

export interface DeviceDetailInput {
  connectionId: Id; agentId: string;
  category: 'os' | 'hardware' | 'packages' | 'processes' | 'ports' | 'fim_objects' | 'sca';
  page: PageRequest;
}

export interface DeviceDetail {
  agentId: string; category: DeviceDetailInput['category']; items: SourceRecord[];
  nextCursor?: string; total?: Count; retrievedAt: Instant;
  status: 'ok' | 'partial' | 'denied' | 'unavailable' | 'failed'; warnings: string[];
}

export interface AlertFilter { ruleIds?: string[]; ruleGroups?: string[]; minLevel?: number }

export type PlatformQuery =
  | { kind: 'alerts'; scope: Scope; filter: AlertFilter; page: PageRequest; fixedUpper: Instant }
  | { kind: 'authentication'; scope: Scope; outcome: 'success' | 'failure' | 'any';
      account?: { namespace: string; name: string }; sourceIp?: string; page: PageRequest }
  | { kind: 'inventory'; scope: Scope; category: 'os' | 'hardware' | 'packages' | 'processes' | 'ports'; page: PageRequest }
  | { kind: 'file_changes'; scope: Scope; pathEquals?: string; page: PageRequest }
  | { kind: 'findings'; scope: Scope; category: 'sca' | 'vulnerabilities'; page: PageRequest };

export interface SourceLocator {
  platformInstanceId: Id;
  kind: 'index_document' | 'resource';
  index?: string; documentId?: string;
  resource?: string; agentId?: string; collectionIdentity?: string;
}

export interface SourceRecord {
  source: SourceLocator; kind: 'alert' | 'authentication' | 'inventory' | 'fim' | 'finding';
  agentId?: string; observedAt?: Instant; timeQuality: 'source' | 'ambiguous' | 'unknown';
  retrievedAt: Instant; fields: JsonObject;
}

export interface PlatformPage {
  status: 'ok' | 'partial' | 'denied' | 'unavailable' | 'failed';
  queryId: Id; pageId: Id; pageOrdinal: number;
  records: SourceRecord[]; coverage: Coverage; nextCursor?: string;
  warnings: string[]; platformAttempts: number;
}

export interface AlertStatistics {
  scope: Scope; total: Count; byLevel: { level: number; count: number }[];
  byHour: { start: Instant; count: number }[]; coverage: Coverage;
}

export interface PlatformCall {
  runId?: Id;
  beforeAttempt: () => Promise<Result<void>>;
  signal: AbortSignal;
}

export interface ConnectionService {
  list(ctx: CallContext): Promise<Result<ConnectionProfile[]>>;
  save(ctx: CallContext, input: Omit<ConnectionProfile, 'generation' | 'updatedAt'> & { expectedGeneration?: number }): Promise<Result<ConnectionProfile>>;
  capabilities(ctx: CallContext, connectionId: Id, refresh: boolean): Promise<Result<Capability[]>>;
  agents(ctx: CallContext, input: { connectionId: Id; page: PageRequest }): Promise<Result<{ items: AgentSummary[]; nextCursor?: string; total?: Count }>>;
  deviceDetail(ctx: CallContext, input: DeviceDetailInput, call: PlatformCall): Promise<Result<DeviceDetail>>;
  query(ctx: CallContext, input: PlatformQuery, call: PlatformCall): Promise<Result<PlatformPage>>;
  statistics(ctx: CallContext, scope: Scope, call: PlatformCall): Promise<Result<AlertStatistics>>;
}

export type ConnectionReadPort = Pick<ConnectionService, 'list' | 'capabilities' | 'agents'>;

export interface EvidenceRef { evidenceId: Id; version: number }

export interface ContextRef { contextId: Id; version: number }

export interface DeliveredRef extends EvidenceRef { projectionId: Id }

export interface BusinessContext {
  id: Id; caseId?: Id; connectionId: Id; agentIds: string[]; version: number;
  text: string; department?: string; purpose?: string; from: Instant; to: Instant;
  sourceLabel: string; verification: 'unverified' | 'verified' | 'rejected'; authorId: Id;
}

export type Origin = 'alert_auto' | 'client_user' | 'teleagent_user';

export type RequestState = 'awaiting_scope' | 'accepted' | 'rejected' | 'withdrawn';

export type JobState = 'coalescing' | 'queued' | 'preparing' | 'submitting' | 'running'
  | 'verifying' | 'succeeded' | 'needs_review' | 'failed'
  | 'cancel_requested' | 'cancelled' | 'uncertain';

export interface CreateRequest {
  origin: Origin; connectionId: Id; question: string; requestedScope?: Scope;
  seedRefs: EvidenceRef[]; caseId?: Id; idempotencyKey: string;
  originBindingId?: Id; autoCandidateId?: Id;
}

export interface InvestigationRequest {
  id: Id; origin: Origin; state: RequestState; connectionId: Id; question: string;
  requestedScope?: Scope; effectiveScope?: Scope; seedRefs: EvidenceRef[];
  caseId?: Id; jobId?: Id; originBindingId?: Id; autoCandidateId?: Id;
  missingFields: string[]; createdAt: Instant; expiresAt: Instant;
}

export interface AnalysisRun {
  id: Id; jobId: Id; caseId: Id; baseRevision: number; scope: Scope;
  connectionGeneration: number; identityEpoch: number; profileVersion: string;
  toolEpoch: number; expiresAt: Instant; manifestHash?: string;
}

export interface JobRecord {
  id: Id; requestId: Id; caseId: Id; runId?: Id; origin: Origin; state: JobState;
  revision: number; createdAt: Instant; updatedAt: Instant; expiresAt: Instant;
  recoveryHold: boolean;
  policyId?: Id; policyEpoch?: number; error?: AppError;
}

export interface BudgetState {
  runId: Id; toolsUsed: number; readsUsed: number; platformAttempts: number;
  distinctEvents: number; deadline: Instant; closed: boolean;
}

export interface RequestStatus {
  request: InvestigationRequest; job?: JobRecord; budget?: BudgetState;
  deliveryState?: DeliveryState;
  subscriptionCancelled?: boolean;
}

export interface RunSnapshot {
  run: AnalysisRun; job: JobRecord;
  steps: { id: Id; phase: string; summary: string; purpose?: string; createdAt: Instant }[];
  report?: ReportRecord; budget: BudgetState;
}

export interface RequestService {
  create(ctx: CallContext, input: CreateRequest): Promise<Result<RequestStatus>>;
  provideInput(ctx: CallContext, input: { requestId: Id; scope?: Scope; text?: string; idempotencyKey: string }): Promise<Result<RequestStatus>>;
  status(ctx: CallContext, requestId: Id): Promise<Result<RequestStatus>>;
  runSnapshot(ctx: CallContext, runId: Id): Promise<Result<RunSnapshot>>;
  cancel(ctx: CallContext, input: { requestId: Id; reason: string }): Promise<Result<RequestStatus>>;
  resume(ctx: CallContext, input: { requestId: Id; expectedJobRevision: number }): Promise<Result<RequestStatus>>;
  abandon(ctx: CallContext, input: { requestId: Id; expectedJobRevision: number; reason: string }): Promise<Result<RequestStatus>>;
  reconcile(ctx: CallContext, input: { requestId: Id; expectedJobRevision: number }): Promise<Result<RequestStatus>>;
  tick(ctx: CallContext): Promise<Result<{ startedJobId?: Id }>>;
}

export type RequestCommandPort = Pick<RequestService, 'create' | 'provideInput' | 'cancel'>;

export type RequestReadPort = Pick<RequestService, 'status'>;

export interface OriginBinding {
  id: Id; spaceId: Id; principalId: Id; hostId: Id; hostAccountId: Id;
  workspaceId: Id; sessionId: string; requestMessageId: string;
  state: 'active' | 'revoked' | 'expired'; createdAt: Instant; expiresAt: Instant;
}

export interface ChannelHandle {
  id: Id; runId: Id; transport: 'streamable-http' | 'stdio';
  endpoint?: string; secretRef: Id; expiresAt: Instant;
  state: 'pending' | 'active' | 'revoked';
}

export interface HostReceipt { messageId: string; visible: boolean; observedAt: Instant }

export interface TrustedOriginPort {
  resolveOrigin(ctx: CallContext, trustedTransportBindingId: Id): Promise<Result<OriginBinding>>;
}

export interface ToolInvocation {
  transportBindingId: Id; callId: string; toolName: string; arguments: JsonObject;
}

export interface ToolReply {
  isError: boolean; text: string; structured?: JsonObject;
  preparedProjectionIds: Id[];
}

export interface EvidenceToolEnvelope {
  schemaVersion: '0.1.0';
  status: PlatformPage['status']; queryId?: Id;
  records: { ref: DeliveredRef; content: JsonObject }[];
  coverage?: Coverage; nextCursor?: string; budget: BudgetState; warnings: string[];
  context?: {
    question: string; scope: Scope; capabilities: Capability[];
    backgrounds: { ref: ContextRef; context: BusinessContext }[];
  };
}

export interface ControlToolEnvelope {
  schemaVersion: '0.1.0'; status: 'ok' | 'needs_input' | 'failed';
  data: JsonObject; budget?: BudgetState; warnings: string[];
}

export interface McpGatewayPort {
  start(ctx: CallContext): Promise<Result<{ endpoint?: string }>>;
  stop(ctx: CallContext): Promise<Result<void>>;
  invoke(ctx: CallContext, input: ToolInvocation): Promise<Result<ToolReply>>;
}

export interface EvidenceChannelPort {
  openChannel(ctx: CallContext, run: AnalysisRun): Promise<Result<ChannelHandle>>;
  bindChannel(ctx: CallContext, input: { channelId: Id; runId: Id; trustedSessionBindingId: Id }): Promise<Result<ChannelHandle>>;
  revoke(ctx: CallContext, runId: Id): Promise<Result<void>>;
  revokeAll(ctx: CallContext): Promise<Result<void>>;
}

export interface InvestigationToolPort {
  invoke(ctx: CallContext, input: ToolInvocation): Promise<Result<ToolReply>>;
  acknowledgeReply(ctx: CallContext, input: { transportBindingId: Id; callId: string; outcome: 'released' | 'uncertain' }): Promise<Result<void>>;
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

<!-- SQL:BEGIN tables=mcp_grants -->
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

CREATE TABLE mcp_grants(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES analysis_runs(id), role TEXT NOT NULL,
  token_digest TEXT NOT NULL UNIQUE, secret_ref TEXT NOT NULL, tool_epoch INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','active','revoked')), binding_json TEXT,
  expires_at TEXT NOT NULL
);
```
<!-- SQL:END -->
