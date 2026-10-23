# S03 桌面宿主、秘密存储与应用入口

工程契约版本：0.2.0；修订日期：2026-10-23。状态：新增实现设计，未实现/未联调；业务基线 v4.2。本文含完整外部调用协议，可独立实现。

## 1. 范围与文件

实现 Electron Main、Preload 和 runtime composition；以一个本地业务核心供 UI 和两类 MCP 共用。目录为 `apps/desktop/main/{bootstrap,windows,tray,secrets,ipc}.ts`、`preload/index.ts`、`runtime/{compose,facade,recovery}.ts`。业务核心不得 import Electron。

首轮在 Main 中装配核心；所有数据库写入仍由这个核心负责。独立 Node.js 业务进程是后续可评估部署形式，本包不以 utilityProcess 为必做条件。接口均为异步，因此将来移动核心不改 UI/业务 DTO。

## 2. 启动、运行与退出

启动顺序：取得单实例锁 → 加载非秘密设置 → 初始化系统秘密存储 → 打开匹配空间/执行迁移 → 装配端口 → 执行恢复屏障 → 启动窗口/托盘 → 允许接收新工作。窗口可先显示“正在恢复”，但不能先派发任务。

恢复屏障：撤销上一进程全部取证 grant；核对空间/宿主身份；让 S08 检查本应用已知会话；让 S07 标记未提交主动任务待恢复、旧自动队列不补派；让 S11 把 sending 转 uncertain 并核实；最后才开启告警轮询。TeleAgent 不可用时进入 degraded，案件、已有材料与提醒仍可工作。

恢复完成后调用McpGatewayPort.start；stop必须先使授权失效再关闭监听。S03统一管理定时器：每连接10s pollOnce、每1s flushCandidates/requests.tick/delivery.tick；各操作有防重入锁，未完成不重叠调用。请求调度内部只对已知活动会话检查，不能每秒枚举个人会话。退出先停止定时器，再MCP.stop，再关闭库。

关闭窗口按显式 trayEnabled 设置处理；默认首次询问选项由界面提供，但后续遵循持久设置。完全退出先停止新受理与轮询，用户可等待或请求取消活动任务，记录状态后关闭库；不保证退出后继续提醒或回传。不以进程退出认定远端模型停止。

## 3. SecretPort

平台两套凭据独立存储，序列化为 UTF-8 JSON `{username,password}` 后放入 SecretPort；签名材料、MCP token、CA 材料用不同 purpose。默认 persist=false 仅当前进程持有。persist=true 只有系统保护存储可用时成功，否则 SECRET_STORE_UNAVAILABLE，不能落明文；重新以 persist=false 提交由用户明确选择。

SecretRef 绑定 spaceId/owner/purpose，use 必须验证；调用方仅在自己的受信任适配器中使用，不把 SecretPort 整体暴露给 Renderer。JS 无法保证秘密内存绝对清零；至少不缓存派生认证头、不记录表单值，并在替换/退出时释放缓冲区引用。

setCredential：校验连接 generation → 新建 secret → 调用 S04.save CAS 更新 secretRef 和 generation → CAS 失败删除新 secret → 提交成功撤销旧连接工具代次并删除旧 secret。用户名变化需核实 principalFingerprint，身份不符时走空间切换，不能把新主体伪装成旧主体。

有活动或uncertain任务时，主动空间切换先要求用户取消并核实，或明确放弃本地轮次；未处理前不打开新空间派发第二个调查。宿主身份自行变化时立即撤销grant并停止受理，标记IDENTITY_CHANGED，不能自动释放未知远端任务的槽位。

setCa 仅接受合法 PEM 证书，大小<=512 KiB；不提供 skipTls 开关。基础 URL 只允许 HTTPS、无userinfo、无fragment、保留明确代理前缀，入口来源为用户配置。界面不显示已存密码或 token。

## 4. IPC 与 Facade

Preload 只暴露 `window.campusSec: DesktopApi`。单一 IPC channel 为 `campussec:invoke`；Main 验证 sender/webContents/frame 来源于本应用打包窗口，校验 protocolVersion、method 和 payload，再由当前登录上下文生成 Actor。渲染端传 actor/role 等额外字段时拒绝。

Facade 按文末 DesktopMethodMap 路由；新增方法必须先更新 S01。requestId 只关联这次 IPC，不代替业务幂等键。RPC 一律返回 RpcResponse，包括 schema 错误；意外异常转换为 INTERNAL+traceId，不把 stack 发到页面。协议版本不一致返回 INVALID_INPUT 并要求升级/重启。

