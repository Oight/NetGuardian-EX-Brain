/** Engineering contract 0.2.0; declarations preserved from the source snapshot. */
import type { CallContext, Count, Id, Instant, PageRequest, Result, Scope, WriteTx } from "./common.js";
import type { CreateRequest, InvestigationRequest, JobRecord, JobState, RequestState, RequestStatus, RunSnapshot } from "./investigations.js";
import type { FollowupRecord, ReportRecord, ResultPackage, ReviewInput } from "./reports.js";
import type { DeliveryRecord, DeliveryState } from "./delivery.js";
import type { BusinessContext, CaseRecord, CaseSnapshot, CleanupPlan, EvidenceProjection, EvidenceRecord, EvidenceRef } from "./cases.js";
import type { HostCapability } from "./host.js";
import type { AgentSummary, AlertFilter, AlertStatistics, Capability, DeviceDetail, DeviceDetailInput } from "./platform.js";
import type { InboxAlert, TriggerPolicy } from "./alerts.js";

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

export interface WorkspaceSnapshot {
  eventSeq: number; generatedAt: Instant;
  connections: { id: Id; displayName: string; generation: number }[];
  cases: CaseRecord[]; requests: InvestigationRequest[]; jobs: JobRecord[];
  totals: { cases: number; queued: number; active: number };
}

export interface RuntimeSettings {
  revision: number; trayEnabled: boolean; budgetTimeZone: string;
  dailyTotalTokenLimit?: number; retentionDays?: number; evidenceMaxBytes?: number;
}

export interface DesktopMethodMap {
  'runtime.status': { input: Record<string, never>; output: { state: 'ready' | 'degraded' | 'stopping'; spaceId: Id; hostCapabilities: HostCapability[]; trayEnabled: boolean } };
  'runtime.setTray': { input: { enabled: boolean }; output: { enabled: boolean } };
  'runtime.settings': { input: Record<string, never>; output: RuntimeSettings };
  'runtime.configure': { input: { expectedRevision: number; settings: Omit<RuntimeSettings, 'revision'> }; output: RuntimeSettings };
  'workspace.snapshot': { input: { connectionId?: Id }; output: WorkspaceSnapshot };
  'events.read': { input: { afterSeq: number; limit: number }; output: { events: DomainEvent[]; lastSeq: number; resetRequired: boolean } };
  'connections.list': { input: Record<string, never>; output: { id: Id; displayName: string; generation: number }[] };
  'connections.capabilities': { input: { connectionId: Id; refresh: boolean }; output: Capability[] };
  'connections.agents': { input: { connectionId: Id; page: PageRequest }; output: { items: AgentSummary[]; nextCursor?: string; total?: Count } };
  'devices.detail': { input: DeviceDetailInput; output: DeviceDetail };
  'connections.configure': { input: { id?: Id; displayName: string; platformInstanceId: Id; indexerBaseUrl?: string; serverBaseUrl?: string; alertsPattern: string; archivesPattern?: string; mappingVersion: string; expectedGeneration?: number }; output: { id: Id; generation: number } };
  'connections.setCredential': { input: { connectionId: Id; endpoint: 'indexer' | 'server'; username: string; password: string; persist: boolean; expectedGeneration: number }; output: { generation: number } };
  'connections.setCa': { input: { connectionId: Id; certificatePem: string; expectedGeneration: number }; output: { generation: number } };
  'alerts.list': { input: { connectionId: Id; page: PageRequest; scope?: Scope; filter?: AlertFilter; read?: boolean }; output: { items: InboxAlert[]; nextCursor?: string } };
  'alerts.markRead': { input: { alertIds: Id[] }; output: null };
  'alerts.setPolicy': { input: { expectedRevision: number; policy: TriggerPolicy }; output: TriggerPolicy };
  'statistics.alerts': { input: Scope; output: AlertStatistics };
  'cases.list': { input: { connectionId?: Id; text?: string; status?: CaseRecord['status']; page: PageRequest }; output: { items: CaseRecord[]; nextCursor?: string } };
  'cases.create': { input: { title: string; scope: Scope; seedRefs: EvidenceRef[] }; output: CaseRecord };
  'cases.snapshot': { input: { caseId: Id; evidencePage: PageRequest }; output: CaseSnapshot };
  'evidence.get': { input: { caseId: Id; ref: EvidenceRef; projectionId?: Id }; output: { evidence: EvidenceRecord; projection?: EvidenceProjection } };
  'cases.putContext': { input: { caseId: Id; contextId?: Id; expectedRevision: number; context: Omit<BusinessContext, 'id' | 'version' | 'authorId'> }; output: BusinessContext };
  'cases.setStatus': { input: { caseId: Id; expectedRevision: number; status: CaseRecord['status']; reason: string }; output: CaseRecord };
  'cases.moveEvidence': { input: { sourceCaseId: Id; targetCaseId: Id; sourceRevision: number; targetRevision: number; refs: EvidenceRef[]; reason: string }; output: { sourceRevision: number; targetRevision: number } };
  'retention.preview': { input: { caseIds: Id[]; olderThan: Instant }; output: CleanupPlan };
  'retention.apply': { input: { planId: Id; expectedPlanHash: string }; output: { expiredVersions: number } };
  'requests.create': { input: CreateRequest; output: RequestStatus };
  'requests.provideInput': { input: { requestId: Id; scope?: Scope; text?: string; idempotencyKey: string }; output: RequestStatus };
  'requests.status': { input: { requestId: Id }; output: RequestStatus };
  'investigations.snapshot': { input: { runId: Id }; output: RunSnapshot };
  'requests.cancel': { input: { requestId: Id; reason: string }; output: RequestStatus };
  'requests.resume': { input: { requestId: Id; expectedJobRevision: number }; output: RequestStatus };
  'requests.abandon': { input: { requestId: Id; expectedJobRevision: number; reason: string }; output: RequestStatus };
  'requests.reconcile': { input: { requestId: Id; expectedJobRevision: number }; output: RequestStatus };
  'reports.review': { input: ReviewInput; output: ReportRecord };
  'results.publishReview': { input: { requestId: Id; reportId: Id; expectedCaseRevision: number; expectedResultVersion: number }; output: ResultPackage };
  'reports.list': { input: { caseId: Id }; output: ReportRecord[] };
  'followups.list': { input: { caseId: Id }; output: FollowupRecord[] };
  'followups.search': { input: { caseId?: Id; state?: FollowupRecord['state']; page: PageRequest }; output: { items: FollowupRecord[]; nextCursor?: string } };
  'followups.put': { input: { item: FollowupRecord; expectedRevision: number }; output: FollowupRecord };
  'cases.export': { input: { caseId: Id; caseRevision: number; format: 'markdown' | 'json' }; output: { filename: string; mediaType: string; text: string } };
  'results.get': { input: { requestId: Id; resultVersion?: number }; output: ResultPackage };
  'deliveries.status': { input: { requestId: Id }; output: DeliveryRecord[] };
}

export interface RpcRequest<K extends keyof DesktopMethodMap> {
  protocolVersion: '0.1.0'; requestId: Id; method: K; payload: DesktopMethodMap[K]['input'];
}

export interface RpcResponse<T> { protocolVersion: '0.1.0'; requestId: Id; result: Result<T> }

export interface DesktopApi {
  invoke<K extends keyof DesktopMethodMap>(request: RpcRequest<K>): Promise<RpcResponse<DesktopMethodMap[K]['output']>>;
}
