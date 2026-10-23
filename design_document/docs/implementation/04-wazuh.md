# S04 连接、能力目录与 Wazuh 只读适配

工程契约版本：0.2.0；修订日期：2026-10-23。状态：新增实现设计；真实 API 只有既有抽样证据，客户端实现尚未完成。本文可独立交付 Agent。

## 1. 范围与已有依据

实现 `packages/wazuh-adapter/src/{connections,auth,capabilities,queries,pagination,mapping,tls}.ts`，导出 ConnectionService。Wazuh 是唯一首版上游，客户端直接使用 Indexer/Server API，不依赖 Dashboard 登录、内部代理或面板 token。只使用已经汇聚的数据，不改平台配置、不触发扫描/命令。

既有 2026-10-22 专用身份抽样：Indexer 告警/归档搜索和固定 24h 告警等级/小时聚合通过；漏洞与两类清单状态索引 403。Server 独立认证、设备列表与单台设备 OS/硬件/软件/进程/端口、FIM 对象、SCA 通过。严格 TLS、连续分页、全设备权限和持续认证未验收。上述是独立实验记录，不是本模块已交付。

## 2. 依赖、数据与身份

只依赖 contracts、DatabasePort、SecretPort、ClockPort、IdPort 和注入的 HttpPort。拥有 connections/capabilities；不写案件、报告或预算账本。使用 PlatformCall.beforeAttempt，在每次实际网络请求前取得许可；失败则不发请求。agents/capabilities等不带PlatformCall的方法使用内部后台预算：每次操作最多20次网络尝试，统一平台并发仍为2；预算耗尽保留partial/unverified，不继续探测。

HttpPort为受信任基础设施，默认严格TLS、禁止跨origin重定向、单响应最多4MiB；body/headers只在内存，不落日志，超限明确失败。它不暴露给UI/MCP。模块提供真实HTTPS实现与可注入fake，具体HTTP库不成为跨模块依赖。

ConnectionProfile 是内部 DTO，含 secretRef 与入口，不直接原样送 Renderer。save 使用 expectedGeneration CAS：新建为 1，修改入口/身份/凭据/映射/CA 时 generation+1；改变主体时通知 S03 切换空间。capabilities 记录具体组件与核实时间。不能以 GET / 返回 403 把所有业务能力判不可用。

## 3. 接口白名单与认证

| 能力 | 允许路径 | 处理 |
|---|---|---|
| Server 登录 | `POST /security/user/authenticate?raw=true` | 该侧 Basic 获取 JWT；JWT 只在内存，后续 Bearer |
| 设备 | `GET /agents` | limit/offset/select；核对 error、affected_items、total_failed_items |
| 清单 | `GET /syscollector/{agentId}/{os,hardware,packages,processes,ports}` | agentId 从获准范围解析；类别枚举映射固定路径 |
| FIM 对象 | `GET /syscheck/{agentId}`、`/last_scan` | 可用于设备详情，不实现 file_changes 搜索 |
| SCA | `GET /sca/{agentId}`、`/sca/{agentId}/checks/{policyId}` | policyId 来自可见策略；不执行返回的 command/rules |
| 告警 | `POST /<configured-alert-pattern>/_search` | Basic；由代码生成受控 DSL |
| 归档 | `POST /<configured-archive-pattern>/_search` | 只有映射确认后支持 authentication；普通归档不自动分类 |
| 漏洞 | `POST /wazuh-states-vulnerabilities-*/_search` | 当前能力 denied；后续获准再启用 |

默认端口 9200/55000 仅作配置帮助，不从 Dashboard 地址推导入口。拼接 URL 保留基础地址代理前缀；动态路径逐段编码；拒绝 userinfo、任意绝对路径、`..`、通配符扩大和重定向到另一 origin。不同组件的认证头不得互换。

所有请求严格证书验证，使用明确 CA；不提供全局跳过校验。401 时 Server 可以 single-flight 重新认证一次，再重试原只读查询；登录与重试均计平台请求。Indexer 401 不用 Server 凭据重试。403 不做自动重试；429/5xx 只在剩余期限/预算下最多一次受控退避重试，拒绝无限循环。

## 4. 查询与映射

alerts 必须包含 connectionId、agentIds 子集、`timestamp >= from AND timestamp < fixedUpper`，上界不大于 scope.to。投影白名单先包含 timestamp/@timestamp、agent.id、rule.id/level/groups；description、IP、用户等按映射能力确认后启用。缺失字段省略，不给默认恶意解释。

SourceLocator 的告警身份是 platformInstanceId/index/documentId；resource 身份是平台/资源类别/agentId/collectionIdentity。collectionIdentity 需要可确定的原生行键或稳定字段组合加扫描标识；不能只用返回第几条或内容哈希当事件身份。无法确定时标记来源限制，不伪称跨刷新去重可靠。

observedAt 来源于已核实事件/扫描字段；retrievedAt 是本次查询完成时间。保留原始时区字段在 fields 中，标准 observedAt 转 UTC；清单过旧、无扫描时间、仅监听端口都保留解释限制。FIM 对象数量不是变更次数，软件漏洞命中不是利用证据。

