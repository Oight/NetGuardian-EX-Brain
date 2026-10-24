/**
 * 校安智脑子系统设计契约 0.2.0（2026-10-23；设计附件，不是已实现 SDK）。
 * 名称、字段、枚举是本设计包的统一接口；业务基线仍为 v4.2。
 * 不依赖 Electron、数据库驱动、MCP SDK、UI 框架或真实平台凭据。
 * 实现时按领域文件组织，统一导出等价声明并补运行时 schema，禁止模块复制类型。
 */

export type Id = string;
export const ENGINEERING_CONTRACT_VERSION = "0.2.0" as const;
export const WIRE_SCHEMA_VERSION = "0.1.0" as const;
export type Instant = string;
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type ErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "REVISION_CONFLICT"
  | "NEEDS_INPUT"
  | "QUEUE_FULL"
  | "SCOPE_EXCEEDED"
  | "CAPABILITY_UNAVAILABLE"
  | "HOST_UNAVAILABLE"
  | "BUDGET_EXHAUSTED"
  | "EXPIRED"
  | "CANCELLED"
  | "UNCERTAIN"
  | "UPSTREAM_AUTH"
  | "UPSTREAM_DENIED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "TLS_UNTRUSTED"
  | "PARTIAL_RESULT"
  | "CURSOR_INVALID"
  | "RESULT_NOT_READY"
  | "VALIDATION_FAILED"
  | "SECRET_STORE_UNAVAILABLE"
  | "IDENTITY_CHANGED"
  | "STORAGE_UNAVAILABLE"
  | "INTERNAL";
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
  role: "ui" | "system" | "delegation" | "evidence";
  originBindingId?: Id;
  runId?: Id;
}
export interface CallContext {
  actor: Actor;
  traceId: Id;
}
export interface ClockPort {
  now(): Instant;
  monotonicMs(): number;
}
export interface IdPort {
  next(): Id;
}
export const DEFAULT_LIMITS = {
  activeInvestigations: 1,
  queueCapacity: 20,
  maxRunAgents: 5,
  maxRunWindowMs: 3600000,
  requestTtlMs: 900000,
  autoQueueTtlMs: 900000,
  runTtlMs: 300000,
  queryTimeoutMs: 10000,
  toolCalls: 12,
  readCalls: 10,
  platformAttempts: 20,
  distinctEvents: 300,
  toolTextBytes: 16384,
  platformConcurrency: 2,
  pageSize: 50,
  maxPages: 4,
  watchIntervalMs: 10000,
  watchOverlapMs: 30000,
  recoveryWindowMs: 1800000,
  coalesceMs: 10000,
  candidateMaxSpanMs: 1800000,
  candidateIdleMs: 600000,
  autoDailyAttempts: 10,
  questionChars: 2000,
  noteChars: 8000,
  idempotencyChars: 128,
} as const;
export interface PageRequest {
  cursor?: string;
  limit: number;
}
export interface Count {
  value: number;
  relation: "eq" | "gte";
}
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
  queryCompleteness: "complete" | "partial" | "not_executed";
  collectionCoverage: "known" | "partial" | "unknown";
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
  write<T>(
    ctx: CallContext,
    work: (tx: WriteTx) => Result<T>,
  ): Promise<Result<T>>;
}
export interface SecretPort {
  put(input: {
    owner: Id;
    purpose: string;
    value: Uint8Array;
    persist: boolean;
  }): Promise<Result<Id>>;
  use<T>(
    ref: Id,
    purpose: string,
    work: (value: Uint8Array) => Promise<T>,
  ): Promise<Result<T>>;
  remove(ref: Id): Promise<Result<void>>;
}
export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  bodyText?: string;
  timeoutMs: number;
  signal: AbortSignal;
  caPem?: string;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}
export interface HttpPort {
  request(input: HttpRequest): Promise<Result<HttpResponse>>;
}

export interface ConnectionProfile {
  id: Id;
  spaceId: Id;
  platformInstanceId: Id;
  displayName: string;
  generation: number;
  indexerBaseUrl?: string;
  serverBaseUrl?: string;
  indexerSecretRef?: Id;
  serverSecretRef?: Id;
  caRef?: Id;
  alertsPattern: string;
  archivesPattern?: string;
  mappingVersion: string;
  principalFingerprint: string;
  updatedAt: Instant;
}
export type CapabilityName =
  | "alerts"
  | "archives"
  | "authentication_events"
  | "agents"
  | "inventory_os"
  | "inventory_hardware"
  | "inventory_packages"
  | "inventory_processes"
  | "inventory_ports"
  | "fim_objects"
  | "fim_events"
  | "sca"
  | "vulnerabilities"
  | "stable_alert_pagination";
export interface Capability {
  name: CapabilityName;
  state: "available" | "denied" | "unreachable" | "unsupported" | "unverified";
  checkedAt: Instant;
  evidence: string;
  endpointKind: "indexer" | "server";
}
export interface AgentSummary {
  id: string;
  name?: string;
  status?: string;
  version?: string;
}
export interface DeviceDetailInput {
  connectionId: Id;
  agentId: string;
  category:
    | "os"
    | "hardware"
    | "packages"
    | "processes"
    | "ports"
    | "fim_objects"
    | "sca";
  page: PageRequest;
}
export interface DeviceDetail {
  agentId: string;
  category: DeviceDetailInput["category"];
  items: SourceRecord[];
  nextCursor?: string;
  total?: Count;
  retrievedAt: Instant;
  status: "ok" | "partial" | "denied" | "unavailable" | "failed";
  warnings: string[];
}
export interface AlertFilter {
  ruleIds?: string[];
  ruleGroups?: string[];
  minLevel?: number;
}
export type PlatformQuery =
  | {
      kind: "alerts";
      scope: Scope;
      filter: AlertFilter;
      page: PageRequest;
      fixedUpper: Instant;
    }
  | {
      kind: "authentication";
      scope: Scope;
      outcome: "success" | "failure" | "any";
      account?: { namespace: string; name: string };
      sourceIp?: string;
      page: PageRequest;
    }
  | {
      kind: "inventory";
      scope: Scope;
      category: "os" | "hardware" | "packages" | "processes" | "ports";
      page: PageRequest;
    }
  | {
      kind: "file_changes";
      scope: Scope;
      pathEquals?: string;
      page: PageRequest;
    }
  | {
      kind: "findings";
      scope: Scope;
      category: "sca" | "vulnerabilities";
      page: PageRequest;
    };
