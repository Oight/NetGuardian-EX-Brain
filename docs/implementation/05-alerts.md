# S05 告警收件箱、本地提醒与自动候选

工程契约版本：0.2.0；修订日期：2026-10-23。状态：新增实现设计，未实现/未联调；业务基线 v4.2。接口及依赖在文末内嵌。

## 1. 职责与实现边界

实现 `packages/core/alerts/{watch,inbox,notifications,triggers,groups}.ts`，导出 AlertService。输入为 S04 的获准告警页，输出为收件箱、固定模板提醒及交给 S07 的自动候选。仅提醒完全不调用模型。自动开关只约束 alert_auto，不能关闭或取消用户主动调查。

依赖 PlatformQueryPort、ConnectionReadPort、CaseAtomicPort、RequestAtomicPort、DatabasePort、EventPort、ClockPort、IdPort 和 NotificationPort。最后一个端口由 S03 实现，最小签名为 `show({notificationId,title,body,alertIds}):Promise<Result<{shown:boolean}>>`，参数都无秘密；点击只返回已知 ID。

## 2. 所有数据与事务

拥有 alerts_inbox、watch_checkpoints、trigger_policies、auto_candidates、trigger_decisions、notifications。告警正文由 S06 保存为不可变证据，本模块只引用 EvidenceRef。receiveSeq 是该 space 内单调序号，由同一写事务计算 MAX+1，不能用事件时间或数组位置替代。

每页事务：核对连接 generation → S06 captureInTx → INSERT OR IGNORE 收件箱源身份 → 对真正新条目计算提醒和策略决策 → 写 notification/trigger_decision → 写 alerts.received。一个批次只有全部页持久化成功后才推进 completed_upper。页失败保留已入库页，不回滚其他已提交页，不推进完整边界。

## 3. 轮询、起点与补收

应用 ready 后每连接 10s 轮询一次，不重叠；错误退避 10/20/40/60s，成功后回到 10s。轮询只使用实际用户配置范围，缺 stable pagination 时明确 partial；不能把局部窗口扫完显示为连续无遗漏。

首次连接建立监测起点 now，先展示历史预览，不自动调查历史。正常循环使用 `[completedUpper-30s, capturedNow)`；30s 是工程起始重叠值，需要迟到记录回放后调整。重启初始补查 `[max(lastUpper,now-30min),now)`，标记 recovery；更旧缺口保留 gap 提示，由用户显式选择历史查询。

kind 的判定使用持久化的本轮接收模式，不凭告警 timestamp 单独猜“实时”。历史、恢复补收均不自动触发模型。源唯一键为规范 platformInstanceId/index/documentId 的哈希；同文本不同文档不能合并。

## 4. 提醒与去重

模板为“{设备/未知设备} · Wazuh 等级 {原生等级/未知} · {规则/未知规则} · {数量} 条”，附来源时间。未知描述不调用模型润色。告警风暴可把同候选提醒合并，但保留所有收件箱记录。

notifications.notification_key 对同组/同批源身份唯一。pending → 系统通知 → shown。发送后崩溃导致是否展示不确定时置 uncertain，默认不重复弹窗，收件箱仍可见；平台不支持通知幂等时不得宣称严格 exactly-once。静音只影响 notification，不修改策略和游标。

## 5. 策略、代次与候选

setPolicy 必须 expectedRevision 匹配；每次开启/关闭/修改推进 epoch。开启时保存当前 receiveSeq 为 enabledAfterReceiveSeq，只有随后 kind=realtime 且符合新策略的条目才可能派发。关闭/修改时，在同事务调用 RequestAtomicPort.cancelPolicyInTx；提交后通知S07的tick先处理这些cancel_requested任务，由S07撤销工具并请求中止。所有工具仍以持久 epoch 再检查，因此协调消息延迟不产生权限窗口，S05不直接调用ExecutionPort。