deviceDetail给设备页返回DeviceDetail，不套用调查时间窗Coverage：单台设备、类别白名单、分页、SourceRecord自己的观察/扫描时间与retrievedAt。fim_objects走对象路径并明确对象语义；sca先返回策略，检查详情的后续契约须明确policyId，首版不让UI猜路径。该接口同样受认证、平台并发与本地后台请求上限约束，不消耗模型工具次数。

authentication 仅在成功/失败映射、身份命名空间、来源类型均确认后开放；账号关联需 namespace+name，IP 相同不足以确认同一主体。file_changes 需要可查询 FIM 事件与字段映射，不能用 `/syscheck` 对象表代替事件历史。inventory/finding 每次 query 仅一个 agent；总 run 可以最多 5 台。查询类型与实际 capability 对不上返回 CAPABILITY_UNAVAILABLE。

## 5. 分页与覆盖

每个逻辑搜索分配 queryId；每页分配 pageId 与从 0 起的 pageOrdinal。同一 cursor 重试保持同一页身份，原始响应不一致时不能覆盖既有快照。cursor 为随机不透明 token，服务端保存原 query、固定上界、主体、连接 generation、runId、排序、下一页位置、已读页数和期限；不把任意上游 DSL 放进客户端可改写 cursor。

Server 用 offset/limit，列表先核对 total 与本次返回；多页动态变化仍需标记其一致性限制。Indexer 先实现固定窗口第一页；稳定后续排序/search_after 或 PIT 必须按实际安装版本验证后才把 stable_alert_pagination 标 available。禁止臆测 `_id` 可排序。稳定分页未通过时返回 partial、不给伪造 nextCursor，收件箱用显式重叠窗重查并显示覆盖缺口。

调查每页<=50、每组<=4页；有下一页、失败分片、timed_out=true、Server 局部失败均 partial。最后一页只有在同组前页均成功取得并经 S06 保存后，整个 query 才能标 complete；不能单凭最后一页为空认定整窗完整。collectionCoverage 默认 unknown，query 完整不证明采集完整。

## 6. 请求预算与取消

每次网络发送前按顺序：检查 ctx/连接 generation/AbortSignal → await beforeAttempt → 再检查截止时间和取消 → 发送。登录、分页、重试都调用 beforeAttempt；响应 platformAttempts 只作报告，账本以预占记录为准。全应用平台并发<=2，包括提醒与面板；调查优先，后台请求可等待，但不延长 run 截止时间。

请求返回后再次核对 identityEpoch/generation；过期或身份改变的结果不交付模型。连接层可返回安全失败诊断，不能用旧成功数据伪装刷新成功。缓存命中不计网络请求，仍返回原观察/取得时间和 cache 标记原因；工具执行计数由 S09/S07 负责。

## 7. 面板统计

statistics 是确定性 API，不调用模型。请求 size=0、track_total_hits=true、同一 UTC 半开时间窗；按 rule.level terms 聚合与 timestamp 1h histogram。输出 total.relation、桶、Coverage；timed_out、分片失败、sum_other_doc_count/误差决定 partial。首尾部分小时保留真实时间，不把 25 个桶说成 25 小时。

面板可用 24h 范围，与单轮调查 1h 分开验证。不能硬编码历史 3117 条或具体分布；归档与告警不相加，设备可见总数不当在线数。漏洞 403 返回权限受限，禁止变 0。

## 8. 独立验收与交接

用注入 HTTP fake 检查两侧认证隔离、代理前缀拼接、重定向拒绝、401 单次重登、403 独立能力、TLS 错误、失败分片、分页参数不可篡改、零匹配与缺权区分、取消后不交付、每次尝试预算回调、旧扫描时间和统计 total.relation。

交付路径白名单、字段映射版本、能力事实表、合成响应、端口实现和可选真实联调说明。未测分页与严格 TLS 必须明确列未通过，不能因为 fake 通过就标真实兼容。

## 9. 内嵌统一契约

固定导出`createWazuhAdapter(deps):ConnectionService`；deps字段为`db:DatabasePort,secrets:SecretPort,clock:ClockPort,ids:IdPort,http?:HttpPort`。构造不访问网络，未提供http时使用本模块严格TLS实现；fake只经显式注入启用。

### 平台扩展边界

应用查询方只注入PlatformQueryPort，连接信息使用ConnectionReadPort；ConnectionProfile中的Indexer/Server配置仅在连接管理和Wazuh适配侧使用。当前Scope.agentIds、能力名称和配置仍面向Wazuh，不宣称通用平台即插即用；第二平台属于后续独立映射与契约评审，不是本次实现任务。统计24h与调查1h限制继续分开。

<!-- CONTRACT:BEGIN roots=ConnectionService,ConnectionProfile,Capability,PlatformQuery,PlatformPage,PlatformCall,AlertStatistics,HttpPort,SecretPort,DatabasePort -->
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
```
<!-- CONTRACT:END -->

## 本模块 SQL 映射附件

以下包含本模块表及外键依赖表的统一结构。仅本模块拥有的表可直接写入，其余表通过公开端口或同步 InTx 方法操作；不得自行改列名或状态。

<!-- SQL:BEGIN tables=connections,capabilities -->
```sql
PRAGMA foreign_keys = ON;

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
```
<!-- SQL:END -->
