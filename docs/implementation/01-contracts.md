# S01 公共契约与边界校验

工程契约版本：0.2.0；修订日期：2026-10-23。状态：本轮新增实现设计，未实现/未联调；业务基线仍为 v4.2。本文可独立交付实现 Agent，文末内嵌完整接口。

## 1. 目标、范围与代码归属

校安智脑是 Wazuh 数据之上的本地安全调查工作台。告警、客户端主动问题、TeleAgent 委派进入同一核心；专用调查会话通过受限工具补证，结果持久化并按来源回传。本模块负责让这些模块说同一种协议。

实现 `packages/contracts/src/{index,schemas,limits,canonical,errors}.ts`。`index.ts` 导出文末类型；`schemas.ts` 对每个跨边界 DTO 提供运行时解析器；禁止 import Electron、数据库、平台客户端或其他业务模块。可选 schema 库在验证后锁定，调用方只依赖 `parseX(input:unknown):Result<X>`，不依赖某库异常类型。

## 2. 类型和序列化

| 项 | 强制规则 |
|---|---|
| 业务 ID | 新建对象用 UUID v4 小写字符串；平台 Agent ID、消息 ID 保留原值，不能转数字丢前导 0 |
| Instant | 系统输出 UTC ISO 8601、毫秒、`Z`，如 `2026-10-22T12:00:00.000Z`；输入允许带明确偏移，规范化后保存；拒绝无时区时间 |
| 时间范围 | 半开区间 `[from,to)`；from < to；timeZone 为有效 IANA 名称；对外 Wazuh 转换规则由 S04 实现 |
| 空值 | DTO 的缺失可选值省略；`null` 仅用于 JSON 材料本身；SQL NULL 转省略；JSON 不接受 NaN/Infinity/BigInt/函数 |
| 枚举 | 完全沿用文末字符串；未知枚举拒绝，不能自动落到成功/良性 |
| 额外字段 | 请求对象拒绝未知键；上游响应先白名单映射再生成 DTO；内部记录升级必须有明确版本转换 |
| 字段名 | IPC/MCP/业务 DTO camelCase；原始平台字段保留嵌套名字；数据库映射使用 snake_case |
| 秘密 | SecretRef 是不透明引用；秘密值不进入 AppError、DomainEvent、报告、查询记录和导出 |

TypeScript 类型不构成授权。`Actor` 由 S03 或 S09 从可信上下文创建；禁止接收 UI/MCP JSON 中的 actor、role、principalId 或 identityEpoch。拒绝模型输入中自选的 originBindingId 和 runId 授权效果。

## 3. 统一限制与输入校验

导出不可变 `DEFAULT_LIMITS`，字段和值如下；业务模块读取同一对象，不复制常量。这里是项目起始配置，不是平台官方限制。

| 字段 | 值 | 应用范围 |
|---|---:|---|
| activeInvestigations | 1 | 全应用，包括取消未核实/uncertain 时的保留槽位 |
| queueCapacity | 20 | 三入口待运行总量，含 coalescing，不含 awaiting_scope |
| maxRunAgents / maxRunWindowMs | 5 / 3600000 | 调查范围；设备列表、面板 24h 统计不受该调查上限限制 |
| requestTtlMs / autoQueueTtlMs | 900000 / 900000 | 接受新主动请求/自动候选时起算 |
| runTtlMs / queryTimeoutMs | 300000 / 10000 | run 从 preparing 起计；每次业务查询起始超时 |
| toolCalls / readCalls / platformAttempts | 12 / 10 / 20 | 所有取证工具/其中读取工具/每次实际平台请求，重试也计数 |
| distinctEvents / toolTextBytes | 300 / 16384 | 告警与普通认证事件身份去重总量/单次 UTF-8 工具文本 |
| platformConcurrency / pageSize / maxPages | 2 / 50 / 4 | 获准查询并发/调查分页/每个逻辑搜索组页数 |
| watchIntervalMs / watchOverlapMs | 10000 / 30000 | 运行期轮询；重叠长度为本轮工程起始建议，非无遗漏保证 |
| recoveryWindowMs / coalesceMs | 1800000 / 10000 | 默认补查最近 30 分钟/自动候选初始等待 |
| candidateMaxSpanMs / candidateIdleMs | 1800000 / 600000 | 自动候选最大跨度/不活动间隔 |
| autoDailyAttempts | 10 | 连接主体＋明确时区下的自动启动尝试 |
| questionChars / noteChars / idempotencyChars | 2000 / 8000 / 128 | Unicode code point；键 1—128，拒绝控制字符 |