export interface SourceLocator {
  platformInstanceId: Id;
  kind: "index_document" | "resource";
  index?: string;
  documentId?: string;
  resource?: string;
  agentId?: string;
  collectionIdentity?: string;
}
export interface SourceRecord {
  source: SourceLocator;
  kind: "alert" | "authentication" | "inventory" | "fim" | "finding";
  agentId?: string;
  observedAt?: Instant;
  timeQuality: "source" | "ambiguous" | "unknown";
  retrievedAt: Instant;
  fields: JsonObject;
}
export interface PlatformPage {
  status: "ok" | "partial" | "denied" | "unavailable" | "failed";
  queryId: Id;
  pageId: Id;
  pageOrdinal: number;
  records: SourceRecord[];
  coverage: Coverage;
  nextCursor?: string;
  warnings: string[];
  platformAttempts: number;
}
export interface AlertStatistics {
  scope: Scope;
  total: Count;
  byLevel: { level: number; count: number }[];
  byHour: { start: Instant; count: number }[];
  coverage: Coverage;
}
export interface PlatformCall {
  runId?: Id;
  beforeAttempt: () => Promise<Result<void>>;
  signal: AbortSignal;
}
export interface ConnectionService {
  list(ctx: CallContext): Promise<Result<ConnectionProfile[]>>;
  save(
    ctx: CallContext,
    input: Omit<ConnectionProfile, "generation" | "updatedAt"> & {
      expectedGeneration?: number;
    },
  ): Promise<Result<ConnectionProfile>>;
  capabilities(
    ctx: CallContext,
    connectionId: Id,
    refresh: boolean,
  ): Promise<Result<Capability[]>>;
  agents(
    ctx: CallContext,
    input: { connectionId: Id; page: PageRequest },
  ): Promise<
    Result<{ items: AgentSummary[]; nextCursor?: string; total?: Count }>
  >;
  deviceDetail(
    ctx: CallContext,
    input: DeviceDetailInput,
    call: PlatformCall,
  ): Promise<Result<DeviceDetail>>;
  query(
    ctx: CallContext,
    input: PlatformQuery,
    call: PlatformCall,
  ): Promise<Result<PlatformPage>>;
  statistics(
    ctx: CallContext,
    scope: Scope,
    call: PlatformCall,
  ): Promise<Result<AlertStatistics>>;
}
export type PlatformQueryPort = Pick<ConnectionService, "query">;
export type ConnectionReadPort = Pick<
  ConnectionService,
  "list" | "capabilities" | "agents"
>;

