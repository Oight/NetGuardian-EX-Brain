# S08 TeleAgent 宿主接入、执行驱动与可信来源

工程契约版本：0.2.0；修订日期：2026-10-23。状态：新增实现设计，真实宿主接入能力仍有 M0 未通过项。本文可独立实现协议层与受控 fake；不能把未获证据的宿主能力写成已支持。

## 1. 范围与证据

实现 `packages/teleagent-bridge/{host-access,signed-client,wire-driver,execution,origin,repositories}.ts`，导出 ExecutionPort、HostAccessPort。该模块不创建业务请求、不写案件、不调度下一轮，只管理本应用已知会话与宿主操作。

已有 TeleAgent 2.7.0 研究分别证明：隔离 Go 实例的签名、会话、模拟模型/MCP/SSE/取消；已登录桌面的一次真实合成文本，工具被禁用。没有证明稳定公开的桌面凭据接入、逐会话工具通道、可信来源会话元数据或原对话异步回传。历史读取进程环境的实验不作为产品默认机制或本次授权。

## 2. 依赖与分层

| 内部层 | 职责 | 失败边界 |
|---|---|---|
| HostAccess | 从明确授权的宿主接入机制取得端点、签名操作、宿主身份、可信绑定与投递能力 | 无机制则对应 capability unverified/unavailable |
| SignedClient | 编码最终URL、生成签名、受控HTTP/SSE、只解码必要字段 | 不落完整config/provider响应 |
| VersionWireDriver | 对固定已验证宿主版本映射创建/提示/消息结构与工具配置 | 版本不匹配不猜参数继续 |
| Execution | 保存intent/映射、消息关联、终态与取消核实 | 204/idle不等于完成 |

依赖 DatabasePort、SecretPort、ClockPort、IdPort、EvidenceChannelBindingPort 的可信通道绑定及注入 HTTP/SSE transport。拥有 execution_attempts 和 origin_bindings。S07 独占业务 JobState；桥接只返回规范化 ExecutionSnapshot。

## 3. 连接事实表与默认行为

capabilities 必须逐项返回 signedApi、dedicatedProfile、isolatedEvidenceChannel、trustedOrigin、asyncDelivery、deliveryReconcile 的状态/版本/核实时间/证据。初始全部unverified；不能仅因 `/ready` 返回200就改为available。

提供 `UnavailableHostAccess`：所有需要能力的操作返回 CAPABILITY_UNAVAILABLE。提供 `SyntheticHostAccess`：只用于明确标识的合成验收。LiveHostAccess 只有在接入机制及版本事实表完成后开启，未实现的项明确失败，不能返回假receipt。

端点必须匹配授权本机宿主，不硬编码历史端口或扫描全端口。签名凭据来自接入适配器或自行管理密钥的隔离验证实例；不自动读进程环境、其他会话、个人配置或数据库。平台身份与模型外发范围分别记录。

## 4. 已研究样本的签名协议

以下只适用于所测 local-v1，不推断其他版本通用：

```text
canonical = "local-v1\n" + METHOD.upper() + "\n"
          + final_encoded_path_and_query + "\n"
          + unix_milliseconds_decimal + "\n" + nonce
signature = base64url_no_padding(HMAC_SHA256(key_utf8, canonical_utf8))
headers:
  X-SA-Sign-Version: local-v1
  X-SA-Timestamp: <unix milliseconds>
  X-SA-Nonce: <fresh random value>
  X-SA-Signature: <signature>
```

key 使用原字符串UTF-8，不先Base64解码。必须对最终编码路径和原始查询串签名，签名后禁止重新排序或编码；不加未经验证的尾斜杠。每次重试新时间戳/nonce，旧签名重放会被拒绝。样本观察到过期拒绝，精确时间差边界未动态验证。请求体未包含在该已观察签名串中，不能宣称它提供完整消息体独立签名保证。

Node 实现可以注入 `sign({method,encodedPathAndQuery,timestamp,nonce})`，签名材料不从端口返回；单元验证用固定合成密钥和离线HMAC测试向量。不能把真实认证头写入诊断。

## 5. 端点与版本映射

