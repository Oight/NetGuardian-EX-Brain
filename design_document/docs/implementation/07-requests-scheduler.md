# S07 统一请求、调查用例、预算与恢复

工程契约版本：0.2.0；修订日期：2026-10-23。状态：实现设计，未实现/未联调；业务基线 v4.2。[修订记录](changes-0.2.0.md)。S07 是应用协调层，内部组件分别构造，不能做成互相回调的单个巨型类。

## 1. 范围、代码与窄端口

目录 `packages/core/requests/{requests,scheduler,budgets,cancel,recovery,repositories}.ts` 管理生命周期；`packages/core/investigations/{tool-runner,retention,publication,completion}.ts` 承载跨所有者应用用例。保留 S07 编号，不新增业务需求或系统服务。

分开装配：`createRunBudget(deps)` 返回 `{budget:RunBudgetPort;atomic:RunBudgetAtomicPort}`，只依赖 db/clock/ids/settings；`createInvestigationTools(deps):InvestigationToolPort` 依赖 db/events/clock/ids、budget/budgetAtomic、query:PlatformQueryPort、casesAtomic:CaseAtomicPort、proposals:ReportProposalPort；工具账本/步骤 Repository 在本组件内部。

`createRequestService(deps)` 返回 `{service:RequestService;atomic:RequestAtomicPort}`，依赖 db/events/clock/ids/settings、cases:CaseService/casesAtomic、connections:ConnectionReadPort、execution:ExecutionPort、channels:EvidenceChannelControlPort、profiles:InvestigationProfilePort、reports:ReportCompletionPort、delivery:DeliveryService、subscriptions:SubscriptionAtomicPort 和上述预算组件。不得注入 McpGatewayPort、工具 dispatcher 或 HostAccess 全能力。

`createRetentionService(deps):RetentionService` 依赖 db/clock、casesAtomic 和本模块 ToolReplyAtomicPort；`createReviewPublication(deps):ReviewPublicationPort` 依赖 db、reports:ReportCompletionPort、delivery/subscriptions 及本模块请求 Repository。它们不注入调度 service 整体。所有构造无外部副作用，定时 tick 由 S03 启动。

## 2. 数据所有者与入口

拥有 investigation_requests/request_keys/request_events/deferred_inputs/jobs/analysis_runs/quota_ledger/tool_reservations/platform_attempts/run_event_keys，以及取证调用账本 mcp_calls、步骤 investigation_steps。后两表保持物理表名，但从 S09 转由 S07 拥有；不是传输层私有缓存。S09 不直接写它们。

alert_auto 仅 system 通过 RequestAtomicPort.createAutoInTx 创建；client_user 仅 UI；teleagent_user 必须 delegation Actor 的可信来源绑定。自动开关只约束 alert_auto，主动请求不计每日自动尝试。

缺范围先 awaiting_scope，不建 job/run/会话、不占队列；超限明确拒绝。相对时间首次解析为绝对值并持久保存，重试复用。实际 scope.to=min(requestedTo,preparingNow)，未来部分标未覆盖；若 from>=实际 to 则 needs_input。单轮最多 1h/5 台。

幂等作用域 principalId+可信 originKey+idempotencyKey，UI originKey=client、委派=bindingId、自动=candidateId。同规范内容返回原请求，不同内容 CONFLICT。provideInput 使用自己的键，活动轮次的新文字只记 deferred_inputs，不暗改已发提示。

受理同事务检查权限/容量/幂等、选案或建案、保存 request/job/key、委派订阅和事件。总待运行 20（含 coalescing），缺范围不计；队列满明确失败。相同案件/问题/范围可订阅已有活动任务，普通订阅者不得取消原任务；不同问题或范围排队。

## 3. 调度、终态与取消

tick 在恢复屏障后串行运行，先处理已持久 cancel_requested，再领取新任务；主动优先，随后原生等级/等待时间，不中断活动轮次。数据库约束一个 preparing/submitting/running/verifying/cancel_requested/uncertain。15min 请求排队期限与从 preparing 起 5min run 期限独立。