export interface EvidenceRef {
  evidenceId: Id;
  version: number;
}
export interface ContextRef {
  contextId: Id;
  version: number;
}
export interface DeliveredRef extends EvidenceRef {
  projectionId: Id;
}
export interface EvidenceRecord {
  id: Id;
  spaceId: Id;
  connectionId: Id;
  version: number;
  source: SourceLocator;
  kind: SourceRecord["kind"] | "human_context";
  observedAt?: Instant;
  timeQuality: SourceRecord["timeQuality"];
  retrievedAt: Instant;
  contentHash: string;
  fields: JsonObject;
  availability: "available" | "expired";
}
export interface EvidenceProjection {
  id: Id;
  runId: Id;
  ref: EvidenceRef;
  content: JsonObject;
  contentHash: string;
  state: "prepared" | "released" | "uncertain";
  preparedAt: Instant;
  releasedAt?: Instant;
  availability: "available" | "expired";
}
export interface CaseRecord {
  id: Id;
  spaceId: Id;
  revision: number;
  title: string;
  scope: Scope;
  status: "pending" | "investigating" | "resolved" | "reopened";
  currentReportId?: Id;
  latestReportId?: Id;
  createdAt: Instant;
  updatedAt: Instant;
}
export interface BusinessContext {
  id: Id;
  caseId?: Id;
  connectionId: Id;
  agentIds: string[];
  version: number;
  text: string;
  department?: string;
  purpose?: string;
  from: Instant;
  to: Instant;
  sourceLabel: string;
  verification: "unverified" | "verified" | "rejected";
  authorId: Id;
}
export interface CaseSnapshot {
  case: CaseRecord;
  evidence: EvidenceRecord[];
  contexts: BusinessContext[];
  queries: { queryId: Id; coverage: Coverage }[];
  nextEvidenceCursor?: string;
}
export interface QueryCapture {
  runId?: Id;
  caseId?: Id;
  connectionId: Id;
  query: PlatformQuery;
  page: PlatformPage;
}
export interface CleanupPlan {
  id: Id;
  planHash: string;
  expiresAt: Instant;
  caseIds: Id[];
  caseRevisions: { caseId: Id; revision: number }[];
  removableVersions: number;
  blockedVersions: number;
  approximateBytes: number;
}
export interface CaseService {
  list(
    ctx: CallContext,
    input: {
      connectionId?: Id;
      text?: string;
      status?: CaseRecord["status"];
      page: PageRequest;
    },
  ): Promise<Result<{ items: CaseRecord[]; nextCursor?: string }>>;
  create(
    ctx: CallContext,
    input: { title: string; scope: Scope; seedRefs: EvidenceRef[] },
  ): Promise<Result<CaseRecord>>;
  snapshot(
    ctx: CallContext,
    input: { caseId: Id; evidencePage: PageRequest },
  ): Promise<Result<CaseSnapshot>>;
  evidence(
    ctx: CallContext,
    input: { caseId: Id; ref: EvidenceRef; projectionId?: Id },
  ): Promise<
    Result<{ evidence: EvidenceRecord; projection?: EvidenceProjection }>
  >;
  setStatus(
    ctx: CallContext,
    input: {
      caseId: Id;
      expectedRevision: number;
      status: CaseRecord["status"];
      reason: string;
    },
  ): Promise<Result<CaseRecord>>;
  moveEvidence(
    ctx: CallContext,
    input: {
      sourceCaseId: Id;
      targetCaseId: Id;
      sourceRevision: number;
      targetRevision: number;
      refs: EvidenceRef[];
      reason: string;
    },
  ): Promise<Result<{ sourceRevision: number; targetRevision: number }>>;
  putContext(
    ctx: CallContext,
    input: {
      caseId: Id;
      contextId?: Id;
      expectedRevision: number;
      context: Omit<BusinessContext, "id" | "version" | "authorId">;
    },
  ): Promise<Result<BusinessContext>>;
}
export type CaseReadPort = Pick<CaseService, "snapshot" | "evidence">;
export interface FrozenRunInput {
  question: string;
  scope: Scope;
  seedRefs: EvidenceRef[];
  contexts: BusinessContext[];
  capabilities: Capability[];
}
export interface RunEvidenceView {
  runId: Id;
  caseId: Id;
  scope: Scope;
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
  snapshotInTx(
    tx: ReadTx,
    ctx: CallContext,
    input: { caseId: Id; evidencePage: PageRequest },
  ): Result<CaseSnapshot>;
  recordChangeInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { caseId: Id; expectedRevision: number; reason: string },
  ): Result<number>;
  createInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { title: string; scope: Scope; seedRefs: EvidenceRef[] },
  ): Result<CaseRecord>;
  setStatusInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: {
      caseId: Id;
      expectedRevision: number;
      status: CaseRecord["status"];
      reason: string;
    },
  ): Result<CaseRecord>;
  captureInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: QueryCapture,
  ): Result<EvidenceRef[]>;
  initializeRunInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: {
      run: AnalysisRun;
      seedRefs: EvidenceRef[];
      question: string;
      capabilities: Capability[];
    },
  ): Result<FrozenRunInput>;
  inspectRunInTx(
    tx: ReadTx,
    ctx: CallContext,
    run: AnalysisRun,
  ): Result<RunEvidenceView>;
  attachInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: {
      caseId: Id;
      refs: EvidenceRef[];
      expectedRevision: number;
      reason: string;
    },
  ): Result<number>;
  projectInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { runId: Id; refs: EvidenceRef[]; fieldNames: string[] },
  ): Result<EvidenceProjection[]>;
  releaseInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: {
      runId: Id;
      projectionIds: Id[];
      outcome: "released" | "uncertain";
    },
  ): Result<void>;
  sealInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { runId: Id; metadata: RunManifestMetadata },
  ): Result<{ manifestHash: string; refs: DeliveredRef[] }>;
  applyRunInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { run: AnalysisRun; reportId: Id },
  ): Result<{ applied: boolean; revision: number }>;
  previewCleanupInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { caseIds: Id[]; olderThan: Instant; protectedRunIds: Id[] },
  ): Result<CleanupPlan>;
  applyCleanupInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { planId: Id; expectedPlanHash: string; protectedRunIds: Id[] },
  ): Result<{ expiredVersions: number; projectionIds: Id[] }>;
}

export interface InboxAlert {
  id: Id;
  connectionId: Id;
  sourceKey: string;
  receiveSeq: number;
  kind: "realtime" | "history" | "recovery";
  evidence: EvidenceRef;
  agentId?: string;
  ruleId?: string;
  ruleGroups: string[];
  level?: number;
  observedAt?: Instant;
  receivedAt: Instant;
  read: boolean;
  decisionReason: string;
}
export interface TriggerPolicy {
  id: Id;
  connectionId: Id;
  revision: number;
  epoch: number;
  enabled: boolean;
  agentIds: string[];
  filter: AlertFilter;
  enabledAfterReceiveSeq: number;
  dailyAttemptLimit: number;
  timeZone: string;
  dailyTokenLimit?: number;
}
export interface AutoCandidate {
  id: Id;
  policyId: Id;
  policyEpoch: number;
  caseId: Id;
  alertIds: Id[];
  scope: Scope;
  question: string;
  firstReceivedAt: Instant;
  lastReceivedAt: Instant;
  coalesceUntil: Instant;
  expiresAt: Instant;
}
export interface AlertService {
  pollOnce(
    ctx: CallContext,
    connectionId: Id,
  ): Promise<Result<{ inserted: number; complete: boolean }>>;
  list(
    ctx: CallContext,
    input: {
      connectionId: Id;
      page: PageRequest;
      scope?: Scope;
      filter?: AlertFilter;
      read?: boolean;
    },
  ): Promise<Result<{ items: InboxAlert[]; nextCursor?: string }>>;
  markRead(ctx: CallContext, alertIds: Id[]): Promise<Result<void>>;
  setPolicy(
    ctx: CallContext,
    input: { expectedRevision: number; policy: TriggerPolicy },
  ): Promise<Result<TriggerPolicy>>;
  flushCandidates(ctx: CallContext): Promise<Result<number>>;
}
export interface NotificationPort {
  show(input: {
    notificationId: Id;
    title: string;
    body: string;
    alertIds: Id[];
  }): Promise<Result<{ shown: boolean }>>;
}