| 操作 | 已观察端点/响应 | 使用规则 |
|---|---|---|
| 就绪 | GET /ready，data.status=ready | 仅就绪，不证明认证/模型可用 |
| 新建 | POST /session，200且会话对象在根部 | 保存真实返回id，目录保持一致 |
| 提交 | POST /session/{id}/prompt_async，204 | 只记响应，回读userMessage |
| 读取 | GET /session/{id}/message，消息数组含info/parts | 过滤本run的用户消息/对应parentID |
| 状态 | GET /session/status，状态映射 | 仅辅助，不读取无关会话业务内容 |
| 事件 | GET /event，SSE | 仅处理本会话事件，重连后回读消息 |
| 中止 | POST /session/{id}/abort，样本返回true | 再观察消息终态，不以true直接宣称cancelled |
| 来源通知 | 没有项目链路实测 | HostAccess.deliver/reconcile默认未可用 |

创建请求体、专用配置、Agent/模型选择、工作目录传递及prompt parts必须由 VersionWireDriver 的已核实映射提供；不把历史主Agent名称/路由写死，也不凭文档臆造 `/agent` 列表接口（所测返回404）。独立Agent应交付以下稳定内部接口：

```typescript
interface VersionWireDriver {
  createSession(input: { directory: string; profileVersion: string }): Promise<Result<{ sessionId: string }>>;
  submit(input: { sessionId: string; userText: string; systemText: string; marker: string }): Promise<Result<{ accepted: boolean }>>;
  messages(sessionId: string): Promise<Result<unknown[]>>;
  abort(sessionId: string): Promise<Result<{ accepted: boolean }>>;
}
```

这里directory由S03/S08受控生成，不来自模型路径。未完成真实body映射前可实现fake/不可用driver，但必须在交接中标为M0缺口；禁止用自动读取个人配置兜底。签名与上述已知端点足够实现协议层，不代表真实宿主专用调查配置已解决。

## 6. start/inspect/abort

start前检查run期限、宿主身份、dedicatedProfile与isolatedEvidenceChannel；将创建意图持久化后创建会话，成功即保存sessionId。然后通过可信宿主连接把pending channel绑定到该session；验证工具可见清单与拒绝行为后，channel才active。共享应用密钥但无可信会话身份时禁止激活。

提交前存submit intent，userText包含非秘密的runId和唯一marker；提交后回读本session找到包含本次marker的用户消息，保存userMessageId。marker只作关联，不提供授权。创建/提交响应丢失时phase=uncertain；没有明确核对机制不枚举所有个人会话猜测，也不自动新建。

inspect匹配 `assistant.info.parentID == userMessageId`；核对 `time.completed`、最终finish（样本正常为stop）、无error，识别tool_calls中间轮不能当终结。只有用户消息/parent关联、正常finish且无error全部核实，才返回phase=completed、verification=verified；这些wire检查留在本模块，不向S10暴露parentMatched/normalFinish。异常结构、重复不匹配消息保留uncertain/failed。消息正文只保留本项目必要内容，不能整份宿主历史落盘。

SSE用于进度提示；断线按退避重连并回读已知消息，不重提prompt。abort只针对保存sessionId，先由S07撤销工具，再请求宿主；记录请求与观察分离。远端在取消前已完成时返回真实completed，由S07决定业务needs_review，不能重写成取消。

## 7. 可信来源与投递原语

resolveOrigin接收的是由认证宿主适配器/独立通道产生的trustedTransportBindingId，不能从模型arguments传入。校验宿主、账号、工作区、会话和请求消息后创建origin_bindings；模型提供sessionId只能做一致性检查。

deliver只向已绑定来源交付S11生成的HostMessage，deliveryKey由S11确定。HostReceipt要求实际可见消息身份与observedAt；HTTP接受或追加到调查会话不足。来源忙碌时返回明确可重试/排队状态，不能打断正在进行的用户对话。reconcile返回found/absent/unknown；没有实际查询能力就unknown。

这两个方法是项目适配端口，不是已证实的TeleAgent原生API。若真实宿主不能提供，保留CAPABILITY_UNAVAILABLE；用户主动get_result可独立通过，但全部P0异步回传仍未通过。

