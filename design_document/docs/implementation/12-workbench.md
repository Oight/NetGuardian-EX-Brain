# S12 客户端界面与证据工作台

工程契约版本：0.2.0；修订日期：2026-10-23。状态：新增实现设计，界面未实现；业务基线v4.2。内嵌完整DesktopApi，可直接交给前端Agent。

## 1. 职责、代码与运行环境

实现 `apps/desktop/renderer/{app,routes,api,state,views,components}.tsx`。建议React/TypeScript/Vite；只加载打包资源。界面唯一业务依赖为`window.campusSec: DesktopApi`，不得import Electron、Node、SQLite、Wazuh或TeleAgent客户端。

独立开发提供同形状DesktopApi fake，标“合成演示”；不把历史API计数填为实时值。UI不维护第二套任务状态机，不根据进度文案自行判断成功。完整类型在文末，不需要先实现其他模块。

## 2. 导航与方法对应

| 页面/路由 | 必需功能 | 调用 |
|---|---|---|
| `/overview` | 新告警、待核查案件、运行/排队、连接缺口、发起调查；可加24h告警图 | workspace.snapshot、statistics.alerts、runtime.status |
| `/alerts` | 设备/时间/规则/等级筛选、已读、选中建案、未自动调查原因 | alerts.list/markRead、cases.create、requests.create |
| `/devices` | 可见设备与连接状态、清单新鲜度、背景；从设备主动调查 | connections.agents/capabilities；背景用cases.putContext；详情扩展只走Facade |
| `/cases`、`/cases/:caseId` | 案件检索、无告警调查、证据、步骤、草案、追问、人工拆案 | cases.list/snapshot/moveEvidence、evidence.get、investigations.snapshot、reports.list |
| `/followups` | 人工结论、核查事项、处理记录、导出预览 | followups.search/list/put、reports.review、cases.setStatus/export |
| `/settings` | 两侧入口/认证/CA/能力、自动策略、预算说明、托盘、宿主就绪 | connections.configure/setCredential/setCa/capabilities、alerts.setPolicy、runtime.status/setTray |

预算与留存配置另用runtime.settings/configure；没有设置上限时显示未配置，不能把未知usage显示为零。配置保存前展示作用范围，证据清理必须有独立预览，不由保存设置自动执行。

清理按钮先retention.preview，展示可清/被活动调查或其他案件阻止的条数、估算字节与仍会保留的报告摘录，再由用户明确操作retention.apply(planId,expectedPlanHash)。计划过期或案件版本变化重新预览；expired证据显示引用缺口，不把空JSON当原始记录。

首版设备页只有已定义Facade可用的数据；详细清单若需独立于调查展示，使用下述专用方法，不绕过主进程：`devices.detail`，参数`{connectionId,agentId,category,page}`，category为os/hardware/packages/processes/ports/fim_objects/sca，返回平台只读页与时间。该方法已在公共契约内定义；无能力时显示受限，不造实时CPU/网络拓扑。

## 3. 调查表单与交互

输入连接、设备多选、明确时区下的绝对时间/相对预设、问题，可选告警种子。设备1—5、时间<=1h、问题<=2000字；客户端校验只作提示，核心仍执行最终授权。相对预设首次转换为UTC并冻结，重试复用相同idempotencyKey和绝对范围；修改表单另生成键。

requests.create固定origin=client_user，不发送originBindingId/autoCandidateId。缺项awaiting_scope显示卡片并用provideInput补齐；accepted展示真实jobId/state，不提示已完成。队列满/额度未知/宿主不可用显示原因，保留用户输入。

调查中的补充说明保存为deferred_inputs，界面明确“下一轮使用”；不暗改当前run。追问依据先定位已有引用，需要新取证才新建request关联原case。用户选择停止并重新调查时先cancel旧任务，再等核心确认/明确放弃；不并发重开同案。

## 4. 工作台布局与语义

```text
顶部：问题｜设备｜请求范围/实际覆盖｜来源｜任务状态｜审核状态
左栏：时间线、源记录、查询覆盖、背景来源与有效期
中栏：步骤摘要、当前工具、返回数量、补充材料与后续问题
右栏：事实/分析/冲突/未知、引用、核查事项、人工认可/修订
底栏：排队原因、调用额度/已知usage、停止/恢复核实、投递状态
```

引用点击evidence.get，先展示本轮实际released投影，再可展开获准本地快照；两者字段不同时明确区分。时间线按observedAt排序，未知时间独立组，retrievedAt另显示。清单扫描旧不因界面刷新变“实时”。

状态必须区分：零匹配、权限受限、部分结果、失败、未接入、未知、旧缓存刷新失败。漏洞403不填0；告警数不改名攻击次数；FIM对象数不改名变更次数；设备总量不等在线数；不展示虚构全校风险分数、地图或网络设备态势。