export type Origin = "alert_auto" | "client_user" | "teleagent_user";
export type RequestState =
  "awaiting_scope" | "accepted" | "rejected" | "withdrawn";
export type JobState =
  | "coalescing"
  | "queued"
  | "preparing"
  | "submitting"
  | "running"
  | "verifying"
  | "succeeded"
  | "needs_review"
  | "failed"
  | "cancel_requested"
  | "cancelled"
  | "uncertain";
export interface CreateRequest {
  origin: Origin;
  connectionId: Id;
  question: string;
  requestedScope?: Scope;
  seedRefs: EvidenceRef[];
  caseId?: Id;
  idempotencyKey: string;
  originBindingId?: Id;
  autoCandidateId?: Id;
}
export interface InvestigationRequest {
  id: Id;
  origin: Origin;
  state: RequestState;
  connectionId: Id;
  question: string;
  requestedScope?: Scope;
  effectiveScope?: Scope;
  seedRefs: EvidenceRef[];
  caseId?: Id;
  jobId?: Id;
  originBindingId?: Id;
  autoCandidateId?: Id;
  missingFields: string[];
  createdAt: Instant;
  expiresAt: Instant;
}
export interface AnalysisRun {
  id: Id;
  jobId: Id;
  caseId: Id;
  baseRevision: number;
  scope: Scope;
  connectionGeneration: number;
  identityEpoch: number;
  profileVersion: string;
  toolEpoch: number;
  expiresAt: Instant;
  manifestHash?: string;
}
export interface JobRecord {
  id: Id;
  requestId: Id;
  caseId: Id;
  runId?: Id;
  origin: Origin;
  state: JobState;
  revision: number;
  createdAt: Instant;
  updatedAt: Instant;
  expiresAt: Instant;
  recoveryHold: boolean;
  policyId?: Id;
  policyEpoch?: number;
  error?: AppError;
}
export interface BudgetReservation {
  id: Id;
  runId: Id;
  toolName: string;
  toolOrdinal: number;
  expiresAt: Instant;
  toolEpoch: number;
  identityEpoch: number;
  connectionGeneration: number;
}
export interface BudgetState {
  runId: Id;
  toolsUsed: number;
  readsUsed: number;
  platformAttempts: number;
  distinctEvents: number;
  deadline: Instant;
  closed: boolean;
}
export interface RequestStatus {
  request: InvestigationRequest;
  job?: JobRecord;
  budget?: BudgetState;
  deliveryState?: DeliveryState;
  subscriptionCancelled?: boolean;
}
export interface RunSnapshot {
  run: AnalysisRun;
  job: JobRecord;
  steps: {
    id: Id;
    phase: string;
    summary: string;
    purpose?: string;
    createdAt: Instant;
  }[];
  report?: ReportRecord;
  budget: BudgetState;
}
export interface RequestService {
  create(
    ctx: CallContext,
    input: CreateRequest,
  ): Promise<Result<RequestStatus>>;
  provideInput(
    ctx: CallContext,
    input: {
      requestId: Id;
      scope?: Scope;
      text?: string;
      idempotencyKey: string;
    },
  ): Promise<Result<RequestStatus>>;
  status(ctx: CallContext, requestId: Id): Promise<Result<RequestStatus>>;
  runSnapshot(ctx: CallContext, runId: Id): Promise<Result<RunSnapshot>>;
  cancel(
    ctx: CallContext,
    input: { requestId: Id; reason: string },
  ): Promise<Result<RequestStatus>>;
  resume(
    ctx: CallContext,
    input: { requestId: Id; expectedJobRevision: number },
  ): Promise<Result<RequestStatus>>;
  abandon(
    ctx: CallContext,
    input: { requestId: Id; expectedJobRevision: number; reason: string },
  ): Promise<Result<RequestStatus>>;
  reconcile(
    ctx: CallContext,
    input: { requestId: Id; expectedJobRevision: number },
  ): Promise<Result<RequestStatus>>;
  tick(ctx: CallContext): Promise<Result<{ startedJobId?: Id }>>;
}
export interface RequestAtomicPort {
  createAutoInTx(
    tx: WriteTx,
    ctx: CallContext,
    candidate: AutoCandidate,
  ): Result<RequestStatus>;
  cancelPolicyInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { policyId: Id; obsoleteEpoch: number },
  ): Result<{ revokeRunIds: Id[] }>;
}
export type RequestCommandPort = Pick<
  RequestService,
  "create" | "provideInput" | "cancel"