分组键只能使用实际确定身份：平台实例＋目标 Agent ID＋规则族＋带命名空间主体。来源 IP 仅为附加条件，空字段不得作为共享组键。缺关键身份时以告警身份形成单独候选，不把“未知”告警全合并。分组依据保存在 candidate_json，默认最大跨度30min、不活动间隔10min。

首次候选 coalesceUntil=firstReceivedAt+10s，expiresAt=firstReceivedAt+15min。自动范围默认告警前后5min，实际查询上界在 S07 preparing 截为当前时间；未来段显示未覆盖。候选默认单设备；多个设备需要可确认关联且不能超过5台。

已有同候选待运行任务时，10s 合并期只更新尚未冻结的种子；同案件存在活动调查时，新告警附案/提醒，当前 run 不改；已完成自动初查的候选不自动复查，只提示新材料。跨最大跨度/idle 形成新候选，仍受每日预算。

flushCandidates：对到期候选调用 RequestAtomicPort.createAutoInTx，受理结果与候选 dispatched 状态同事务保存，避免崩溃重复派发。S07 检查容量、活动任务、策略 epoch 和预算；QUEUE_FULL/BUDGET_EXHAUSTED/HOST_UNAVAILABLE 时保留未调查原因，不无限队列重试。后台持续失败不能积压无限 candidate；过期后转 expired、保留收件箱。

## 6. 并发、错误与恢复

同连接只有一个轮询 lease；write 串行且源身份唯一。收到重复页不重复通知、建案或计预算。用户修改分组或移除关联后，以案件 revision 为准，不能自动再覆盖人工拆分。自动候选只提供组织建议，不确认攻击链。

连接失败、无权限、空数据、分页中断分别显示；不把没有匹配告警写成无风险。应用完全退出、休眠或离线不承诺提醒。恢复后旧候选不因额度跨日恢复而自动补跑。

## 7. 独立验收与交接

使用合成分页和 ClockPort 验证：重复页、跨页失败、迟到记录、相同文本不同源 ID、首次历史、30min补收、开关在领取/发送间切换、重启receiveSeq保持、budget满仍提醒、未知主体不归并、风暴合并有上限、已完成案件追加不复查、通知发送中崩溃不重复声称成功。

交付轮询器、候选算法、数据库 Repository、模板、NotificationPort fake，以及策略和接收状态的可观察说明。不得启动真实平台轮询作为默认导入副作用；启动由 S03 显式调用。

## 8. 内嵌统一契约

固定导出`createAlertService(deps):AlertService`；deps字段为`db,events,clock,ids,query:PlatformQueryPort,connections:ConnectionReadPort,casesAtomic:CaseAtomicPort,requestsAtomic:RequestAtomicPort,notifications:NotificationPort`。db/events/clock/ids使用同名公共端口。构造不启动定时器，S03统一调pollOnce/flushCandidates。

<!-- CONTRACT:BEGIN roots=AlertService,NotificationPort,AutoCandidate,PlatformQueryPort,ConnectionReadPort,CaseAtomicPort,RequestAtomicPort,DatabasePort,EventPort -->
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

export type PlatformQueryPort = Pick<ConnectionService, 'query'>;

export type ConnectionReadPort = Pick<ConnectionService, 'list' | 'capabilities' | 'agents'>;

export interface EvidenceRef { evidenceId: Id; version: number }

export interface ContextRef { contextId: Id; version: number }

export interface DeliveredRef extends EvidenceRef { projectionId: Id }

export interface EvidenceRecord {
  id: Id; spaceId: Id; connectionId: Id; version: number;
  source: SourceLocator; kind: SourceRecord['kind'] | 'human_context';
  observedAt?: Instant; timeQuality: SourceRecord['timeQuality']; retrievedAt: Instant;
  contentHash: string; fields: JsonObject;
  availability: 'available' | 'expired';
}