| 状态 | 允许后续 | 事实依据 |
|---|---|---|
| coalescing | queued/cancelled/failed | 合并期、策略、过期 |
| queued | preparing/cancelled/failed | 槽位/授权/期限/预算 |
| preparing | submitting/failed/cancelled/needs_review | 输入冻结和授权建立；确定未提交可取消 |
| submitting | running/uncertain/failed/cancel_requested | 宿主核实本次消息，不只看204 |
| running | verifying/cancel_requested/uncertain/failed | 已核实终态或故障，SSE idle不足 |
| verifying | succeeded/needs_review/failed/cancel_requested | 最新CAS、执行事实、草案校验 |
| cancel_requested | cancelled/uncertain/needs_review | 实际取消、仍未知、取消前已完成 |
| uncertain | running/verifying/cancelled/failed/needs_review | 核实可信事实或明确本地放弃 |
| succeeded/needs_review/failed/cancelled | 无 | 新调查建立新请求 |

所有 JobState 转换与 CompletionDecision 只由 S07 决定，revision CAS 与事件同事务。S08 只给规范化执行事实，S10 只给草案校验结果；S10 不读 jobs/request_events 再判断取消。

决策规则：verified 正常完成且报告 valid、无有效取消→succeeded；正常完成但无结构/疑点且有材料→needs_review；确定执行失败→failed；已观察取消→cancelled；取消先生效但远端恰好完成→needs_review；明确 abandon 且远端未知→needs_review+UNCERTAIN。仍待核实的 uncertain 无伪终态结果，RESULT_NOT_READY。

## 4. 准备与完成的事务顺序

1. 同事务核对代次/槽位/TTL，S06 先进入 investigating，再冻结 scope/baseRevision/generation/identityEpoch，预算检查 seed 源身份，initializeRunInTx 保存初始输入，预占自动尝试。
2. 事务外由通道管理创建pending grant；S07在受保护准备事务调用S06.projectInTx生成种子投影，事务外把InvestigationProfileInput交S10 prepare，随后保存实际prepared_profile_json。核对宿主专用配置/隔离能力，记录submitting意图后由S08建会话、绑定、提交，未知不重提。
3. S08 inspect 仅核实本应用保存会话。初始投影的释放由 S08 确认文字后返回事实，S07 调 S06 releaseInTx；不得准备时提前释放。
4. 结束先推进 toolEpoch/关闭预算，事务外撤销 grant；verifying 同事务：读取本模块初始输入/步骤组成 RunManifestMetadata→S06 sealInTx→S10 assessInTx→S07 决定 CompletionDecision→S10 finalizeInTx→必要时 S06 applyRunInTx→更新 JobState→为有效订阅排 outbox。任一步失败回滚。
5. 提交后由 S11 投递，重试投递不重跑模型。finalization/resultVersion 幂等，重复 inspect 不重复创建报告、核查事项或投递。

## 5. 取证应用用例与预算

InvestigationToolPort 接收 S09 已认证的 ToolInvocation，Actor/transportBindingId 来自可信通道，参数再次校验。按 binding+callId 查本模块 mcp_calls，同参数返回缓存，不同参数 CONFLICT；inflight 不明不重复执行外部查询。

同事务检查 run fence、记录 call、预占工具预算；事务外查询 S04，每次发送前通过 budget.reservePlatformAttempt；返回后再次核对 fence。同事务先按源身份预占事件数，再 S06.captureInTx/projectInTx，保存回复及 projectionIds；失败整笔回滚。返回文字必须有覆盖/预算且<=16KiB，必要时明确减少本次投影并标 partial，不截断 JSON。get_case_context/propose_report/步骤走各自确定性方法，不私加查询。

S09实际发送后调用tools.acknowledgeReply，输入必须含transportBindingId+callId，S07核对当前run和调用记录，再委托S06 releaseInTx。get_case_context使用已保存FrozenRunInput/PreparedProfile。propose_report在同事务取S06.inspectRunInTx，加实际交付背景组成ReportValidationInput后调用S10.proposeInTx；该快照不是模型参数。步骤与提案也占总工具数，purpose随查询保存不额外计一次。

上限：12次工具、读取<=10、20次实际平台请求、300个不同事件。失败预占不返还，同call缓存不重扣；平台缓存不计网络但新call计工具。reservation持久保存toolEpoch/identityEpoch/connectionGeneration，后续请求与晚到回复必须和当前run匹配，不能重连后复用旧授权。自动每日默认10次预占，失败/取消/重启不返还；usage未知不记零，启用token停派时按配置暂停，不保证硬费用上限。

## 6. 清理与人工修订发布

RetentionService 在自己的 WriteTx 内读取当前活动/uncertain runId，交 S06 previewCleanupInTx/applyCleanupInTx；apply 返回 projectionIds 后，ToolReplyAtomicPort.expireRepliesInTx 将相关 mcp_calls 正文改为 EXPIRED。共同事务失败全部回滚，清理不重新查上游。