>;
export type RequestReadPort = Pick<RequestService, "status">;
export interface RunBudgetPort {
  assertRunOpen(ctx: CallContext, runId: Id): Promise<Result<AnalysisRun>>;
  reservePlatformAttempt(
    ctx: CallContext,
    reservationId: Id,
  ): Promise<Result<void>>;
}
export interface RunBudgetAtomicPort {
  reserveToolInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { runId: Id; toolName: string; isRead: boolean },
  ): Result<BudgetReservation>;
  assertRunOpenInTx(
    tx: WriteTx,
    ctx: CallContext,
    runId: Id,
  ): Result<AnalysisRun>;
  recordEventsInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { runId: Id; sourceKeys: string[] },
  ): Result<void>;
}
export interface RetentionService {
  preview(
    ctx: CallContext,
    input: { caseIds: Id[]; olderThan: Instant },
  ): Promise<Result<CleanupPlan>>;
  apply(
    ctx: CallContext,
    input: { planId: Id; expectedPlanHash: string },
  ): Promise<Result<{ expiredVersions: number }>>;
}
export interface ReviewPublicationPort {
  publishReview(
    ctx: CallContext,
    input: {
      requestId: Id;
      reportId: Id;
      expectedCaseRevision: number;
      expectedResultVersion: number;
    },
  ): Promise<Result<ResultPackage>>;
}

export interface HostCapability {
  name:
    | "signedApi"
    | "dedicatedProfile"
    | "isolatedEvidenceChannel"
    | "trustedOrigin"
    | "asyncDelivery"
    | "deliveryReconcile";
  state: "available" | "unavailable" | "unverified";
  version: string;
  checkedAt: Instant;
  evidence: string;
}
export interface OriginBinding {
  id: Id;
  spaceId: Id;
  principalId: Id;
  hostId: Id;
  hostAccountId: Id;
  workspaceId: Id;
  sessionId: string;
  requestMessageId: string;
  state: "active" | "revoked" | "expired";
  createdAt: Instant;
  expiresAt: Instant;
}
export interface ChannelHandle {
  id: Id;
  runId: Id;
  transport: "streamable-http" | "stdio";
  endpoint?: string;
  secretRef: Id;
  expiresAt: Instant;
  state: "pending" | "active" | "revoked";
}
export interface PreparedProfile {
  version: string;
  systemText: string;
  userText: string;
  allowedTools: string[];
  seedProjectionIds: Id[];
  contextRefs: ContextRef[];
}
export interface InvestigationProfileInput {
  run: AnalysisRun;
  initialInput: FrozenRunInput;
  seedProjections: EvidenceProjection[];
}
export interface ExecutionSnapshot {
  runId: Id;
  sessionId?: string;
  userMessageId?: string;
  resultMessageId?: string;
  phase:
    | "not_submitted"
    | "submitted"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "uncertain";
  verification: "verified" | "unverified";
  observedAt: Instant;
  finishReason?: string;
  error?: AppError;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    estimated: boolean;
    costKnown: boolean;
  };
}
export interface HostReceipt {
  messageId: string;
  visible: boolean;
  observedAt: Instant;
}
export interface HostMessage {
  kind: "external_investigation_result";
  mediaType: "application/json";
  text: string;
}
export interface HostCapabilitiesPort {
  capabilities(ctx: CallContext): Promise<Result<HostCapability[]>>;
}
export interface TrustedOriginPort {
  resolveOrigin(
    ctx: CallContext,
    trustedTransportBindingId: Id,
  ): Promise<Result<OriginBinding>>;
}
export interface HostDeliveryPort {
  binding(ctx: CallContext, bindingId: Id): Promise<Result<OriginBinding>>;
  deliver(
    ctx: CallContext,
    input: {
      binding: OriginBinding;
      deliveryKey: string;
      message: HostMessage;
    },
  ): Promise<Result<HostReceipt>>;
  reconcileDelivery(
    ctx: CallContext,
    input: { binding: OriginBinding; deliveryKey: string },
  ): Promise<
    Result<{ state: "found" | "absent" | "unknown"; receipt?: HostReceipt }>
  >;
}
export interface HostAccessPort
  extends HostCapabilitiesPort, TrustedOriginPort, HostDeliveryPort {}
export interface ExecutionPort {
  start(
    ctx: CallContext,
    input: {
      run: AnalysisRun;
      profile: PreparedProfile;
      channel: ChannelHandle;
    },
  ): Promise<Result<ExecutionSnapshot>>;
  inspect(ctx: CallContext, runId: Id): Promise<Result<ExecutionSnapshot>>;
  abort(ctx: CallContext, runId: Id): Promise<Result<ExecutionSnapshot>>;
}
export interface ToolInvocation {
  transportBindingId: Id;
  callId: string;
  toolName: string;
  arguments: JsonObject;
}
export interface ToolReply {
  isError: boolean;
  text: string;
  structured?: JsonObject;
  preparedProjectionIds: Id[];
}
export interface EvidenceToolEnvelope {
  schemaVersion: "0.1.0";
  status: PlatformPage["status"];
  queryId?: Id;
  records: { ref: DeliveredRef; content: JsonObject }[];
  coverage?: Coverage;
  nextCursor?: string;
  budget: BudgetState;
  warnings: string[];
  context?: {
    question: string;
    scope: Scope;
    capabilities: Capability[];
    backgrounds: { ref: ContextRef; context: BusinessContext }[];
  };
}
export interface ControlToolEnvelope {
  schemaVersion: "0.1.0";
  status: "ok" | "needs_input" | "failed";
  data: JsonObject;
  budget?: BudgetState;
  warnings: string[];
}
export interface InvestigationStepInput {
  phase: "orientation" | "querying" | "evaluating" | "stopped";
  summary: string;
  purpose?: string;
  evidenceRefs: DeliveredRef[];
}
export interface McpGatewayPort {
  start(ctx: CallContext): Promise<Result<{ endpoint?: string }>>;
  stop(ctx: CallContext): Promise<Result<void>>;
  invoke(ctx: CallContext, input: ToolInvocation): Promise<Result<ToolReply>>;
}
export interface EvidenceChannelPort {
  openChannel(
    ctx: CallContext,
    run: AnalysisRun,
  ): Promise<Result<ChannelHandle>>;
  bindChannel(
    ctx: CallContext,
    input: { channelId: Id; runId: Id; trustedSessionBindingId: Id },
  ): Promise<Result<ChannelHandle>>;
  revoke(ctx: CallContext, runId: Id): Promise<Result<void>>;
  revokeAll(ctx: CallContext): Promise<Result<void>>;
}
export type EvidenceChannelBindingPort = Pick<
  EvidenceChannelPort,
  "bindChannel"