export interface EvidenceProjection {
  id: Id; runId: Id; ref: EvidenceRef; content: JsonObject; contentHash: string;
  state: 'prepared' | 'released' | 'uncertain'; preparedAt: Instant; releasedAt?: Instant;
  availability: 'available' | 'expired';
}

export interface CaseRecord {
  id: Id; spaceId: Id; revision: number; title: string; scope: Scope;
  status: 'pending' | 'investigating' | 'resolved' | 'reopened';
  currentReportId?: Id; latestReportId?: Id; createdAt: Instant; updatedAt: Instant;
}

export interface BusinessContext {
  id: Id; caseId?: Id; connectionId: Id; agentIds: string[]; version: number;
  text: string; department?: string; purpose?: string; from: Instant; to: Instant;
  sourceLabel: string; verification: 'unverified' | 'verified' | 'rejected'; authorId: Id;
}

export interface CaseSnapshot {
  case: CaseRecord; evidence: EvidenceRecord[]; contexts: BusinessContext[];
  queries: { queryId: Id; coverage: Coverage }[]; nextEvidenceCursor?: string;
}

export interface QueryCapture {
  runId?: Id; caseId?: Id; connectionId: Id; query: PlatformQuery; page: PlatformPage;
}

export interface CleanupPlan {
  id: Id; planHash: string; expiresAt: Instant; caseIds: Id[];
  caseRevisions: { caseId: Id; revision: number }[];
  removableVersions: number; blockedVersions: number; approximateBytes: number;
}

export interface FrozenRunInput {
  question: string; scope: Scope; seedRefs: EvidenceRef[];
  contexts: BusinessContext[]; capabilities: Capability[];
}

export interface RunEvidenceView {
  runId: Id; caseId: Id; scope: Scope;
  projections: EvidenceProjection[];
  queries: { queryId: Id; coverage: Coverage }[];
}

export interface RunManifestMetadata {
  initialInput: FrozenRunInput;
  profileVersion: string;
  mappingVersion: string;
  steps: { id: Id; input: InvestigationStepInput }[];
  stopReason?: StopReason;
}

export interface CaseAtomicPort {
  getInTx(tx: ReadTx, ctx: CallContext, caseId: Id): Result<CaseRecord>;
  snapshotInTx(tx: ReadTx, ctx: CallContext, input: { caseId: Id; evidencePage: PageRequest }): Result<CaseSnapshot>;
  recordChangeInTx(tx: WriteTx, ctx: CallContext, input: { caseId: Id; expectedRevision: number; reason: string }): Result<number>;
  createInTx(tx: WriteTx, ctx: CallContext, input: { title: string; scope: Scope; seedRefs: EvidenceRef[] }): Result<CaseRecord>;
  setStatusInTx(tx: WriteTx, ctx: CallContext, input: { caseId: Id; expectedRevision: number; status: CaseRecord['status']; reason: string }): Result<CaseRecord>;
  captureInTx(tx: WriteTx, ctx: CallContext, input: QueryCapture): Result<EvidenceRef[]>;
  initializeRunInTx(tx: WriteTx, ctx: CallContext, input: { run: AnalysisRun; seedRefs: EvidenceRef[]; question: string; capabilities: Capability[] }): Result<FrozenRunInput>;
  inspectRunInTx(tx: ReadTx, ctx: CallContext, run: AnalysisRun): Result<RunEvidenceView>;
  attachInTx(tx: WriteTx, ctx: CallContext, input: { caseId: Id; refs: EvidenceRef[]; expectedRevision: number; reason: string }): Result<number>;
  projectInTx(tx: WriteTx, ctx: CallContext, input: { runId: Id; refs: EvidenceRef[]; fieldNames: string[] }): Result<EvidenceProjection[]>;
  releaseInTx(tx: WriteTx, ctx: CallContext, input: { runId: Id; projectionIds: Id[]; outcome: 'released' | 'uncertain' }): Result<void>;
  sealInTx(tx: WriteTx, ctx: CallContext, input: { runId: Id; metadata: RunManifestMetadata }): Result<{ manifestHash: string; refs: DeliveredRef[] }>;
  applyRunInTx(tx: WriteTx, ctx: CallContext, input: { run: AnalysisRun; reportId: Id }): Result<{ applied: boolean; revision: number }>;
  previewCleanupInTx(tx: WriteTx, ctx: CallContext, input: { caseIds: Id[]; olderThan: Instant; protectedRunIds: Id[] }): Result<CleanupPlan>;
  applyCleanupInTx(tx: WriteTx, ctx: CallContext, input: { planId: Id; expectedPlanHash: string; protectedRunIds: Id[] }): Result<{ expiredVersions: number; projectionIds: Id[] }>;
}