ReviewPublicationPort.publishReview保留Desktop输入，核对自己的请求/版本，通过SubscriptionAtomicPort.listInTx取得获准来源，组成ResultContext，再调用S10.publishReviewedInTx与S11.enqueueInTx同事务。取消普通订阅也用listInTx判canCancel，再withdrawInTx，不直接操作S11私表。完成时保存completion_decision_json；审核保存不默认发布、不重跑模型。

## 7. 恢复、超时与放弃

确定未提交排队任务可取消并用无 run 结果；已创建但确定未外发则保留真实 runId 封存。已提交取消先关闭工具，再 abort，分开记录请求与观测。期限到用同样顺序保留部分材料。

重启后旧自动 queued/coalescing 取消且不补派；未提交主动任务 recoveryHold，身份/TTL/范围有效才 resume。preparing 无任何外部 intent 才能确定未提交；原 run 仍有效且输入未变可恢复，替换 grant 推进 epoch；过期另建新请求，不能沿用 runId 重冻输入。已提交只 inspect 原会话。

uncertain 占槽；自动最多按 5s/15s/60s 核实三次，仍未知等待显式 reconcile/abandon。abandon 需 expectedJobRevision+理由，撤销工具并说明远端可能仍运行，再 needs_review/failed 释放本地槽，不能宣称远端 cancelled。

## 8. 独立验收与交接

按三个组件分别验证请求状态机、原子预算、工具 runner；共享 fake 必须能模拟外部已执行但响应丢失。组合验收覆盖最后额度竞争、取消与完成、事件数与保存回滚、清理缓存回滚、204未核实、旧结果、重启hold、结果与outbox原子性。新增查询处理器不应修改请求状态机。

模块交付和共享文件修改遵循[开发规范](../development/README.md)。S07 内部组件可以分任务，但同一时间每个共享文件只有一个写任务。

## 9. 内嵌统一契约

<!-- CONTRACT:BEGIN roots=RequestService,RequestAtomicPort,RunBudgetPort,RunBudgetAtomicPort,InvestigationToolPort,ToolReplyAtomicPort,RetentionService,ReviewPublicationPort,RuntimeSettings,CaseService,CaseAtomicPort,ConnectionReadPort,PlatformQueryPort,ExecutionPort,EvidenceChannelControlPort,InvestigationProfilePort,ReportProposalPort,ReportCompletionPort,DeliveryService,SubscriptionAtomicPort,DatabasePort,EventPort -->
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