>;
export type EvidenceChannelControlPort = Pick<
  EvidenceChannelPort,
  "openChannel" | "revoke"
>;
export interface InvestigationToolPort {
  invoke(ctx: CallContext, input: ToolInvocation): Promise<Result<ToolReply>>;
  acknowledgeReply(
    ctx: CallContext,
    input: {
      transportBindingId: Id;
      callId: string;
      outcome: "released" | "uncertain";
    },
  ): Promise<Result<void>>;
}
export interface ToolReplyAtomicPort {
  expireRepliesInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { projectionIds: Id[] },
  ): Result<void>;
}

export type StopReason =
  | "answered_with_limits"
  | "evidence_unavailable"
  | "budget_exhausted"
  | "user_cancelled"
  | "execution_failed"
  | "scope_expansion_needed";
export interface ReportStatement {
  text: string;
  evidenceRefs: DeliveredRef[];
  queryIds: Id[];
  contextRefs: ContextRef[];
}
export interface FollowupDraft {
  question: string;
  suggestedAction: string;
  responsibleRole?: string;
}
export interface ReportCandidate {
  caseId: Id;
  runId: Id;
  question: string;
  facts: ReportStatement[];
  analysis: ReportStatement[];
  conflicts: ReportStatement[];
  gaps: string[];
  classification: "needs_investigation" | "explained" | "insufficient_evidence";
  stopReason: StopReason;
  followups: FollowupDraft[];
}
export interface ReportRecord {
  id: Id;
  caseId: Id;
  runId: Id;
  version: number;
  baseRevision: number;
  candidate: ReportCandidate;
  validation: "valid" | "invalid" | "needs_review";
  review: "unreviewed" | "accepted" | "revised" | "rejected";
  validationIssues: string[];
  createdAt: Instant;
}
export interface FollowupRecord extends FollowupDraft {
  id: Id;
  caseId: Id;
  reportId?: Id;
  revision: number;
  state: "open" | "waiting" | "completed";
  dueAt?: Instant;
  note?: string;
  evidenceRefs: EvidenceRef[];
}
export interface ReviewInput {
  reportId: Id;
  expectedCaseRevision: number;
  disposition: "accepted" | "revised" | "rejected";
  humanConclusion: "confirmed_attack" | "confirmed_benign" | "unknown";
  note: string;
  revisedCandidate?: ReportCandidate;
}
export interface ResultPackage {
  schemaVersion: "0.1.0";
  requestId: Id;
  jobId: Id;
  caseId: Id;
  runId?: Id;
  resultVersion: number;
  terminalState: "succeeded" | "needs_review" | "failed" | "cancelled";
  review: ReportRecord["review"];
  summary: string;
  reportId?: Id;
  mainEvidence: ReportStatement[];
  gaps: string[];
  followups: FollowupDraft[];
  scope: Scope;
  error?: AppError;
}
export interface ResultContext {
  requestId: Id;
  jobId: Id;
  caseId: Id;
  runId?: Id;
  scope: Scope;
}
export interface CompletionDecision {
  terminalState: ResultPackage["terminalState"];
  reason: string;
  error?: AppError;
}
export interface ReportAssessment {
  reportId?: Id;
  validation: ReportRecord["validation"] | "missing";
}
export interface ReportValidationInput {
  view: RunEvidenceView;
  contexts: { ref: ContextRef; context: BusinessContext }[];
}
export interface ReportService {
  prepare(
    ctx: CallContext,
    input: InvestigationProfileInput,
  ): Promise<Result<PreparedProfile>>;
  proposeInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: {
      candidate: ReportCandidate;
      validationInput: ReportValidationInput;
    },
  ): Result<ReportRecord>;
  assessInTx(
    tx: WriteTx,
    ctx: CallContext,
    runId: Id,
  ): Result<ReportAssessment>;
  finalizeInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: {
      run: AnalysisRun;
      context: ResultContext;
      decision: CompletionDecision;
      manifestHash: string;
      assessment: ReportAssessment;
    },
  ): Result<ResultPackage>;
  terminalWithoutRunInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: {
      context: Omit<ResultContext, "runId">;
      decision: CompletionDecision;
    },
  ): Result<ResultPackage>;
  review(ctx: CallContext, input: ReviewInput): Promise<Result<ReportRecord>>;
  publishReviewedInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: {
      context: ResultContext;
      reportId: Id;
      expectedCaseRevision: number;
      expectedResultVersion: number;
    },
  ): Result<ResultPackage>;
  list(ctx: CallContext, caseId: Id): Promise<Result<ReportRecord[]>>;
  followups(ctx: CallContext, caseId: Id): Promise<Result<FollowupRecord[]>>;
  searchFollowups(
    ctx: CallContext,
    input: { caseId?: Id; state?: FollowupRecord["state"]; page: PageRequest },
  ): Promise<Result<{ items: FollowupRecord[]; nextCursor?: string }>>;
  putFollowup(
    ctx: CallContext,
    input: { item: FollowupRecord; expectedRevision: number },
  ): Promise<Result<FollowupRecord>>;
  export(
    ctx: CallContext,
    input: { caseId: Id; caseRevision: number; format: "markdown" | "json" },
  ): Promise<Result<{ filename: string; mediaType: string; text: string }>>;
}
export type InvestigationProfilePort = Pick<ReportService, "prepare">;
export type ReportProposalPort = Pick<ReportService, "proposeInTx">;
export type ReportCompletionPort = Pick<
  ReportService,
  | "assessInTx"
  | "finalizeInTx"
  | "terminalWithoutRunInTx"
  | "publishReviewedInTx"