case/currentReport与latestReport不一致时显示“有基于旧输入的历史候选”；当前材料更新后旧草案仍可读，明确覆盖与新材料提示。基本历史轮次属于P0；自动差异解释/判断图/局部重查不是本轮必做。

## 5. 人工核查与导出

reports.review输入expectedCaseRevision、disposition、humanConclusion和note；模型建议与人工结论独立。修订用新候选，不覆盖原文。案例关闭使用cases.setStatus并填写理由，不能因草案完成自动关闭。followup完成只显示人工记录，观测证据另列。

导出先预览问题、范围、时间、支持/冲突/缺口、审核状态和未完成项，再由cases.export生成文本、S03保存对话框选择路径。取消保存不显示成功。人工修订需要发送原来源时，用户显式触发results.publishReview；投递成功与调查成功分开显示。

## 6. 事件同步、错误与可访问性

初次workspace.snapshot得到eventSeq，再events.read(afterSeq)增量读取；可每1s有界轮询，没有新增就不重绘大列表。DomainEvent只触发相关视图刷新，不能据事件payload拼出未经授权的完整证据。重复seq忽略、倒序丢弃；resetRequired或身份空间改变清空相关缓存并重取快照。

每个表单保存明确pending/error/success；网络超时不自动重新提交模型任务，使用同业务键查状态。REVISION_CONFLICT展示新revision并要求重新审阅。uncertain显示核实/明确放弃操作和远端可能仍运行说明；requests.resume只给recoveryHold的未提交主动任务。

“核实远端状态”调用requests.reconcile，普通requests.status只读本地状态，不暗中创建网络操作或新会话。uncertain仍待核实时getResult显示未产生终态；明确放弃后可查看needs_review结果。

正文按纯文本/安全Markdown渲染，禁HTML和自动外链资源；链接打开由用户点击并由Main验证。支持键盘焦点、可读标签、状态文字；不用单一颜色表达未知/失败。协议诊断与哈希放展开区，不挤占调查主流程。

## 7. 独立验收与交接

DesktopApi fake至少提供：仅提醒且宿主不可用、awaiting_scope、queued/running、完整零结果、403/partial、旧扫描时间、旧草案晚到、取消未确认、恢复hold、回传uncertain、人工修订与导出取消。验证全部按钮调用固定method/DTO，额外字段被拒绝。

覆盖六个视图与完整用户路径：收件箱建案；设备无告警调查；补背景/查引用/人工核查/导出；原来源任务在本地查看；退出/托盘状态明确。交付页面、typed API client、fake与可复现界面验证说明，不能只交静态截图。

## 8. 内嵌统一契约

固定导出`mountWorkbench(input:{element:HTMLElement;api:DesktopApi}):{unmount:()=>void}`。生产传window.campusSec，独立验证传fake；unmount清理订阅、计时器和未提交表单内存，不调用后端取消业务任务。Renderer不构造其他子系统。

### 并行开发入口

基座合并后使用共享DesktopApi fake，任务基准必须固定commit和工程契约0.2.0；外部IPC仍0.1.0。retention和results.publishReview调用名不变，Facade内部已分别路由S07 RetentionService/ReviewPublicationPort。不得为适配界面私改后端DTO或把不可用宿主伪装成功。

<!-- CONTRACT:BEGIN roots=DesktopApi,DesktopMethodMap,WorkspaceSnapshot,DomainEvent -->
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

export interface AlertStatistics {
  scope: Scope; total: Count; byLevel: { level: number; count: number }[];
  byHour: { start: Instant; count: number }[]; coverage: Coverage;
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

export interface CleanupPlan {
  id: Id; planHash: string; expiresAt: Instant; caseIds: Id[];
  caseRevisions: { caseId: Id; revision: number }[];
  removableVersions: number; blockedVersions: number; approximateBytes: number;
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

export interface HostCapability {
  name: 'signedApi' | 'dedicatedProfile' | 'isolatedEvidenceChannel' | 'trustedOrigin'
    | 'asyncDelivery' | 'deliveryReconcile';
  state: 'available' | 'unavailable' | 'unverified'; version: string;
  checkedAt: Instant; evidence: string;
}

export interface HostReceipt { messageId: string; visible: boolean; observedAt: Instant }

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

export type DeliveryState = 'pending' | 'sending' | 'delivered' | 'uncertain' | 'retryable_failed' | 'blocked';

export interface DeliveryRecord {
  id: Id; originBindingId: Id; requestId: Id; runId?: Id; resultVersion: number;
  deliveryKey: string; state: DeliveryState; attempts: number; result: ResultPackage;
  receipt?: HostReceipt; lastError?: AppError; nextAttemptAt?: Instant;
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
```
<!-- CONTRACT:END -->