| 方法前缀 | 路由所有者 | Facade 责任 |
|---|---|---|
| runtime / connections.setCredential / setCa | S03，连接变更委托 S04 | 系统设置、秘密保护、身份与版本控制 |
| connections / devices.detail / statistics | S04 | 配置只返回无秘密摘要；面板查询采用独立受限调用预算 |
| alerts | S05 | 同一主体/连接授权，读写收件箱与策略 |
| cases / evidence | S06 | 案件权限、revision、引用范围 |
| requests / investigations | S07 | UI 只能 origin=client_user；拒绝传入委派绑定或自动候选身份 |
| reports / followups / cases.export | S10 | 人工动作必须 UI 主体，导出先生成文本再经系统对话框保存 |
| results.publishReview | S07 ReviewPublicationPort | 核对来源、版本并同事务发布，不重跑模型 |
| results.get / deliveries | S11 | 限制为当前主体可读请求 |
| retention.preview / retention.apply | S07 RetentionService 协调 S06 | 人工清理预览与计划哈希校验，不能从模型调用 |
| events / workspace.snapshot | S02＋只读聚合 | 同快照数据与 eventSeq；不开放任意 SQL |

connections.configure 新建 generation=1，更新须 expectedGeneration 匹配；服务端补 spaceId、secretRef、principalFingerprint。连接尚未认证时 fingerprint=`unverified:<profileId>`，不得因此启动模型或声称已完成主体核实。

workspace.snapshot返回最近20个案件、20个请求和全部活动任务；totals来自真实查询。S03使用明确的WorkspaceReadModel，在S02同一ReadTx中读取connections/cases/investigation_requests/jobs公开摘要列和MAX(eventSeq)，不读取秘密列、不import业务私有Repository、不跨所有者写表。该只读投影列集由WorkspaceSnapshot固定，基座需落实实现和空间核权。

runtime.settings/configure维护主体空间RuntimeSettings，CAS更新revision；setTray只patch托盘。token/留存配置给S07用例注入只读快照，S06只接明确清理计划参数。未设token上限表示未启用该停派条件，usage未知继续显示；未设留存上限不自动清理。启用清理须独立预览，保存设置不自动删除证据。

## 5. 桌面行为与安全边界

BrowserWindow 开启 contextIsolation、sandbox，关闭 nodeIntegration，仅加载打包资源；开发服务器只在明确开发模式启用。禁止自动打开任意窗口、执行模型脚本或加载日志内外链资源。外链由用户动作触发，Main 校验 https 协议；本地定位仅解析已知 caseId/runId，不接受任意文件路径。

桌面通知消费 S05 持久记录；通知点击通过已知 alertId/caseId 定位，不能把正文当 URL。导出文件名由 S10 建议、Main 清理路径分隔符，位置来自系统保存对话框。取消对话框返回明确取消，不标记已导出。

## 6. 依赖与组装

S03 负责构造 S02/S04—S11 的实例并注入端口、ClockPort、IdPort 和配置；S12 是独立 Renderer。组装中不可用的宿主功能用返回 CAPABILITY_UNAVAILABLE 的实现，不用成功 fake 代替。单元验证可注入内存 fake，并明确运行模式。

锁定 Electron、内嵌 Node、SQLite 驱动、MCP SDK 和打包工具的实际组合；提交锁文件。首个安装包验证创建案件→重启回读→托盘状态→无宿主降级，随后再扩大功能。不得把文档中的候选库版本当成已测结果。

## 7. 独立验收与交接

拒绝非本窗口/非主 frame IPC、未知方法、伪造 Actor；秘密不能通过 snapshot/event/error 回显；系统保护不可用不保存；连接 CAS 冲突不泄露孤儿 secret；窗口关闭与应用退出行为明确；恢复前不派发；事件缺口可重取快照；导出路径不能由日志控制；打包后本地存储可恢复。

交付 Main/Preload/runtime、类型化 window 声明、Facade 路由表、内存秘密存储 fake、安装包 smoke 说明和实际依赖兼容记录。S08 未通过时仍能演示本地人工闭环，但界面显示调查能力未就绪。

## 8. 内嵌统一契约

Main固定导出`bootstrapDesktop():Promise<void>`，作为唯一生产入口；测试可调用内部compose但不得新增生产全局单例。Preload固定导出`window.campusSec`，Renderer挂载函数由S12提供。S03对各模块只使用本包规定的create工厂与返回端口，不引用私有Repository类。

### 装配与共享文件

按[集成顺序](integration.md)分别创建S09通道组件、S08宿主、S07预算/工具/调度，最后创建S09入口；不再靠未绑定代理解决业务环。S03只装配窄端口，不在Facade复制调度、证据或报告校验。seed投影准备、回复释放、清理和发布均调用S07用例。

runtime组合、根配置、依赖锁由集成任务维护，其他模块任务不直接修改。并行任务遵循[开发入口](../development/README.md)。

<!-- CONTRACT:BEGIN roots=DesktopApi,DesktopMethodMap,SecretPort,DatabasePort,EventPort,ConnectionService,CaseService,RequestService,ReportService,DeliveryService,AlertService,RetentionService,ReviewPublicationPort -->
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