>;
export interface ResultPackageReadPort {
  getInTx(
    tx: ReadTx,
    ctx: CallContext,
    input: { requestId: Id; resultVersion?: number },
  ): Result<ResultPackage>;
}

export type DeliveryState =
  | "pending"
  | "sending"
  | "delivered"
  | "uncertain"
  | "retryable_failed"
  | "blocked";
export interface DeliveryRecord {
  id: Id;
  originBindingId: Id;
  requestId: Id;
  runId?: Id;
  resultVersion: number;
  deliveryKey: string;
  state: DeliveryState;
  attempts: number;
  result: ResultPackage;
  receipt?: HostReceipt;
  lastError?: AppError;
  nextAttemptAt?: Instant;
}
export interface DeliveryService {
  enqueueInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { bindingId: Id; result: ResultPackage },
  ): Result<DeliveryRecord>;
  tick(ctx: CallContext): Promise<Result<number>>;
  status(ctx: CallContext, requestId: Id): Promise<Result<DeliveryRecord[]>>;
  getResult(
    ctx: CallContext,
    input: { requestId: Id; resultVersion?: number },
  ): Promise<Result<ResultPackage>>;
}
export interface SubscriptionAtomicPort {
  subscribeInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { requestId: Id; bindingId: Id; canCancel: boolean },
  ): Result<void>;
  listInTx(
    tx: ReadTx,
    ctx: CallContext,
    requestId: Id,
  ): Result<ResultSubscription[]>;
  withdrawInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { requestId: Id; bindingId: Id },
  ): Result<void>;
}
export interface ResultSubscription {
  requestId: Id;
  bindingId: Id;
  canCancel: boolean;
  state: "active" | "withdrawn";
}

