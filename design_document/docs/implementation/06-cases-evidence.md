# S06 案件、证据、查询覆盖与业务背景

工程契约版本：0.2.0；修订日期：2026-10-23。状态：实现设计，未实现/未联调；业务基线仍为 v4.2。[修订记录](changes-0.2.0.md)。本模块不实现调查档案图、自动差异解释或局部重查。

## 1. 范围、依赖与装配

实现 `packages/core/cases/{cases,evidence,queries,context,projections,manifest,retention,repositories}.ts`。导出 CaseService 与内部 CaseAtomicPort，保存案件、不可变材料、人工背景、查询覆盖和实际交付内容。

固定导出 `createCaseService(deps):{service:CaseService;atomic:CaseAtomicPort}`，deps 只有 `db,events,clock,ids`。不得依赖 RequestService、RunBudgetPort、MCP、宿主或投递。预算、清理缓存和发布由 S07 应用用例协调；同一事务通过参数传入，不在构造时回调其他模块。

CaseService只承载用户案件操作和读取。project/release/seal/capture/清理等原语在CaseAtomicPort；S03清理入口调用S07 RetentionService。getInTx/snapshotInTx/inspectRunInTx接受ReadTx并返回核权视图，用于同快照导出和校验；recordChangeInTx用于人工审核推进case revision和审计。调用方不直接查S06私有表。

## 2. 证据身份与版本

索引源键为 `[platformInstanceId,'index',index,documentId]` 的规范 JSON 哈希；资源源键使用平台、resource、agentId、collectionIdentity。缺身份不得用数组位置或内容哈希伪造稳定事件身份。

同源、同内容且未过期时复用 evidenceId/version，另记 retrieval；内容变化或旧正文 expired 时建立新版本，不覆盖旧 fields。不同行为即使同文本也不合并。contentHash 只检测本地内容变化，不证明源记录真实。

材料类别区分 alert/authentication/inventory/fim/finding/human_context，模型草案不写成观测。observedAt 只取明确源时间，retrievedAt 是取得时间，缺扫描时间保留 unknown。业务说明默认 unverified，来源、目标、有效期和版本必须保存。

## 3. 案件与人工操作

create 校验 scope/seed 授权，revision=1、status=pending，无种子也可建案。list 按 updatedAt DESC/id DESC，limit<=50，关键词参数化并转义 LIKE 通配符。

状态允许 pending→investigating，investigating→pending/resolved，resolved→reopened，reopened→investigating/resolved；人工关闭须非空理由。模型完成不自动关闭案件。每次输入或人工决定变化以 CAS 推进 revision，失败返回 REVISION_CONFLICT，不覆盖重试。

S07 先调用 setStatusInTx 进入 investigating，再冻结返回 revision，避免启动动作使本轮立即过时。用户重新调查已关闭案件时先 reopened。

moveEvidence 同事务检查两案主体、连接及双 revision，移除/新增 link 并推进两案版本；保留旧 run 的历史证据。putContext 校验外层 caseId 与内层一致，作者来自 Actor，新增/修改及核实状态变化均保存版本；只影响范围相交的案件。

## 4. 查询保存与预算边界

captureInTx 只检查材料结构、来源、scope、case/run 关联和页身份，不计算预算。应用用例先在同一 WriteTx 用 S07 RunBudgetAtomicPort 检查 fence、预占新增源身份，再调用 captureInTx；任一步失败整笔回滚。初始化 seed 也遵循同一规则。S06 不读取 jobs、quota_ledger 或 mcp_grants。

queryId 标识逻辑查询，pageId/pageOrdinal 标识页；同页同哈希复用，同页不同响应 CONFLICT，保留旧页。保存证据版本、query_evidence 和 run_evidence。活动 run 的补证先只归本轮，结束时才按 baseRevision 尝试附案。