文本类型都限定长度；分页 limit 为 1—50 的整数；等级为 0—15 的整数或未知，不造高/中/低映射。调查/案件的非空 agentIds 去重排序后最多 5 个；无范围请求进入 needs_input。统计与轮询可接受明确选择的1—1000个获准设备，仍不接受空数组表示全校。主体无权数据不可通过缩小到空数组返回成功。ruleIds/ruleGroups各最多20个、每值最多128字符；cursor最多2048字节。

AlertFilter同维度数组是OR，不同维度是AND；ruleGroups按任一精确组名匹配，minLevel为原生数值下界。空过滤对象是不加该维度约束；未知等级不满足已设置minLevel，仍保留在未过滤收件箱。

报告上限：facts/analysis/conflicts 各最多 20 项，gaps/followups 各最多 20 项；每段文本最多 2000 字，每项引用最多 20 个。超出 16 KiB 工具信封时返回明确的大小错误与缩减建议，不截断 JSON；候选可先精简再提交，已有材料仍保留。

补充边界：MCP请求体最多256KiB、ReportCandidate规范JSON最多64KiB；工具返回16KiB是输出上限。IPC单请求最多1MiB（含最多512KiB PEM），username/password各最多4096 UTF-8字节；默认不记录任何请求体。PreparedProfile.userText最多32KiB，超量先按白名单减少种子/背景并明确省略，不暗删重要限制。

## 4. 幂等、哈希与错误

提供 `canonicalJson`：对象键按 Unicode 码点排序；数组顺序保留；不支持的 JSON 值拒绝；UTF-8 无 BOM。无序 agentIds/ruleIds 在调用前去重排序。哈希为 SHA-256 小写十六进制，运行环境注入 digest 实现，契约包不持有密钥。

请求哈希包含规范问题、origin、connectionId、绝对请求范围、seedRefs、caseId、autoCandidateId；排除 traceId、发送时间和 UI requestId。幂等作用域为 spaceId/principalId/可信 originKey/idempotencyKey。相对时间由入口在首次请求时解析，重试沿用第一次绝对时间，不能每次重新解析“最近半小时”。

本地列表游标统一base64url(JSON `{version:'0.1.0',spaceId,queryHash,lastKeys}`)，严格校验字段、当前space、筛选hash与排序键类型；不具有授权效果，不允许游标改变筛选。平台查询游标由S04保存服务端状态，不能混用本地游标。

`Result` 的错误分支一律显式处理。`retryable=true` 表示可考虑再操作，不能授权自动重提模型；UNCERTAIN 即使网络可恢复也必须先核实。上游错误详情只保留组件、HTTP 状态、受控原因码和 traceId；不得拼接原始响应、URL 凭据或认证头。

## 5. 事件、版本与事务约定

`case.revision` 是业务输入/人工决定版本；`JobRecord.revision` 是任务 CAS 版本；`ReportRecord.version` 在同一 run 内递增；`resultVersion` 在同一 request/run 内递增；`toolEpoch`、`policy.epoch`、`identityEpoch` 是各自的授权代次，不能混用。

业务事件只作 UI 同步与可观察记录。必须原子完成的用例用 `*InTx(tx,ctx,...)` 同步方法，禁止在 `DatabasePort.write` 的回调内 await。若回调返回错误，S02 回滚，即使前面执行了 SQL。事件提交后才唤醒订阅者。

`DomainEvent` 的每个 payload 字段就是允许集合；不得添加原始日志或秘密。UI 先取 snapshot 的 eventSeq 再读取后续事件；序号只在同一 space 内比较。事件清理后应 resetRequired，不猜测遗漏内容。

## 6. 独立验收与交接

必须覆盖：未知字段/枚举、无时区日期、from>=to、5 与 6 台边界、1h 与超限、UTF-8 多字节 16 KiB 边界、规范哈希稳定、同键不同参数、NULL 与省略转换、所有 DesktopMethodMap 输入/输出的 schema。用合成值，不访问平台。