export interface EventPayloadMap {
  "connection.changed": { connectionId: Id; generation: number };
  "alerts.received": { connectionId: Id; alertIds: Id[]; receiveSeq: number };
  "policy.changed": { policyId: Id; epoch: number; enabled: boolean };
  "case.changed": { caseId: Id; revision: number; reason: string };
  "request.changed": { requestId: Id; state: RequestState };
  "job.changed": { jobId: Id; runId?: Id; state: JobState; revision: number };
  "investigation.step": { runId: Id; stepId: Id; summary: string };
  "report.changed": {
    reportId: Id;
    caseId: Id;
    review: ReportRecord["review"];
  };
  "delivery.changed": { deliveryId: Id; requestId: Id; state: DeliveryState };
  "runtime.changed": { state: "ready" | "degraded" | "stopping" };
}
export type DomainEvent = {
  [K in keyof EventPayloadMap]: {
    seq: number;
    type: K;
    spaceId: Id;
    aggregateId: Id;
    revision: number;
    occurredAt: Instant;
    traceId: Id;
    payload: EventPayloadMap[K];
  };
}[keyof EventPayloadMap];
export interface EventPort {
  appendInTx<K extends keyof EventPayloadMap>(
    tx: WriteTx,
    ctx: CallContext,
    input: {
      type: K;
      aggregateId: Id;
      revision: number;
      payload: EventPayloadMap[K];
    },
  ): number;
  read(
    ctx: CallContext,
    input: { afterSeq: number; limit: number },
  ): Promise<
    Result<{ events: DomainEvent[]; lastSeq: number; resetRequired: boolean }>
  >;
}
export interface WorkspaceSnapshot {
  eventSeq: number;
  generatedAt: Instant;
  connections: { id: Id; displayName: string; generation: number }[];
  cases: CaseRecord[];
  requests: InvestigationRequest[];
  jobs: JobRecord[];
  totals: { cases: number; queued: number; active: number };
}
export interface RuntimeSettings {
  revision: number;
  trayEnabled: boolean;
  budgetTimeZone: string;
  dailyTotalTokenLimit?: number;
  retentionDays?: number;
  evidenceMaxBytes?: number;
}
export interface DesktopMethodMap {
  "runtime.status": {
    input: Record<string, never>;
    output: {
      state: "ready" | "degraded" | "stopping";
      spaceId: Id;
      hostCapabilities: HostCapability[];
      trayEnabled: boolean;
    };
  };
  "runtime.setTray": {
    input: { enabled: boolean };
    output: { enabled: boolean };
  };
  "runtime.settings": { input: Record<string, never>; output: RuntimeSettings };
  "runtime.configure": {
    input: {
      expectedRevision: number;
      settings: Omit<RuntimeSettings, "revision">;
    };
    output: RuntimeSettings;
  };
  "workspace.snapshot": {
    input: { connectionId?: Id };
    output: WorkspaceSnapshot;
  };
  "events.read": {
    input: { afterSeq: number; limit: number };
    output: { events: DomainEvent[]; lastSeq: number; resetRequired: boolean };
  };
  "connections.list": {
    input: Record<string, never>;
    output: { id: Id; displayName: string; generation: number }[];
  };
  "connections.capabilities": {
    input: { connectionId: Id; refresh: boolean };
    output: Capability[];
  };
  "connections.agents": {
    input: { connectionId: Id; page: PageRequest };
    output: { items: AgentSummary[]; nextCursor?: string; total?: Count };
  };
  "devices.detail": { input: DeviceDetailInput; output: DeviceDetail };
  "connections.configure": {
    input: {
      id?: Id;
      displayName: string;
      platformInstanceId: Id;
      indexerBaseUrl?: string;
      serverBaseUrl?: string;
      alertsPattern: string;
      archivesPattern?: string;
      mappingVersion: string;
      expectedGeneration?: number;
    };
    output: { id: Id; generation: number };
  };
  "connections.setCredential": {
    input: {
      connectionId: Id;
      endpoint: "indexer" | "server";
      username: string;
      password: string;
      persist: boolean;
      expectedGeneration: number;
    };
    output: { generation: number };
  };
  "connections.setCa": {
    input: {
      connectionId: Id;
      certificatePem: string;
      expectedGeneration: number;
    };
    output: { generation: number };
  };
  "alerts.list": {
    input: {
      connectionId: Id;
      page: PageRequest;
      scope?: Scope;
      filter?: AlertFilter;
      read?: boolean;
    };
    output: { items: InboxAlert[]; nextCursor?: string };
  };
  "alerts.markRead": { input: { alertIds: Id[] }; output: null };
  "alerts.setPolicy": {
    input: { expectedRevision: number; policy: TriggerPolicy };
    output: TriggerPolicy;
  };
  "statistics.alerts": { input: Scope; output: AlertStatistics };
  "cases.list": {
    input: {
      connectionId?: Id;
      text?: string;
      status?: CaseRecord["status"];
      page: PageRequest;
    };
    output: { items: CaseRecord[]; nextCursor?: string };
  };
  "cases.create": {
    input: { title: string; scope: Scope; seedRefs: EvidenceRef[] };
    output: CaseRecord;
  };
  "cases.snapshot": {
    input: { caseId: Id; evidencePage: PageRequest };
    output: CaseSnapshot;
  };
  "evidence.get": {
    input: { caseId: Id; ref: EvidenceRef; projectionId?: Id };
    output: { evidence: EvidenceRecord; projection?: EvidenceProjection };
  };
  "cases.putContext": {
    input: {
      caseId: Id;
      contextId?: Id;
      expectedRevision: number;
      context: Omit<BusinessContext, "id" | "version" | "authorId">;
    };
    output: BusinessContext;
  };
  "cases.setStatus": {
    input: {
      caseId: Id;
      expectedRevision: number;
      status: CaseRecord["status"];
      reason: string;
    };
    output: CaseRecord;
  };
  "cases.moveEvidence": {
    input: {
      sourceCaseId: Id;
      targetCaseId: Id;
      sourceRevision: number;
      targetRevision: number;
      refs: EvidenceRef[];
      reason: string;
    };
    output: { sourceRevision: number; targetRevision: number };
  };
  "retention.preview": {
    input: { caseIds: Id[]; olderThan: Instant };
    output: CleanupPlan;
  };
  "retention.apply": {
    input: { planId: Id; expectedPlanHash: string };
    output: { expiredVersions: number };
  };
  "requests.create": { input: CreateRequest; output: RequestStatus };
  "requests.provideInput": {
    input: {
      requestId: Id;
      scope?: Scope;
      text?: string;
      idempotencyKey: string;
    };
    output: RequestStatus;
  };
  "requests.status": { input: { requestId: Id }; output: RequestStatus };
  "investigations.snapshot": { input: { runId: Id }; output: RunSnapshot };
  "requests.cancel": {
    input: { requestId: Id; reason: string };
    output: RequestStatus;
  };
  "requests.resume": {
    input: { requestId: Id; expectedJobRevision: number };
    output: RequestStatus;
  };
  "requests.abandon": {
    input: { requestId: Id; expectedJobRevision: number; reason: string };
    output: RequestStatus;
  };
  "requests.reconcile": {
    input: { requestId: Id; expectedJobRevision: number };
    output: RequestStatus;
  };
  "reports.review": { input: ReviewInput; output: ReportRecord };
  "results.publishReview": {
    input: {
      requestId: Id;
      reportId: Id;
      expectedCaseRevision: number;
      expectedResultVersion: number;
    };
    output: ResultPackage;
  };
  "reports.list": { input: { caseId: Id }; output: ReportRecord[] };
  "followups.list": { input: { caseId: Id }; output: FollowupRecord[] };
  "followups.search": {
    input: { caseId?: Id; state?: FollowupRecord["state"]; page: PageRequest };
    output: { items: FollowupRecord[]; nextCursor?: string };
  };
  "followups.put": {
    input: { item: FollowupRecord; expectedRevision: number };
    output: FollowupRecord;
  };
  "cases.export": {
    input: { caseId: Id; caseRevision: number; format: "markdown" | "json" };
    output: { filename: string; mediaType: string; text: string };
  };
  "results.get": {
    input: { requestId: Id; resultVersion?: number };
    output: ResultPackage;
  };
  "deliveries.status": { input: { requestId: Id }; output: DeliveryRecord[] };
}
export interface RpcRequest<K extends keyof DesktopMethodMap> {
  protocolVersion: "0.1.0";
  requestId: Id;
  method: K;
  payload: DesktopMethodMap[K]["input"];
}
export interface RpcResponse<T> {
  protocolVersion: "0.1.0";
  requestId: Id;
  result: Result<T>;
}
export interface DesktopApi {
  invoke<K extends keyof DesktopMethodMap>(
    request: RpcRequest<K>,
  ): Promise<RpcResponse<DesktopMethodMap[K]["output"]>>;
}
