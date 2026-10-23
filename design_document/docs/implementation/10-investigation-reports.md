# S10 调查配置、草案校验、人工核查与导出

工程契约版本：0.2.0；修订日期：2026-10-23。状态：实现设计，未实现/真实工具调查未验收；业务基线 v4.2。[修订记录](changes-0.2.0.md)。

## 1. 范围与职责

实现 `packages/investigation-profile/{profile,skill,prompt,manifest}.ts` 和 `packages/core/reports/{propose,validate,assess,finalize,review,followups,export,repositories}.ts`。固定导出 `createReportService(deps):ReportService`，deps 只有 db/events/clock/ids、cases:CaseReadPort、casesAtomic:CaseAtomicPort。

不依赖执行驱动、预算、请求服务、MCP或投递；不读 jobs/request_events。拥有 report_drafts/reviews/followups/response_notes/result_packages。内部将配置、校验、人工操作、导出分文件，调用者只注入 InvestigationProfilePort、ReportProposalPort、ReportCompletionPort 等所需窄端口。

S07 唯一决定任务终态；S10 assess 只评价草案，finalize 依显式 CompletionDecision 生成结果。显式发布人工修订由 S07 ReviewPublicationPort 协调，S10 不回调 S11。

## 2. 专用配置与 Skill

每run一新会话、一专用配置和调查Skill；初始配置候选 campussec-investigator/0.1.0。记录配置/Skill哈希、模板、工具清单与映射版本，文件存在不等于已加载。

默认拒绝通用Shell、文件浏览、任意网络、个人记忆写入、委派及非项目MCP；真实加载和拒绝行为要验证。未证明上下文隔离前仅合成/公开材料联调，不以关闭记忆整理证明旧记忆不注入。

prepare消费S07冻结的初始输入，只生成必要seedProjection、systemText/userText和contextRefs。S06的投影写入由S07协调准备阶段事务：先projectInTx，提交后把prepared种子及冻结背景交给配置组件；prepare不得在自己的事务里嵌套其他模块异步写。初始投影字段默认时间、设备、规则、必要摘要，不带秘密或完整配置；PreparedProfile只声明prepared，实际释放由S07核实S08交付事实。

Skill流程：确认问题/范围/能力/预算→阅读种子（无种子先初始搜索）→提出待验证解释并按purpose选择查询→阅读记录与coverage→检查支持/冲突/替代解释→有限回答、材料不可得、预算、取消或需扩大范围时停止并提交propose_report。不机械调全部工具，不输出私有思维链，不无限等待人工回答。

维护说明仅在目标、时间、来源和核实状态匹配时使用，不能自动消除冲突。缺权、失败、partial不能推导没有发生，账号namespace/name不一致不能强行关联。

## 3. 候选格式与引用校验

ReportCandidate固定facts/analysis/conflicts/gaps/classification/stopReason/followups。classification为needs_investigation/explained/insufficient_evidence；人工humanConclusion独立为confirmed_attack/confirmed_benign/unknown。

proposeInTx接收candidate和核心生成的ReportValidationInput，按run递增version；检schema/大小、case/run授权、范围、released投影/哈希、实际queryIds和冻结contextRefs。S07提供的view与背景来自当前事务证据和实际交付配置，工具模型不能传入该内部快照。零匹配/失败引用queryId，不虚造记录；跨轮、未交付字段和partial却完整排除都拒绝。

证据与输入索引通过S06公开读取/事务端口取得，S10不得直接查其私有表。结构和引用有效不证明语义正确；未知语义留人工。无效候选保留文字并标invalid/needs_review；valid仍unreviewed。

## 4. 评估与完成结果

assessInTx返回最新reportId及valid/invalid/needs_review/missing，不读取执行消息或决定任务成功。S07在同事务结合已核实执行、取消、期限与材料作CompletionDecision，再调用finalizeInTx，传入run、ResultContext、decision、manifestHash、assessment。

finalize仅核对context关联、封存摘要、assessment与当前候选一致，保存不可变ResultPackage。decision要求succeeded但候选不valid时返回VALIDATION_FAILED供协调者回滚修正，不自行换成另一终态。结果包与S07的job终态、S11 outbox在同事务提交。

terminalWithoutRunInTx接收无runId的ResultContext和decision，明确未启动；不能伪造会话或引用。曾建立run的取消保留真实runId。uncertain仍待核实不调用完成方法。相同request/resultVersion重复完成返回原包，内容不同CONFLICT，不重复创建核查事项。

summary<=2000字、mainEvidence<=5、gaps/followups各<=10，省略注明另有N项；完整本地报告保留。scope/审核/未知不可省略。S10不自动关案、不推进任务、不触发新轮次。