交付所有导出类型、parse 函数、默认限制及其验证向量；契约使用 `tsc --strict --noEmit --target ES2022 --lib ES2022,DOM` 检查。具体依赖不能通过“安装最新”漂移，首个可运行工程提交锁文件。尚未获证据的真实宿主功能在 capability 中保留 unverified。

## 7. 内嵌统一契约

以下是唯一原文的完整副本；实现 Agent 无需取得其他设计文档。修改需回写原文再同步。

### 0.2.0 的边界与版本

工程契约为0.2.0，Desktop/MCP/导出信封仍0.1.0；外部schemaVersion不能用工程版本全局替换。初始化DDL仍名0001，但尚无产品数据库，本轮增补analysis_runs的prepared_profile_json/completion_decision_json；已经用旧设计建库的实验者须提交显式迁移，不覆盖既有迁移校验值。

代码实现按common/platform/cases/investigations/host/mcp/reports/delivery/desktop分文件并从统一入口导出，文档契约原文仍是本文件附件；不复制内嵌类型到多个产品包。S07仅消费EvidenceChannelControlPort，S08消费BindingPort，S09入口消费InvestigationToolPort，S10消费显式输入和CompletionDecision。

依赖方向、表所有者和组件允许端口见[architecture.json](architecture.json)，跨界规则见[边界说明](boundaries.md)。运行时schema须同时覆盖外部输入和新增内部快照，不接受从模型传入ReportValidationInput、CompletionDecision或FrozenRunInput冒充核心事实。

<!-- CONTRACT:BEGIN roots=* -->
```typescript
/**
 * 校安智脑子系统设计契约 0.2.0（2026-10-23；设计附件，不是已实现 SDK）。
 * 名称、字段、枚举是本设计包的统一接口；业务基线仍为 v4.2。
 * 不依赖 Electron、数据库驱动、MCP SDK、UI 框架或真实平台凭据。
 * 实现时按领域文件组织，统一导出等价声明并补运行时 schema，禁止模块复制类型。
 */

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
export interface HttpRequest {
  method: 'GET' | 'POST'; url: string; headers: Record<string, string>;
  bodyText?: string; timeoutMs: number; signal: AbortSignal; caPem?: string;
}
export interface HttpResponse { status: number; headers: Record<string, string>; bodyText: string }
export interface HttpPort { request(input: HttpRequest): Promise<Result<HttpResponse>> }

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
export type RequestCommandPort = Pick<RequestService, 'create' | 'provideInput' | 'cancel'>;
export type RequestReadPort = Pick<RequestService, 'status'>;
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

export interface HostCapability {
  name: 'signedApi' | 'dedicatedProfile' | 'isolatedEvidenceChannel' | 'trustedOrigin'
    | 'asyncDelivery' | 'deliveryReconcile';
  state: 'available' | 'unavailable' | 'unverified'; version: string;
  checkedAt: Instant; evidence: string;
}
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
export interface HostMessage {
  kind: 'external_investigation_result'; mediaType: 'application/json'; text: string;
}
export interface HostCapabilitiesPort {
  capabilities(ctx: CallContext): Promise<Result<HostCapability[]>>;
}
export interface TrustedOriginPort {
  resolveOrigin(ctx: CallContext, trustedTransportBindingId: Id): Promise<Result<OriginBinding>>;
}
export interface HostDeliveryPort {
  binding(ctx: CallContext, bindingId: Id): Promise<Result<OriginBinding>>;
  deliver(ctx: CallContext, input: { binding: OriginBinding; deliveryKey: string; message: HostMessage }): Promise<Result<HostReceipt>>;
  reconcileDelivery(ctx: CallContext, input: { binding: OriginBinding; deliveryKey: string }): Promise<Result<{ state: 'found' | 'absent' | 'unknown'; receipt?: HostReceipt }>>;
}
export interface HostAccessPort extends HostCapabilitiesPort, TrustedOriginPort, HostDeliveryPort {}
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
export interface InvestigationStepInput {
  phase: 'orientation' | 'querying' | 'evaluating' | 'stopped';
  summary: string; purpose?: string; evidenceRefs: DeliveredRef[];
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
export type EvidenceChannelBindingPort = Pick<EvidenceChannelPort, 'bindChannel'>;
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
export interface ResultPackageReadPort {
  getInTx(tx: ReadTx, ctx: CallContext, input: { requestId: Id; resultVersion?: number }): Result<ResultPackage>;
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