export interface InboxAlert {
  id: Id; connectionId: Id; sourceKey: string; receiveSeq: number;
  kind: 'realtime' | 'history' | 'recovery'; evidence: EvidenceRef;
  agentId?: string; ruleId?: string; ruleGroups: string[]; level?: number;
  observedAt?: Instant; receivedAt: Instant; read: boolean; decisionReason: string;
}

export interface TriggerPolicy {
  id: Id; connectionId: Id; revision: number; epoch: number; enabled: boolean;
  agentIds: string[]; filter: AlertFilter; enabledAfterReceiveSeq: number;
  dailyAttemptLimit: number; timeZone: string;
  dailyTokenLimit?: number;
}

export interface AutoCandidate {
  id: Id; policyId: Id; policyEpoch: number; caseId: Id; alertIds: Id[];
  scope: Scope; question: string; firstReceivedAt: Instant; lastReceivedAt: Instant;
  coalesceUntil: Instant; expiresAt: Instant;
}

export interface AlertService {
  pollOnce(ctx: CallContext, connectionId: Id): Promise<Result<{ inserted: number; complete: boolean }>>;
  list(ctx: CallContext, input: { connectionId: Id; page: PageRequest; scope?: Scope; filter?: AlertFilter; read?: boolean }): Promise<Result<{ items: InboxAlert[]; nextCursor?: string }>>;
  markRead(ctx: CallContext, alertIds: Id[]): Promise<Result<void>>;
  setPolicy(ctx: CallContext, input: { expectedRevision: number; policy: TriggerPolicy }): Promise<Result<TriggerPolicy>>;
  flushCandidates(ctx: CallContext): Promise<Result<number>>;
}

export interface NotificationPort {
  show(input: { notificationId: Id; title: string; body: string; alertIds: Id[] }): Promise<Result<{ shown: boolean }>>;
}

export type Origin = 'alert_auto' | 'client_user' | 'teleagent_user';

export type RequestState = 'awaiting_scope' | 'accepted' | 'rejected' | 'withdrawn';

export type JobState = 'coalescing' | 'queued' | 'preparing' | 'submitting' | 'running'
  | 'verifying' | 'succeeded' | 'needs_review' | 'failed'
  | 'cancel_requested' | 'cancelled' | 'uncertain';

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

export interface RequestAtomicPort {
  createAutoInTx(tx: WriteTx, ctx: CallContext, candidate: AutoCandidate): Result<RequestStatus>;
  cancelPolicyInTx(tx: WriteTx, ctx: CallContext, input: { policyId: Id; obsoleteEpoch: number }): Result<{ revokeRunIds: Id[] }>;
}

export interface InvestigationStepInput {
  phase: 'orientation' | 'querying' | 'evaluating' | 'stopped';
  summary: string; purpose?: string; evidenceRefs: DeliveredRef[];
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

## 本模块 SQL 映射附件

以下包含本模块表及外键依赖表的统一结构。仅本模块拥有的表可直接写入，其余表通过公开端口或同步 InTx 方法操作；不得自行改列名或状态。

<!-- SQL:BEGIN tables=alerts_inbox,watch_checkpoints,trigger_policies,auto_candidates,trigger_decisions,notifications -->
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
```
<!-- SQL:END -->