## 5. 人工审核与修订发布

review仅UI并核对expectedCaseRevision；accepted保存认可，revised新版本保留原文，rejected存理由。与S06.recordChangeInTx同事务推进案件revision和审计，返回后UI刷新当前版本；历史候选的认可不自动扩大覆盖。作者来自Actor，CAS冲突不覆盖。

publishReviewedInTx由S07显式发布用例调用，接收经核权的ResultContext/reportId/双expected版本，核对原结果与报告关联、审核状态和当前案件版本，再保存resultVersion+1。沿用原包已确定terminalState，标人工修订，不重新解释取消或执行；S07同事务enqueue原有效订阅，失败回滚。普通review保存不发送。

followup保存问题、建议动作、负责角色、open/waiting/completed、可空截止时间、人工备注与证据；新建expectedRevision=0，更新CAS。完成仅是人工记录，有观测依据另列source=observed，否则human_statement。searchFollowups支持本主体跨案筛选/分页，dueAt空最后、id升序，不把一页当总数。

## 6. 导出

export在同一ReadTx通过S06.snapshotInTx读取案件/背景/证据，并读自己的报告/审核/待办；不先后取两个异步快照。Markdown/JSON语义一致，JSON保留schemaVersion=0.1.0及定位/取得时间，不带秘密或跨案内容。

另导出`createResultPackageReader({db}):ResultPackageReadPort`，只读S10拥有的不可变结果包；S11先检查主体/订阅，再调用getInTx，不能直接查S10私表。不存在结果时返回RESULT_NOT_READY，不查询S07任务表。

返回filename/mediaType/text，不接受文件路径；S03系统保存对话框写入。Markdown转义不可信内容，禁自动外图，未审核标记不省略。

## 7. 独立验收与交接

覆盖无种子、零匹配/缺权/partial、身份不一致、旧/冲突维护说明、未交付/跨轮引用、结构valid仍需审核、missing候选、无run取消、重复完成、人工新版本及导出无秘密。特别验证S10未接收ExecutionSnapshot，不能读取JobState来决定取消；发布用例的outbox原子性由S07/S11组合验收。

真实模型另验两个材料分支改变后续查询或停止；fake预写报告只算数据流。交付Skill模板、校验/评估/保存、人工功能、合成夹具；判断图、自动差异和局部重查仍非本轮完成条件。

## 8. 内嵌统一契约

<!-- CONTRACT:BEGIN roots=ReportService,ReportCandidate,ReportRecord,ResultPackage,ResultPackageReadPort,ResultContext,CompletionDecision,ReportAssessment,CaseReadPort,CaseAtomicPort,PreparedProfile,DatabasePort,EventPort -->
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

export type CapabilityName = 'alerts' | 'archives' | 'authentication_events' | 'agents'
  | 'inventory_os' | 'inventory_hardware' | 'inventory_packages' | 'inventory_processes'
  | 'inventory_ports' | 'fim_objects' | 'fim_events' | 'sca' | 'vulnerabilities'
  | 'stable_alert_pagination';

export interface Capability {
  name: CapabilityName;
  state: 'available' | 'denied' | 'unreachable' | 'unsupported' | 'unverified';
  checkedAt: Instant; evidence: string; endpointKind: 'indexer' | 'server';
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

export type CaseReadPort = Pick<CaseService, 'snapshot' | 'evidence'>;

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

export type RequestState = 'awaiting_scope' | 'accepted' | 'rejected' | 'withdrawn';

export type JobState = 'coalescing' | 'queued' | 'preparing' | 'submitting' | 'running'
  | 'verifying' | 'succeeded' | 'needs_review' | 'failed'
  | 'cancel_requested' | 'cancelled' | 'uncertain';

export interface AnalysisRun {
  id: Id; jobId: Id; caseId: Id; baseRevision: number; scope: Scope;
  connectionGeneration: number; identityEpoch: number; profileVersion: string;
  toolEpoch: number; expiresAt: Instant; manifestHash?: string;
}

export interface PreparedProfile {
  version: string; systemText: string; userText: string; allowedTools: string[];
  seedProjectionIds: Id[];
  contextRefs: ContextRef[];
}

export interface InvestigationProfileInput {
  run: AnalysisRun; initialInput: FrozenRunInput; seedProjections: EvidenceProjection[];
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

export interface ResultPackageReadPort {
  getInTx(tx: ReadTx, ctx: CallContext, input: { requestId: Id; resultVersion?: number }): Result<ResultPackage>;
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

<!-- SQL:BEGIN tables=report_drafts,reviews,followups,response_notes,result_packages -->
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
```
<!-- SQL:END -->