export interface AlertService {
  pollOnce(ctx: CallContext, connectionId: Id): Promise<Result<{ inserted: number; complete: boolean }>>;
  list(ctx: CallContext, input: { connectionId: Id; page: PageRequest; scope?: Scope; filter?: AlertFilter; read?: boolean }): Promise<Result<{ items: InboxAlert[]; nextCursor?: string }>>;
  markRead(ctx: CallContext, alertIds: Id[]): Promise<Result<void>>;
  setPolicy(ctx: CallContext, input: { expectedRevision: number; policy: TriggerPolicy }): Promise<Result<TriggerPolicy>>;
  flushCandidates(ctx: CallContext): Promise<Result<number>>;
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

export interface RetentionService {
  preview(ctx: CallContext, input: { caseIds: Id[]; olderThan: Instant }): Promise<Result<CleanupPlan>>;
  apply(ctx: CallContext, input: { planId: Id; expectedPlanHash: string }): Promise<Result<{ expiredVersions: number }>>;
}

export interface ReviewPublicationPort {
  publishReview(ctx: CallContext, input: { requestId: Id; reportId: Id; expectedCaseRevision: number; expectedResultVersion: number }): Promise<Result<ResultPackage>>;
}

export interface HostCapability {
  name: 'signedApi' | 'dedicatedProfile' | 'isolatedEvidenceChannel' | 'trustedOrigin'
    | 'asyncDelivery' | 'deliveryReconcile';
  state: 'available' | 'unavailable' | 'unverified'; version: string;
  checkedAt: Instant; evidence: string;
}

export interface PreparedProfile {
  version: string; systemText: string; userText: string; allowedTools: string[];
  seedProjectionIds: Id[];
  contextRefs: ContextRef[];
}

export interface InvestigationProfileInput {
  run: AnalysisRun; initialInput: FrozenRunInput; seedProjections: EvidenceProjection[];
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

## 本模块 SQL 映射附件

以下包含本模块表及外键依赖表的统一结构。仅本模块拥有的表可直接写入，其余表通过公开端口或同步 InTx 方法操作；不得自行改列名或状态。

<!-- SQL:BEGIN -->
```sql
-- 设计附件 0.2.0（2026-10-23）；每个主体空间独立数据库；仅核心进程可打开写连接。
-- JSON 列由运行时 schema 校验；业务状态以关系列为准。
PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
CREATE TABLE space_metadata(space_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, identity_epoch INTEGER NOT NULL CHECK(identity_epoch>0));
CREATE TABLE runtime_settings(key TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0), value_json TEXT NOT NULL);
CREATE TABLE connections(
  id TEXT PRIMARY KEY, platform_instance_id TEXT NOT NULL, display_name TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>0), indexer_base_url TEXT, server_base_url TEXT,
  indexer_secret_ref TEXT, server_secret_ref TEXT, ca_ref TEXT,
  alerts_pattern TEXT NOT NULL, archives_pattern TEXT, mapping_version TEXT NOT NULL,
  principal_fingerprint TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE capabilities(
  connection_id TEXT NOT NULL REFERENCES connections(id), name TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('available','denied','unreachable','unsupported','unverified')),
  checked_at TEXT NOT NULL, evidence TEXT NOT NULL, endpoint_kind TEXT NOT NULL,
  PRIMARY KEY(connection_id,name)
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
CREATE TABLE execution_attempts(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES analysis_runs(id), attempt INTEGER NOT NULL,
  operation TEXT NOT NULL, phase TEXT NOT NULL, host_identity_json TEXT NOT NULL,
  session_id TEXT, user_message_id TEXT, result_message_id TEXT, snapshot_json TEXT,
  intent_at TEXT NOT NULL, observed_at TEXT, UNIQUE(run_id,attempt,operation)
);
CREATE TABLE mcp_grants(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES analysis_runs(id), role TEXT NOT NULL,
  token_digest TEXT NOT NULL UNIQUE, secret_ref TEXT NOT NULL, tool_epoch INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','active','revoked')), binding_json TEXT,
  expires_at TEXT NOT NULL
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
CREATE TABLE result_deliveries(
  id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES origin_bindings(id),
  request_id TEXT NOT NULL, run_id TEXT, result_version INTEGER NOT NULL,
  delivery_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('pending','sending','delivered','uncertain','retryable_failed','blocked')),
  attempts INTEGER NOT NULL, receipt_json TEXT, last_error_json TEXT, next_attempt_at TEXT,
  FOREIGN KEY(request_id,result_version) REFERENCES result_packages(request_id,result_version)
);
CREATE TABLE domain_events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
  revision INTEGER NOT NULL, trace_id TEXT NOT NULL, occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL
);
CREATE INDEX idx_events_aggregate ON domain_events(aggregate_id,seq);
CREATE TABLE diagnostic_events(
  id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, code TEXT NOT NULL, safe_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE cleanup_plans(
  id TEXT PRIMARY KEY, plan_hash TEXT NOT NULL, plan_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('preview','applied','expired')), expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
```
<!-- SQL:END -->