export interface CaseService {
  list(ctx: CallContext, input: { connectionId?: Id; text?: string; status?: CaseRecord['status']; page: PageRequest }): Promise<Result<{ items: CaseRecord[]; nextCursor?: string }>>;
  create(ctx: CallContext, input: { title: string; scope: Scope; seedRefs: EvidenceRef[] }): Promise<Result<CaseRecord>>;
  snapshot(ctx: CallContext, input: { caseId: Id; evidencePage: PageRequest }): Promise<Result<CaseSnapshot>>;
  evidence(ctx: CallContext, input: { caseId: Id; ref: EvidenceRef; projectionId?: Id }): Promise<Result<{ evidence: EvidenceRecord; projection?: EvidenceProjection }>>;
  setStatus(ctx: CallContext, input: { caseId: Id; expectedRevision: number; status: CaseRecord['status']; reason: string }): Promise<Result<CaseRecord>>;
  moveEvidence(ctx: CallContext, input: { sourceCaseId: Id; targetCaseId: Id; sourceRevision: number; targetRevision: number; refs: EvidenceRef[]; reason: string }): Promise<Result<{ sourceRevision: number; targetRevision: number }>>;
  putContext(ctx: CallContext, input: { caseId: Id; contextId?: Id; expectedRevision: number; context: Omit<BusinessContext, 'id' | 'version' | 'authorId'> }): Promise<Result<BusinessContext>>;
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

export interface AutoCandidate {
  id: Id; policyId: Id; policyEpoch: number; caseId: Id; alertIds: Id[];
  scope: Scope; question: string; firstReceivedAt: Instant; lastReceivedAt: Instant;
  coalesceUntil: Instant; expiresAt: Instant;
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

export interface BudgetReservation {
  id: Id; runId: Id; toolName: string; toolOrdinal: number; expiresAt: Instant;
  toolEpoch: number; identityEpoch: number; connectionGeneration: number;
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

export interface RequestAtomicPort {
  createAutoInTx(tx: WriteTx, ctx: CallContext, candidate: AutoCandidate): Result<RequestStatus>;
  cancelPolicyInTx(tx: WriteTx, ctx: CallContext, input: { policyId: Id; obsoleteEpoch: number }): Result<{ revokeRunIds: Id[] }>;
}

export interface RunBudgetPort {
  assertRunOpen(ctx: CallContext, runId: Id): Promise<Result<AnalysisRun>>;
  reservePlatformAttempt(ctx: CallContext, reservationId: Id): Promise<Result<void>>;
}

export interface RunBudgetAtomicPort {
  reserveToolInTx(tx: WriteTx, ctx: CallContext, input: { runId: Id; toolName: string; isRead: boolean }): Result<BudgetReservation>;
  assertRunOpenInTx(tx: WriteTx, ctx: CallContext, runId: Id): Result<AnalysisRun>;
  recordEventsInTx(tx: WriteTx, ctx: CallContext, input: { runId: Id; sourceKeys: string[] }): Result<void>;
}

export interface RetentionService {
  preview(ctx: CallContext, input: { caseIds: Id[]; olderThan: Instant }): Promise<Result<CleanupPlan>>;
  apply(ctx: CallContext, input: { planId: Id; expectedPlanHash: string }): Promise<Result<{ expiredVersions: number }>>;
}

export interface ReviewPublicationPort {
  publishReview(ctx: CallContext, input: { requestId: Id; reportId: Id; expectedCaseRevision: number; expectedResultVersion: number }): Promise<Result<ResultPackage>>;
}

export interface ChannelHandle {
  id: Id; runId: Id; transport: 'streamable-http' | 'stdio';
  endpoint?: string; secretRef: Id; expiresAt: Instant;
  state: 'pending' | 'active' | 'revoked';
}

export interface PreparedProfile {
  version: string; systemText: string; userText: string; allowedTools: string[];
  seedProjectionIds: Id[];
  contextRefs: ContextRef[];
}

export interface InvestigationProfileInput {
  run: AnalysisRun; initialInput: FrozenRunInput; seedProjections: EvidenceProjection[];
}

export interface ExecutionSnapshot {
  runId: Id; sessionId?: string; userMessageId?: string; resultMessageId?: string;
  phase: 'not_submitted' | 'submitted' | 'running' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
  verification: 'verified' | 'unverified'; observedAt: Instant;
  finishReason?: string; error?: AppError;
  usage?: { inputTokens?: number; outputTokens?: number; estimated: boolean; costKnown: boolean };
}

export interface HostReceipt { messageId: string; visible: boolean; observedAt: Instant }

export interface ExecutionPort {
  start(ctx: CallContext, input: { run: AnalysisRun; profile: PreparedProfile; channel: ChannelHandle }): Promise<Result<ExecutionSnapshot>>;
  inspect(ctx: CallContext, runId: Id): Promise<Result<ExecutionSnapshot>>;
  abort(ctx: CallContext, runId: Id): Promise<Result<ExecutionSnapshot>>;
}

export interface ToolInvocation {
  transportBindingId: Id; callId: string; toolName: string; arguments: JsonObject;
}

export interface ToolReply {
  isError: boolean; text: string; structured?: JsonObject;
  preparedProjectionIds: Id[];
}

export interface InvestigationStepInput {
  phase: 'orientation' | 'querying' | 'evaluating' | 'stopped';
  summary: string; purpose?: string; evidenceRefs: DeliveredRef[];
}

export interface EvidenceChannelPort {
  openChannel(ctx: CallContext, run: AnalysisRun): Promise<Result<ChannelHandle>>;
  bindChannel(ctx: CallContext, input: { channelId: Id; runId: Id; trustedSessionBindingId: Id }): Promise<Result<ChannelHandle>>;
  revoke(ctx: CallContext, runId: Id): Promise<Result<void>>;
  revokeAll(ctx: CallContext): Promise<Result<void>>;
}

export type EvidenceChannelControlPort = Pick<EvidenceChannelPort, 'openChannel' | 'revoke'>;

export interface InvestigationToolPort {
  invoke(ctx: CallContext, input: ToolInvocation): Promise<Result<ToolReply>>;
  acknowledgeReply(ctx: CallContext, input: { transportBindingId: Id; callId: string; outcome: 'released' | 'uncertain' }): Promise<Result<void>>;
}

export interface ToolReplyAtomicPort {
  expireRepliesInTx(tx: WriteTx, ctx: CallContext, input: { projectionIds: Id[] }): Result<void>;
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

export interface FollowupRecord extends FollowupDraft {
  id: Id; caseId: Id; reportId?: Id; revision: number;
  state: 'open' | 'waiting' | 'completed'; dueAt?: Instant;
  note?: string; evidenceRefs: EvidenceRef[];
}

export interface ReviewInput {
  reportId: Id; expectedCaseRevision: number;
  disposition: 'accepted' | 'revised' | 'rejected';
  humanConclusion: 'confirmed_attack' | 'confirmed_benign' | 'unknown';
  note: string; revisedCandidate?: ReportCandidate;
}

export interface ResultPackage {
  schemaVersion: '0.1.0'; requestId: Id; jobId: Id; caseId: Id; runId?: Id;
  resultVersion: number; terminalState: 'succeeded' | 'needs_review' | 'failed' | 'cancelled';
  review: ReportRecord['review']; summary: string; reportId?: Id;
  mainEvidence: ReportStatement[]; gaps: string[]; followups: FollowupDraft[];
  scope: Scope; error?: AppError;
}

export interface ResultContext {
  requestId: Id; jobId: Id; caseId: Id; runId?: Id; scope: Scope;
}

export interface CompletionDecision {
  terminalState: ResultPackage['terminalState']; reason: string; error?: AppError;
}

export interface ReportAssessment {
  reportId?: Id; validation: ReportRecord['validation'] | 'missing';
}

export interface ReportValidationInput {
  view: RunEvidenceView;
  contexts: { ref: ContextRef; context: BusinessContext }[];
}

export interface ReportService {
  prepare(ctx: CallContext, input: InvestigationProfileInput): Promise<Result<PreparedProfile>>;
  proposeInTx(tx: WriteTx, ctx: CallContext, input: { candidate: ReportCandidate; validationInput: ReportValidationInput }): Result<ReportRecord>;
  assessInTx(tx: WriteTx, ctx: CallContext, runId: Id): Result<ReportAssessment>;
  finalizeInTx(tx: WriteTx, ctx: CallContext, input: { run: AnalysisRun; context: ResultContext; decision: CompletionDecision; manifestHash: string; assessment: ReportAssessment }): Result<ResultPackage>;
  terminalWithoutRunInTx(tx: WriteTx, ctx: CallContext, input: { context: Omit<ResultContext, 'runId'>; decision: CompletionDecision }): Result<ResultPackage>;
  review(ctx: CallContext, input: ReviewInput): Promise<Result<ReportRecord>>;
  publishReviewedInTx(tx: WriteTx, ctx: CallContext, input: { context: ResultContext; reportId: Id; expectedCaseRevision: number; expectedResultVersion: number }): Result<ResultPackage>;
  list(ctx: CallContext, caseId: Id): Promise<Result<ReportRecord[]>>;
  followups(ctx: CallContext, caseId: Id): Promise<Result<FollowupRecord[]>>;
  searchFollowups(ctx: CallContext, input: { caseId?: Id; state?: FollowupRecord['state']; page: PageRequest }): Promise<Result<{ items: FollowupRecord[]; nextCursor?: string }>>;
  putFollowup(ctx: CallContext, input: { item: FollowupRecord; expectedRevision: number }): Promise<Result<FollowupRecord>>;
  export(ctx: CallContext, input: { caseId: Id; caseRevision: number; format: 'markdown' | 'json' }): Promise<Result<{ filename: string; mediaType: string; text: string }>>;
}

export type InvestigationProfilePort = Pick<ReportService, 'prepare'>;

export type ReportProposalPort = Pick<ReportService, 'proposeInTx'>;

export type ReportCompletionPort = Pick<ReportService, 'assessInTx' | 'finalizeInTx' | 'terminalWithoutRunInTx' | 'publishReviewedInTx'>;

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

export interface RuntimeSettings {
  revision: number; trayEnabled: boolean; budgetTimeZone: string;
  dailyTotalTokenLimit?: number; retentionDays?: number; evidenceMaxBytes?: number;
}
```
<!-- CONTRACT:END -->

## 本模块 SQL 映射附件

以下包含本模块表及外键依赖表的统一结构。仅本模块拥有的表可直接写入，其余表通过公开端口或同步 InTx 方法操作；不得自行改列名或状态。

<!-- SQL:BEGIN tables=investigation_requests,request_keys,request_events,deferred_inputs,jobs,analysis_runs,quota_ledger,tool_reservations,platform_attempts,run_event_keys,mcp_calls,investigation_steps -->
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
```
<!-- SQL:END -->