累计覆盖要求页序 0..N 连续且没有失败/截断，才能完整；collectionCoverage 仍单独描述采集覆盖。封存后的查询不更新，相同条件重查使用新 queryId。inventory/finding 不计事件身份预算，但占读取、字节和平台请求预算。

## 5. 冻结输入、投影与封存

initializeRunInTx验证case.baseRevision，接收S07确认的问题/能力，冻结种子和匹配背景，返回类型化FrozenRunInput。S07在analysis_runs保存initialInput并同事务处理种子事件预算。inspectRunInTx返回本轮证据投影和查询的RunEvidenceView；冻结背景和实际交付contextRefs由S07从自己的持久输入/PreparedProfile补入，S06不读analysis_runs内部JSON。

projectInTx 仅从 run_evidence 产生白名单字段投影并保存 prepared；releaseInTx 标记 released/uncertain。初始提示由 S08 核实实际提交内容，工具回复由 S09 观察发送结果，再交 S07 记录释放。prepared 不能作为报告有效引用；released 不证明模型理解内容。

sealInTx 接收 `{runId,metadata:RunManifestMetadata}`。S07 提供冻结初始输入、配置/映射版本、步骤和停止摘要；S06 汇总自己的证据、投影、查询覆盖并生成 manifestHash。metadata 必须是 S07 从持久记录汇总的不可变事实，不接受模型任意替换。S06 不跨表读取 S07/S09/S10 的内部记录。重复同内容封存返回原哈希，不同内容 CONFLICT。

applyRunInTx 仅在当前 revision==baseRevision 时附案并推进版本、设置 currentReportId/latestReportId；否则仅保留历史候选和 latestReportId，不覆盖 currentReportId。该次并入材料不会使该报告立即过时，后续真实输入变化才提示新材料未分析。

## 6. 留存与读取

仅知道 evidenceId 不产生读取权，必须关联当前案件或获准历史 run；projectionId 必须属于同 run/证据版本。离线材料保留取得时间，身份切换不能复用旧空间引用。

previewCleanupInTx 和 applyCleanupInTx 都接收 S07 在当前 WriteTx 读取的 protectedRunIds。S06 检查这些 run 的 run_evidence、其他未选择案件引用、caseRevision，生成 10min 有效计划和精确 planHash；apply 再核验保护集合与引用变化，冲突重新预览。保护集合取所有活动/uncertain 任务，不靠预览时快照延续清理权限。

apply 只使获准正文/投影 expired，返回 expiredVersions 与 projectionIds。S07 在同事务使工具回复缓存过期，失败整笔回滚。S06 不依赖 MCP 缓存端口，不发事件代替必须原子完成的清理。原哈希、定位与报告摘录保留，界面明确引用缺口；不影响上游或宿主历史，不宣称彻底删除全部副本或取证级防篡改。

## 7. 独立验收与交接

使用真实临时 SQLite 验证同源变化、同文本不同来源、缺时间、页冲突、覆盖累计、投影版本/释放、人工并发、拆案历史、封存幂等、清理计划变化、跨案拒绝。组合验收由 S07 证明 300 事件上限与 capture 同事务、清理与回复缓存同事务。

交付 Repository、service/atomic 两端口、输入清单格式、合成夹具与运行说明；不得为独立开发复制调度或 MCP 实现。[开发规范](../development/README.md)规定任务和共享文件流程。

## 8. 内嵌统一契约

<!-- CONTRACT:BEGIN roots=CaseService,CaseAtomicPort,RunManifestMetadata,DatabasePort,EventPort,EvidenceProjection,AnalysisRun -->
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

<!-- SQL:BEGIN tables=cases,case_changes,evidence_sources,evidence_versions,evidence_retrievals,evidence_links,business_context,context_versions,query_runs,query_pages,query_evidence,run_evidence,evidence_projections,cleanup_plans -->
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

CREATE TABLE cleanup_plans(
  id TEXT PRIMARY KEY, plan_hash TEXT NOT NULL, plan_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('preview','applied','expired')), expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
```
<!-- SQL:END -->