## 8. 独立验收与交接

离线覆盖编码后签名、中文/空格目录、query顺序、nonce重放、错误body、204不存在会话、消息parent不符、tool_calls中间轮、SSE断开、创建/提交响应丢失、abort后未知、身份切换、投递接受但不可见。合成driver必须能模拟这些路径。

交付协议适配、版本映射事实表、capability记录、会话Repository与fake。真实验证报告逐项标静态/模拟/真实文本/真实工具/来源回传；不得把前一项通过推导下一项。参考[来源登记：既有隔离记录](../reference-index.md#source-04)与[来源登记：真实文本记录](../reference-index.md#source-03)仅作追溯。

## 9. 内嵌统一契约

固定导出`createTeleAgentBridge(deps):{execution:ExecutionPort;hostAccess:HostAccessPort}`；deps字段为`db,clock,ids,secrets:SecretPort,channels:EvidenceChannelBindingPort,wire?:VersionWireDriver,hostAccess?:HostAccessPort`。wire/hostAccess未提供时采用不可用实现，不发现或获取进程凭据。真实适配由本模块实现并显式配置，测试可分别注入wire和hostAccess fake。

### 窄端口与不可变发送材料

HostAccessPort是组合入口；S09仅取得TrustedOriginPort，S11仅取得HostDeliveryPort，运行设置仅取得HostCapabilitiesPort。HostDeliveryPort.binding从本模块Repository返回核权绑定摘要，投递方不直接查询origin_bindings。HostMessage包含固定kind/mediaType/text；S08只按协议发送，不解释报告字段。HostReceipt需真实可见消息与身份匹配，不能以HTTP接受替代。

S08只调用独立通道组件的bindChannel，不调用MCP路由器，也不扣业务预算。S07将PreparedProfile保存到自己的prepared_profile_json，S08仅保存执行intent/映射。verification=verified代表该phase的宿主事实已核实，不等于业务成功或用户已读。初始消息核实必须同时核对对应文字/marker，S07才能释放seed投影。

<!-- CONTRACT:BEGIN roots=ExecutionPort,HostAccessPort,HostCapability,OriginBinding,ChannelHandle,EvidenceChannelBindingPort,DatabasePort,SecretPort -->
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

export interface Scope {
  connectionId: Id;
  agentIds: string[];
  from: Instant;
  to: Instant;
  timeZone: string;
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

export interface ContextRef { contextId: Id; version: number }

export interface AnalysisRun {
  id: Id; jobId: Id; caseId: Id; baseRevision: number; scope: Scope;
  connectionGeneration: number; identityEpoch: number; profileVersion: string;
  toolEpoch: number; expiresAt: Instant; manifestHash?: string;
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

export interface EvidenceChannelPort {
  openChannel(ctx: CallContext, run: AnalysisRun): Promise<Result<ChannelHandle>>;
  bindChannel(ctx: CallContext, input: { channelId: Id; runId: Id; trustedSessionBindingId: Id }): Promise<Result<ChannelHandle>>;
  revoke(ctx: CallContext, runId: Id): Promise<Result<void>>;
  revokeAll(ctx: CallContext): Promise<Result<void>>;
}

export type EvidenceChannelBindingPort = Pick<EvidenceChannelPort, 'bindChannel'>;
```
<!-- CONTRACT:END -->

## 本模块 SQL 映射附件

以下包含本模块表及外键依赖表的统一结构。仅本模块拥有的表可直接写入，其余表通过公开端口或同步 InTx 方法操作；不得自行改列名或状态。

<!-- SQL:BEGIN tables=execution_attempts,origin_bindings -->
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

CREATE TABLE execution_attempts(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES analysis_runs(id), attempt INTEGER NOT NULL,
  operation TEXT NOT NULL, phase TEXT NOT NULL, host_identity_json TEXT NOT NULL,
  session_id TEXT, user_message_id TEXT, result_message_id TEXT, snapshot_json TEXT,
  intent_at TEXT NOT NULL, observed_at TEXT, UNIQUE(run_id,attempt,operation)
);
```
<!-- SQL:END -->
