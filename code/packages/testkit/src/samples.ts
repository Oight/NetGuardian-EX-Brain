import type { AnalysisRun, AutoCandidate, BudgetState, BusinessContext, CaseRecord, CleanupPlan, ConnectionProfile, Coverage, DesktopMethodMap, EvidenceRecord, FollowupRecord, InvestigationRequest, JobRecord, OriginBinding, PlatformPage, ReportCandidate, ReportRecord, RequestStatus, ResultPackage, TriggerPolicy } from '@campussec/contracts';
import { CASE, CONNECTION, PRINCIPAL, SPACE, scope } from './scenarios.js';

/** Explicit synthetic examples, not default fake answers and not business implementation. */
export function foundationSamples() {
  const at = scope.to;
  const caseRecord: CaseRecord = { id: CASE, spaceId: SPACE, revision: 1, title: '合成案件', scope, status: 'pending', createdAt: at, updatedAt: at };
  const connection: ConnectionProfile = { id: CONNECTION, spaceId: SPACE, platformInstanceId: SPACE, displayName: '合成连接', generation: 1, alertsPattern: 'synthetic-*', mappingVersion: 'v1', principalFingerprint: 'synthetic', updatedAt: at };
  const coverage: Coverage = { requestedScope: scope, effectiveScope: scope, queryCompleteness: 'partial', collectionCoverage: 'unknown', sourceTypes: ['synthetic'], reasons: ['synthetic_page_limit'], retrievedAt: at, returned: 1 };
  const evidence: EvidenceRecord = { id: CASE, spaceId: SPACE, connectionId: CONNECTION, version: 1, source: { platformInstanceId: SPACE, kind: 'index_document', index: 'synthetic', documentId: '1' }, kind: 'alert', timeQuality: 'unknown', retrievedAt: at, contentHash: 'd832fe9713bfd36f1d38af8c65c7bd3ab6a54c0e610e08f2faa652a98eb5350b', fields: { event: 'synthetic' }, availability: 'available' };
  const context: BusinessContext = { id: CASE, caseId: CASE, connectionId: CONNECTION, agentIds: ['001'], version: 1, text: '合成背景', from: scope.from, to: scope.to, sourceLabel: 'synthetic', verification: 'unverified', authorId: PRINCIPAL };
  const run: AnalysisRun = { id: CASE, jobId: CASE, caseId: CASE, baseRevision: 1, scope, connectionGeneration: 1, identityEpoch: 1, profileVersion: 'v1', toolEpoch: 1, expiresAt: '2026-10-23T01:05:00.000Z' };
  const request: InvestigationRequest = { id: CASE, origin: 'client_user', state: 'accepted', connectionId: CONNECTION, question: '合成问题', requestedScope: scope, effectiveScope: scope, seedRefs: [], caseId: CASE, jobId: CASE, missingFields: [], createdAt: at, expiresAt: run.expiresAt };
  const job: JobRecord = { id: CASE, requestId: CASE, caseId: CASE, runId: CASE, origin: 'client_user', state: 'running', revision: 1, createdAt: at, updatedAt: at, expiresAt: run.expiresAt, recoveryHold: false };
  const budget: BudgetState = { runId: CASE, toolsUsed: 0, readsUsed: 0, platformAttempts: 0, distinctEvents: 0, deadline: run.expiresAt, closed: false };
  const status: RequestStatus = { request, job, budget };
  const candidate: ReportCandidate = { caseId: CASE, runId: CASE, question: '合成问题', facts: [], analysis: [], conflicts: [], gaps: ['采集覆盖未知'], classification: 'insufficient_evidence', stopReason: 'evidence_unavailable', followups: [] };
  const report: ReportRecord = { id: CASE, caseId: CASE, runId: CASE, version: 1, baseRevision: 1, candidate, validation: 'needs_review', review: 'unreviewed', validationIssues: ['synthetic_review_required'], createdAt: at };
  const result: ResultPackage = { schemaVersion: '0.1.0', requestId: CASE, jobId: CASE, caseId: CASE, runId: CASE, resultVersion: 1, terminalState: 'needs_review', review: 'unreviewed', summary: '合成结果，不是调查验收', reportId: CASE, mainEvidence: [], gaps: ['采集覆盖未知'], followups: [], scope };
  const policy: TriggerPolicy = { id: CASE, connectionId: CONNECTION, revision: 1, epoch: 1, enabled: true, agentIds: ['001'], filter: {}, enabledAfterReceiveSeq: 0, dailyAttemptLimit: 10, timeZone: 'Asia/Shanghai' };
  const autoCandidate: AutoCandidate = { id: CASE, policyId: CASE, policyEpoch: 1, caseId: CASE, alertIds: [CASE], scope, question: '合成告警调查', firstReceivedAt: at, lastReceivedAt: at, coalesceUntil: '2026-10-23T01:00:10.000Z', expiresAt: run.expiresAt };
  const followup: FollowupRecord = { id: CASE, caseId: CASE, revision: 1, state: 'open', question: '合成核查项', suggestedAction: '人工确认', evidenceRefs: [] };
  const cleanup: CleanupPlan = { id: CASE, planHash: 'a'.repeat(64), expiresAt: run.expiresAt, caseIds: [CASE], caseRevisions: [{ caseId: CASE, revision: 1 }], removableVersions: 0, blockedVersions: 1, approximateBytes: 0 };
  const binding: OriginBinding = { id: CASE, spaceId: SPACE, principalId: PRINCIPAL, hostId: SPACE, hostAccountId: PRINCIPAL, workspaceId: SPACE, sessionId: 'synthetic-session', requestMessageId: 'synthetic-message', state: 'active', createdAt: at, expiresAt: run.expiresAt };
  const page: PlatformPage = { status: 'partial', queryId: CASE, pageId: CASE, pageOrdinal: 0, records: [{ source: evidence.source, kind: 'alert', timeQuality: 'unknown', retrievedAt: at, fields: evidence.fields }], coverage, warnings: ['synthetic_partial'], platformAttempts: 1 };
  const settings = { revision: 1, trayEnabled: false, budgetTimeZone: 'Asia/Shanghai' };
  const pageInput = { limit: 10 };
  const revision = { requestId: CASE, expectedJobRevision: 1 };
  const { id: _id, version: _version, authorId: _authorId, ...contextInput } = context;
  const desktop = {
    'runtime.status': { input: {}, output: { state: 'degraded', spaceId: SPACE, hostCapabilities: [], trayEnabled: false } },
    'runtime.setTray': { input: { enabled: false }, output: { enabled: false } },
    'runtime.settings': { input: {}, output: settings },
    'runtime.configure': { input: { expectedRevision: 1, settings: { trayEnabled: false, budgetTimeZone: 'Asia/Shanghai' } }, output: settings },
    'workspace.snapshot': { input: {}, output: { eventSeq: 0, generatedAt: at, connections: [], cases: [caseRecord], requests: [request], jobs: [job], totals: { cases: 1, queued: 0, active: 1 } } },
    'events.read': { input: { afterSeq: 0, limit: 10 }, output: { events: [], lastSeq: 0, resetRequired: true } },
    'connections.list': { input: {}, output: [{ id: CONNECTION, displayName: connection.displayName, generation: 1 }] },
    'connections.capabilities': { input: { connectionId: CONNECTION, refresh: false }, output: [] },
    'connections.agents': { input: { connectionId: CONNECTION, page: pageInput }, output: { items: [{ id: '001' }] } },
    'devices.detail': { input: { connectionId: CONNECTION, agentId: '001', category: 'os', page: pageInput }, output: { agentId: '001', category: 'os', items: [], retrievedAt: at, status: 'denied', warnings: ['synthetic_denied'] } },
    'connections.configure': { input: { displayName: '合成连接', platformInstanceId: SPACE, alertsPattern: 'synthetic-*', mappingVersion: 'v1' }, output: { id: CONNECTION, generation: 1 } },
    'connections.setCredential': { input: { connectionId: CONNECTION, endpoint: 'server', username: 'synthetic', password: 'synthetic-not-a-real-secret', persist: false, expectedGeneration: 1 }, output: { generation: 2 } },
    'connections.setCa': { input: { connectionId: CONNECTION, certificatePem: 'synthetic PEM placeholder, schema-only', expectedGeneration: 1 }, output: { generation: 2 } },
    'alerts.list': { input: { connectionId: CONNECTION, page: pageInput }, output: { items: [] } },
    'alerts.markRead': { input: { alertIds: [CASE] }, output: null },
    'alerts.setPolicy': { input: { expectedRevision: 0, policy }, output: policy },
    'statistics.alerts': { input: scope, output: { scope, total: { value: 1, relation: 'gte' }, byLevel: [{ level: 5, count: 1 }], byHour: [{ start: scope.from, count: 1 }], coverage } },
    'cases.list': { input: { page: pageInput }, output: { items: [caseRecord] } },
    'cases.create': { input: { title: '合成案件', scope, seedRefs: [] }, output: caseRecord },
    'cases.snapshot': { input: { caseId: CASE, evidencePage: pageInput }, output: { case: caseRecord, evidence: [evidence], contexts: [context], queries: [] } },
    'evidence.get': { input: { caseId: CASE, ref: { evidenceId: CASE, version: 1 } }, output: { evidence } },
    'cases.putContext': { input: { caseId: CASE, expectedRevision: 1, context: contextInput }, output: context },
    'cases.setStatus': { input: { caseId: CASE, expectedRevision: 1, status: 'resolved', reason: '合成人工确认' }, output: { ...caseRecord, status: 'resolved', revision: 2 } },
    'cases.moveEvidence': { input: { sourceCaseId: CASE, targetCaseId: SPACE, sourceRevision: 1, targetRevision: 1, refs: [{ evidenceId: CASE, version: 1 }], reason: '合成移动' }, output: { sourceRevision: 2, targetRevision: 2 } },
    'retention.preview': { input: { caseIds: [CASE], olderThan: at }, output: cleanup },
    'retention.apply': { input: { planId: CASE, expectedPlanHash: cleanup.planHash }, output: { expiredVersions: 0 } },
    'requests.create': { input: { origin: 'client_user', connectionId: CONNECTION, question: '合成问题', requestedScope: scope, seedRefs: [], idempotencyKey: 'synthetic' }, output: status },
    'requests.provideInput': { input: { requestId: CASE, scope, idempotencyKey: 'synthetic' }, output: status },
    'requests.status': { input: { requestId: CASE }, output: status },
    'investigations.snapshot': { input: { runId: CASE }, output: { run, job, steps: [], budget } },
    'requests.cancel': { input: { requestId: CASE, reason: '合成取消' }, output: status },
    'requests.resume': { input: revision, output: status },
    'requests.abandon': { input: { ...revision, reason: '合成放弃' }, output: status },
    'requests.reconcile': { input: revision, output: status },
    'reports.review': { input: { reportId: CASE, expectedCaseRevision: 1, disposition: 'accepted', humanConclusion: 'unknown', note: '合成人工意见' }, output: report },
    'results.publishReview': { input: { requestId: CASE, reportId: CASE, expectedCaseRevision: 1, expectedResultVersion: 1 }, output: result },
    'reports.list': { input: { caseId: CASE }, output: [report] },
    'followups.list': { input: { caseId: CASE }, output: [followup] },
    'followups.search': { input: { page: pageInput }, output: { items: [followup] } },
    'followups.put': { input: { item: followup, expectedRevision: 0 }, output: followup },
    'cases.export': { input: { caseId: CASE, caseRevision: 1, format: 'json' }, output: { filename: 'synthetic.json', mediaType: 'application/json', text: '{"synthetic":true}' } },
    'results.get': { input: { requestId: CASE }, output: result },
    'deliveries.status': { input: { requestId: CASE }, output: [] },
  } satisfies { [K in keyof DesktopMethodMap]: { input: DesktopMethodMap[K]['input']; output: DesktopMethodMap[K]['output'] } };
  return { caseRecord, connection, context, coverage, run, request, job, budget, status, candidate, report, result, policy, autoCandidate, binding, page, desktop };
}
