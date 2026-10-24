import { z } from "zod";
import type * as T from "./types.js";
import { canonicalJson, utf8Bytes } from "./canonical.js";
import { fail, ok } from "./errors.js";

const s = z.strictObject;
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = integer.min(1);
export const idSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
const text = (max = 2000, min = 0) =>
  z
    .string()
    .refine(
      (value) =>
        Array.from(value).length >= min && Array.from(value).length <= max,
      "文本长度超限",
    );
const key = text(128, 1).refine(
  (value) => !/[\u0000-\u001f\u007f]/u.test(value),
  "键包含控制字符",
);
const nativeId = text(256, 1);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const bytesText = (max: number) =>
  z.string().refine((value) => utf8Bytes(value) <= max, "UTF-8 字节上限超出");
const timeZone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
});
export const instantSchema = z
  .string()
  .refine((value) => {
    const match =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(
        value,
      );
    if (!match) return false;
    const [, y, mo, d, h, mi, se] = match;
    const year = Number(y),
      month = Number(mo),
      day = Number(d);
    const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return (
      year >= 1000 &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= maxDay &&
      Number(h) < 24 &&
      Number(mi) < 60 &&
      Number(se) < 60 &&
      Number.isFinite(Date.parse(value))
    );
  }, "时间须为真实日期并带明确时区")
  .transform((value) => new Date(value).toISOString());
export const jsonSchema: z.ZodType<T.Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonSchema),
    z.record(z.string(), jsonSchema),
  ]),
);
export const jsonObjectSchema = z.record(z.string(), jsonSchema);
const httpsUrl = z
  .string()
  .url()
  .refine((value) => {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.hash &&
      !u.search
    );
  });
export const pageRequestSchema = s({
  cursor: bytesText(2048).optional(),
  limit: positive.max(50),
});
const agentIds = (max: number) =>
  z
    .array(nativeId)
    .min(1)
    .max(max)
    .transform((values) => [...new Set(values)].sort());
export const queryScopeSchema = s({
  connectionId: idSchema,
  agentIds: agentIds(1000),
  from: instantSchema,
  to: instantSchema,
  timeZone,
}).refine((value) => value.from < value.to, "时间区间必须非空");
export const scopeSchema = queryScopeSchema.refine(
  (value) =>
    value.agentIds.length <= 5 &&
    Date.parse(value.to) - Date.parse(value.from) <= 3600000,
  "调查最多 5 台设备、1 小时",
);
const count = s({ value: integer, relation: z.enum(["eq", "gte"]) });
export const coverageSchema = s({
  requestedScope: queryScopeSchema,
  effectiveScope: queryScopeSchema,
  queryCompleteness: z.enum(["complete", "partial", "not_executed"]),
  collectionCoverage: z.enum(["known", "partial", "unknown"]),
  sourceTypes: z.array(text(128)).max(30),
  reasons: z.array(text(500)).max(30),
  retrievedAt: instantSchema,
  observedFrom: instantSchema.optional(),
  observedTo: instantSchema.optional(),
  returned: integer,
  total: count.optional(),
}).refine(
  (value) =>
    value.effectiveScope.connectionId === value.requestedScope.connectionId &&
    value.effectiveScope.agentIds.every((id) =>
      value.requestedScope.agentIds.includes(id),
    ) &&
    value.effectiveScope.from >= value.requestedScope.from &&
    value.effectiveScope.to <= value.requestedScope.to,
  "实际覆盖不能扩大范围",
);
const errorCode = z.enum([
  "INVALID_INPUT",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "REVISION_CONFLICT",
  "NEEDS_INPUT",
  "QUEUE_FULL",
  "SCOPE_EXCEEDED",
  "CAPABILITY_UNAVAILABLE",
  "HOST_UNAVAILABLE",
  "BUDGET_EXHAUSTED",
  "EXPIRED",
  "CANCELLED",
  "UNCERTAIN",
  "UPSTREAM_AUTH",
  "UPSTREAM_DENIED",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_UNAVAILABLE",
  "TLS_UNTRUSTED",
  "PARTIAL_RESULT",
  "CURSOR_INVALID",
  "RESULT_NOT_READY",
  "VALIDATION_FAILED",
  "SECRET_STORE_UNAVAILABLE",
  "IDENTITY_CHANGED",
  "STORAGE_UNAVAILABLE",
  "INTERNAL",
]);
export const appErrorSchema = s({
  code: errorCode,
  message: text(2000),
  retryable: z.boolean(),
  details: jsonObjectSchema.optional(),
});
export const actorSchema = s({
  spaceId: idSchema,
  principalId: idSchema,
  identityEpoch: positive,
  role: z.enum(["ui", "system", "delegation", "evidence"]),
  originBindingId: idSchema.optional(),
  runId: idSchema.optional(),
});
export const callContextSchema = s({ actor: actorSchema, traceId: idSchema });
export const connectionProfileSchema = s({
  id: idSchema,
  spaceId: idSchema,
  platformInstanceId: idSchema,
  displayName: text(200, 1),
  generation: positive,
  indexerBaseUrl: httpsUrl.optional(),
  serverBaseUrl: httpsUrl.optional(),
  indexerSecretRef: idSchema.optional(),
  serverSecretRef: idSchema.optional(),
  caRef: idSchema.optional(),
  alertsPattern: key,
  archivesPattern: key.optional(),
  mappingVersion: key,
  principalFingerprint: text(256, 1),
  updatedAt: instantSchema,
});
export const capabilitySchema = s({
  name: z.enum([
    "alerts",
    "archives",
    "authentication_events",
    "agents",
    "inventory_os",
    "inventory_hardware",
    "inventory_packages",
    "inventory_processes",
    "inventory_ports",
    "fim_objects",
    "fim_events",
    "sca",
    "vulnerabilities",
    "stable_alert_pagination",
  ]),
  state: z.enum([
    "available",
    "denied",
    "unreachable",
    "unsupported",
    "unverified",
  ]),
  checkedAt: instantSchema,
  evidence: text(),
  endpointKind: z.enum(["indexer", "server"]),
});
const agentSummary = s({
  id: nativeId,
  name: text(256).optional(),
  status: text(64).optional(),
  version: text(64).optional(),
});
export const alertFilterSchema = s({
  ruleIds: z.array(key).max(20).optional(),
  ruleGroups: z.array(key).max(20).optional(),
  minLevel: integer.max(15).optional(),
});
export const sourceLocatorSchema = s({
  platformInstanceId: idSchema,
  kind: z.enum(["index_document", "resource"]),
  index: nativeId.optional(),
  documentId: nativeId.optional(),
  resource: key.optional(),
  agentId: nativeId.optional(),
  collectionIdentity: nativeId.optional(),
}).superRefine((v, c) => {
  if (
    v.kind === "index_document"
      ? !v.index ||
        !v.documentId ||
        v.resource !== undefined ||
        v.collectionIdentity !== undefined
      : !v.resource ||
        !v.agentId ||
        !v.collectionIdentity ||
        v.index !== undefined ||
        v.documentId !== undefined
  )
    c.addIssue({ code: "custom", message: "来源定位字段不匹配类别" });
});
const sourceKind = z.enum([
  "alert",
  "authentication",
  "inventory",
  "fim",
  "finding",
]);
const timeQuality = z.enum(["source", "ambiguous", "unknown"]);
export const sourceRecordSchema = s({
  source: sourceLocatorSchema,
  kind: sourceKind,
  agentId: nativeId.optional(),
  observedAt: instantSchema.optional(),
  timeQuality,
  retrievedAt: instantSchema,
  fields: jsonObjectSchema,
});
export const platformPageSchema = s({
  status: z.enum(["ok", "partial", "denied", "unavailable", "failed"]),
  queryId: idSchema,
  pageId: idSchema,
  pageOrdinal: integer.max(3),
  records: z.array(sourceRecordSchema).max(50),
  coverage: coverageSchema,
  nextCursor: bytesText(2048).optional(),
  warnings: z.array(text()).max(30),
  platformAttempts: integer.max(20),
}).refine(
  (v) => v.status !== "ok" || v.coverage.queryCompleteness === "complete",
  "ok 必须是完整查询",
);
const inventoryCategory = z.enum([
  "os",
  "hardware",
  "packages",
  "processes",
  "ports",
]);
export const platformQuerySchema = z.discriminatedUnion("kind", [
  s({
    kind: z.literal("alerts"),
    scope: queryScopeSchema,
    filter: alertFilterSchema,
    page: pageRequestSchema,
    fixedUpper: instantSchema,
  }).refine((v) => v.fixedUpper <= v.scope.to && v.fixedUpper > v.scope.from),
  s({
    kind: z.literal("authentication"),
    scope: scopeSchema,
    outcome: z.enum(["success", "failure", "any"]),
    account: s({ namespace: key, name: text(256, 1) }).optional(),
    sourceIp: text(128, 1).optional(),
    page: pageRequestSchema,
  }),
  s({
    kind: z.literal("inventory"),
    scope: scopeSchema.refine((v) => v.agentIds.length === 1),
    category: inventoryCategory,
    page: pageRequestSchema,
  }),
  s({
    kind: z.literal("file_changes"),
    scope: scopeSchema,
    pathEquals: text(4096, 1).optional(),
    page: pageRequestSchema,
  }),
  s({
    kind: z.literal("findings"),
    scope: scopeSchema.refine((v) => v.agentIds.length === 1),
    category: z.enum(["sca", "vulnerabilities"]),
    page: pageRequestSchema,
  }),
]);
const deviceCategory = z.enum([
  "os",
  "hardware",
  "packages",
  "processes",
  "ports",
  "fim_objects",
  "sca",
]);
const deviceDetailInput = s({
  connectionId: idSchema,
  agentId: nativeId,
  category: deviceCategory,
  page: pageRequestSchema,
});
const deviceDetail = s({
  agentId: nativeId,
  category: deviceCategory,
  items: z.array(sourceRecordSchema).max(50),
  nextCursor: bytesText(2048).optional(),
  total: count.optional(),
  retrievedAt: instantSchema,
  status: z.enum(["ok", "partial", "denied", "unavailable", "failed"]),
  warnings: z.array(text()).max(30),
});
const statistics = s({
  scope: queryScopeSchema,
  total: count,
  byLevel: z.array(s({ level: integer.max(15), count: integer })).max(16),
  byHour: z.array(s({ start: instantSchema, count: integer })).max(1000),
  coverage: coverageSchema,
});
export const evidenceRefSchema = s({ evidenceId: idSchema, version: positive });
const contextRef = s({ contextId: idSchema, version: positive });
export const deliveredRefSchema = evidenceRefSchema.extend({
  projectionId: idSchema,
});
export const evidenceRecordSchema = s({
  id: idSchema,
  spaceId: idSchema,
  connectionId: idSchema,
  version: positive,
  source: sourceLocatorSchema,
  kind: z.enum([
    "alert",
    "authentication",
    "inventory",
    "fim",
    "finding",
    "human_context",
  ]),
  observedAt: instantSchema.optional(),
  timeQuality,
  retrievedAt: instantSchema,
  contentHash: hash,
  fields: jsonObjectSchema,
  availability: z.enum(["available", "expired"]),
});
export const evidenceProjectionSchema = s({
  id: idSchema,
  runId: idSchema,
  ref: evidenceRefSchema,
  content: jsonObjectSchema,
  contentHash: hash,
  state: z.enum(["prepared", "released", "uncertain"]),
  preparedAt: instantSchema,
  releasedAt: instantSchema.optional(),
  availability: z.enum(["available", "expired"]),
});
const caseState = z.enum(["pending", "investigating", "resolved", "reopened"]);
export const caseRecordSchema = s({
  id: idSchema,
  spaceId: idSchema,
  revision: positive,
  title: text(200, 1),
  scope: scopeSchema,
  status: caseState,
  currentReportId: idSchema.optional(),
  latestReportId: idSchema.optional(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
const businessContextBase = s({
  id: idSchema,
  caseId: idSchema.optional(),
  connectionId: idSchema,
  agentIds: agentIds(5),
  version: positive,
  text: text(8000, 1),
  department: text(256).optional(),
  purpose: text(500).optional(),
  from: instantSchema,
  to: instantSchema,
  sourceLabel: text(500, 1),
  verification: z.enum(["unverified", "verified", "rejected"]),
  authorId: idSchema,
});
export const businessContextSchema = businessContextBase.refine(
  (v) => v.from < v.to,
);
const queryView = s({ queryId: idSchema, coverage: coverageSchema });
export const caseSnapshotSchema = s({
  case: caseRecordSchema,
  evidence: z.array(evidenceRecordSchema).max(50),
  contexts: z.array(businessContextSchema).max(100),
  queries: z.array(queryView).max(100),
  nextEvidenceCursor: bytesText(2048).optional(),
});
const cleanupPlan = s({
  id: idSchema,
  planHash: hash,
  expiresAt: instantSchema,
  caseIds: z.array(idSchema).max(100),
  caseRevisions: z.array(s({ caseId: idSchema, revision: positive })).max(100),
  removableVersions: integer,
  blockedVersions: integer,
  approximateBytes: integer,
});
const origin = z.enum(["alert_auto", "client_user", "teleagent_user"]);
const requestState = z.enum([
  "awaiting_scope",
  "accepted",
  "rejected",
  "withdrawn",
]);
const jobState = z.enum([
  "coalescing",
  "queued",
  "preparing",
  "submitting",
  "running",
  "verifying",
  "succeeded",
  "needs_review",
  "failed",
  "cancel_requested",
  "cancelled",
  "uncertain",
]);
const deliveryState = z.enum([
  "pending",
  "sending",
  "delivered",
  "uncertain",
  "retryable_failed",
  "blocked",
]);
export const createRequestSchema = s({
  origin,
  connectionId: idSchema,
  question: text(2000, 1),
  requestedScope: scopeSchema.optional(),
  seedRefs: z.array(evidenceRefSchema).max(300),
  caseId: idSchema.optional(),
  idempotencyKey: key,
  originBindingId: idSchema.optional(),
  autoCandidateId: idSchema.optional(),
}).refine(
  (v) => !v.requestedScope || v.connectionId === v.requestedScope.connectionId,
);
export const investigationRequestSchema = s({
  id: idSchema,
  origin,
  state: requestState,
  connectionId: idSchema,
  question: text(2000, 1),
  requestedScope: scopeSchema.optional(),
  effectiveScope: scopeSchema.optional(),
  seedRefs: z.array(evidenceRefSchema).max(300),
  caseId: idSchema.optional(),
  jobId: idSchema.optional(),
  originBindingId: idSchema.optional(),
  autoCandidateId: idSchema.optional(),
  missingFields: z.array(text(128)).max(20),
  createdAt: instantSchema,
  expiresAt: instantSchema,
});
export const analysisRunSchema = s({
  id: idSchema,
  jobId: idSchema,
  caseId: idSchema,
  baseRevision: positive,
  scope: scopeSchema,
  connectionGeneration: positive,
  identityEpoch: positive,
  profileVersion: key,
  toolEpoch: positive,
  expiresAt: instantSchema,
  manifestHash: hash.optional(),
});
export const jobRecordSchema = s({
  id: idSchema,
  requestId: idSchema,
  caseId: idSchema,
  runId: idSchema.optional(),
  origin,
  state: jobState,
  revision: positive,
  createdAt: instantSchema,
  updatedAt: instantSchema,
  expiresAt: instantSchema,
  recoveryHold: z.boolean(),
  policyId: idSchema.optional(),
  policyEpoch: positive.optional(),
  error: appErrorSchema.optional(),
});
const budget = s({
  runId: idSchema,
  toolsUsed: integer.max(12),
  readsUsed: integer.max(10),
  platformAttempts: integer.max(20),
  distinctEvents: integer.max(300),
  deadline: instantSchema,
  closed: z.boolean(),
});
const requestStatus = s({
  request: investigationRequestSchema,
  job: jobRecordSchema.optional(),
  budget: budget.optional(),
  deliveryState: deliveryState.optional(),
  subscriptionCancelled: z.boolean().optional(),
});
const policy = s({
  id: idSchema,
  connectionId: idSchema,
  revision: positive,
  epoch: positive,
  enabled: z.boolean(),
  agentIds: agentIds(1000),
  filter: alertFilterSchema,
  enabledAfterReceiveSeq: integer,
  dailyAttemptLimit: positive,
  timeZone,
  dailyTokenLimit: positive.optional(),
});
const inboxAlert = s({
  id: idSchema,
  connectionId: idSchema,
  sourceKey: hash,
  receiveSeq: positive,
  kind: z.enum(["realtime", "history", "recovery"]),
  evidence: evidenceRefSchema,
  agentId: nativeId.optional(),
  ruleId: key.optional(),
  ruleGroups: z.array(key).max(20),
  level: integer.max(15).optional(),
  observedAt: instantSchema.optional(),
  receivedAt: instantSchema,
  read: z.boolean(),
  decisionReason: text(),
});
const hostCapability = s({
  name: z.enum([
    "signedApi",
    "dedicatedProfile",
    "isolatedEvidenceChannel",
    "trustedOrigin",
    "asyncDelivery",
    "deliveryReconcile",
  ]),
  state: z.enum(["available", "unavailable", "unverified"]),
  version: key,
  checkedAt: instantSchema,
  evidence: text(),
});
const originBinding = s({
  id: idSchema,
  spaceId: idSchema,
  principalId: idSchema,
  hostId: idSchema,
  hostAccountId: idSchema,
  workspaceId: idSchema,
  sessionId: nativeId,
  requestMessageId: nativeId,
  state: z.enum(["active", "revoked", "expired"]),
  createdAt: instantSchema,
  expiresAt: instantSchema,
});
const stopReason = z.enum([
  "answered_with_limits",
  "evidence_unavailable",
  "budget_exhausted",
  "user_cancelled",
  "execution_failed",
  "scope_expansion_needed",
]);
const statement = s({
  text: text(2000, 1),
  evidenceRefs: z.array(deliveredRefSchema).max(20),
  queryIds: z.array(idSchema).max(20),
  contextRefs: z.array(contextRef).max(20),
});
const followupDraft = s({
  question: text(2000, 1),
  suggestedAction: text(2000, 1),
  responsibleRole: text(256).optional(),
});
export const reportCandidateSchema = s({
  caseId: idSchema,
  runId: idSchema,
  question: text(2000, 1),
  facts: z.array(statement).max(20),
  analysis: z.array(statement).max(20),
  conflicts: z.array(statement).max(20),
  gaps: z.array(text()).max(20),
  classification: z.enum([
    "needs_investigation",
    "explained",
    "insufficient_evidence",
  ]),
  stopReason,
  followups: z.array(followupDraft).max(20),
}).refine((v) => utf8Bytes(canonicalJson(v)) <= 65536, "草案超过 64 KiB");
const reviewState = z.enum(["unreviewed", "accepted", "revised", "rejected"]);
const validationState = z.enum(["valid", "invalid", "needs_review"]);
export const reportRecordSchema = s({
  id: idSchema,
  caseId: idSchema,
  runId: idSchema,
  version: positive,
  baseRevision: positive,
  candidate: reportCandidateSchema,
  validation: validationState,
  review: reviewState,
  validationIssues: z.array(text()).max(100),
  createdAt: instantSchema,
});
const followup = followupDraft.extend({
  id: idSchema,
  caseId: idSchema,
  reportId: idSchema.optional(),
  revision: positive,
  state: z.enum(["open", "waiting", "completed"]),
  dueAt: instantSchema.optional(),
  note: text(8000).optional(),
  evidenceRefs: z.array(evidenceRefSchema).max(20),
});
const terminalState = z.enum([
  "succeeded",
  "needs_review",
  "failed",
  "cancelled",
]);
export const resultPackageSchema = s({
  schemaVersion: z.literal("0.1.0"),
  requestId: idSchema,
  jobId: idSchema,
  caseId: idSchema,
  runId: idSchema.optional(),
  resultVersion: positive,
  terminalState,
  review: reviewState,
  summary: text(),
  reportId: idSchema.optional(),
  mainEvidence: z.array(statement).max(5),
  gaps: z.array(text()).max(10),
  followups: z.array(followupDraft).max(10),
  scope: scopeSchema,
  error: appErrorSchema.optional(),
});
const hostReceipt = s({
  messageId: nativeId,
  visible: z.boolean(),
  observedAt: instantSchema,
});
const deliveryRecord = s({
  id: idSchema,
  originBindingId: idSchema,
  requestId: idSchema,
  runId: idSchema.optional(),
  resultVersion: positive,
  deliveryKey: hash,
  state: deliveryState,
  attempts: integer,
  result: resultPackageSchema,
  receipt: hostReceipt.optional(),
  lastError: appErrorSchema.optional(),
  nextAttemptAt: instantSchema.optional(),
});
export const frozenRunInputSchema = s({
  question: text(2000, 1),
  scope: scopeSchema,
  seedRefs: z.array(evidenceRefSchema).max(300),
  contexts: z.array(businessContextSchema).max(100),
  capabilities: z.array(capabilitySchema).max(30),
});
export const runEvidenceViewSchema = s({
  runId: idSchema,
  caseId: idSchema,
  scope: scopeSchema,
  projections: z.array(evidenceProjectionSchema).max(1000),
  queries: z.array(queryView).max(100),
});
export const preparedProfileSchema = s({
  version: key,
  systemText: bytesText(32768),
  userText: bytesText(32768),
  allowedTools: z.array(key).max(20),
  seedProjectionIds: z.array(idSchema).max(300),
  contextRefs: z.array(contextRef).max(100),
});
const policySnapshot = z.discriminatedUnion("configured", [
  s({ configured: z.literal(false) }),
  s({ configured: z.literal(true), policy }),
]);
const deliveryRecoveryInput = s({
  deliveryId: idSchema,
  expectedState: z.enum(["blocked", "uncertain", "retryable_failed"]),
  expectedAttempts: integer,
  reason: text(2000, 1),
});
const investigationHistoryInput = s({
  caseId: idSchema,
  page: pageRequestSchema,
});
const investigationHistorySnapshotInput = s({
  runId: idSchema,
  page: pageRequestSchema,
});
const investigationHistoryItem = s({
  request: investigationRequestSchema,
  job: jobRecordSchema.optional(),
  run: analysisRunSchema.optional(),
});
const investigationHistorySnapshot = s({
  run: analysisRunSchema,
  job: jobRecordSchema,
  initialInput: frozenRunInputSchema,
  preparedProfile: preparedProfileSchema.optional(),
  projections: z.array(evidenceProjectionSchema).max(50),
  queries: z.array(queryView).max(50),
  nextCursor: bytesText(2048).optional(),
});
export const investigationStepSchema = s({
  phase: z.enum(["orientation", "querying", "evaluating", "stopped"]),
  summary: text(),
  purpose: text(500).optional(),
  evidenceRefs: z.array(deliveredRefSchema).max(20),
});
export const reportValidationInputSchema = s({
  view: runEvidenceViewSchema,
  contexts: z
    .array(s({ ref: contextRef, context: businessContextSchema }))
    .max(100),
});
export const completionDecisionSchema = s({
  terminalState,
  reason: text(2000, 1),
  error: appErrorSchema.optional(),
});
export const executionSnapshotSchema = s({
  runId: idSchema,
  sessionId: nativeId.optional(),
  userMessageId: nativeId.optional(),
  resultMessageId: nativeId.optional(),
  phase: z.enum([
    "not_submitted",
    "submitted",
    "running",
    "completed",
    "failed",
    "cancelled",
    "uncertain",
  ]),
  verification: z.enum(["verified", "unverified"]),
  observedAt: instantSchema,
  finishReason: text(128).optional(),
  error: appErrorSchema.optional(),
  usage: s({
    inputTokens: integer.optional(),
    outputTokens: integer.optional(),
    estimated: z.boolean(),
    costKnown: z.boolean(),
  }).optional(),
});
const eventBase = {
  seq: positive,
  spaceId: idSchema,
  aggregateId: idSchema,
  revision: integer,
  occurredAt: instantSchema,
  traceId: idSchema,
};
export const eventPayloadSchemas = {
  "connection.changed": s({ connectionId: idSchema, generation: positive }),
  "alerts.received": s({
    connectionId: idSchema,
    alertIds: z.array(idSchema).max(1000),
    receiveSeq: positive,
  }),
  "policy.changed": s({
    policyId: idSchema,
    epoch: positive,
    enabled: z.boolean(),
  }),
  "case.changed": s({ caseId: idSchema, revision: positive, reason: text() }),
  "request.changed": s({ requestId: idSchema, state: requestState }),
  "job.changed": s({
    jobId: idSchema,
    runId: idSchema.optional(),
    state: jobState,
    revision: positive,
  }),
  "investigation.step": s({
    runId: idSchema,
    stepId: idSchema,
    summary: text(),
  }),
  "report.changed": s({
    reportId: idSchema,
    caseId: idSchema,
    review: reviewState,
  }),
  "delivery.changed": s({
    deliveryId: idSchema,
    requestId: idSchema,
    state: deliveryState,
  }),
  "runtime.changed": s({ state: z.enum(["ready", "degraded", "stopping"]) }),
} satisfies { [K in keyof T.EventPayloadMap]: z.ZodType<T.EventPayloadMap[K]> };
export const domainEventSchema = z.union(
  Object.entries(eventPayloadSchemas).map(([type, payload]) =>
    s({ ...eventBase, type: z.literal(type), payload }),
  ) as unknown as [z.ZodType<T.DomainEvent>, ...z.ZodType<T.DomainEvent>[]],
);
const runtimeSettings = s({
  revision: positive,
  trayEnabled: z.boolean(),
  budgetTimeZone: timeZone,
  dailyTotalTokenLimit: positive.optional(),
  retentionDays: positive.max(3650).optional(),
  evidenceMaxBytes: positive.optional(),
});
const workspaceSnapshot = s({
  eventSeq: integer,
  generatedAt: instantSchema,
  connections: z
    .array(s({ id: idSchema, displayName: text(200, 1), generation: positive }))
    .max(1000),
  cases: z.array(caseRecordSchema).max(20),
  requests: z.array(investigationRequestSchema).max(20),
  jobs: z.array(jobRecordSchema).max(20),
  totals: s({ cases: integer, queued: integer, active: integer.max(1) }),
});
const empty = s({});
const caseId = s({ caseId: idSchema });
const requestId = s({ requestId: idSchema });
const requestRevision = s({
  requestId: idSchema,
  expectedJobRevision: positive,
});
const evidenceArray = z.array(evidenceRefSchema).max(300);
type MethodSchemas = {
  [K in keyof T.DesktopMethodMap]: {
    input: z.ZodType<T.DesktopMethodMap[K]["input"]>;
    output: z.ZodType<T.DesktopMethodMap[K]["output"]>;
  };
};
const pair = <I, O>(input: z.ZodType<I>, output: z.ZodType<O>) => ({
  input,
  output,
});
export const desktopSchemas = {
  "runtime.status": pair(
    empty,
    s({
      state: z.enum(["ready", "degraded", "stopping"]),
      spaceId: idSchema,
      hostCapabilities: z.array(hostCapability).max(6),
      trayEnabled: z.boolean(),
    }),
  ),
  "runtime.setTray": pair(
    s({ enabled: z.boolean() }),
    s({ enabled: z.boolean() }),
  ),
  "runtime.settings": pair(empty, runtimeSettings),
  "runtime.configure": pair(
    s({
      expectedRevision: positive,
      settings: runtimeSettings.omit({ revision: true }),
    }),
    runtimeSettings,
  ),
  "workspace.snapshot": pair(
    s({ connectionId: idSchema.optional() }),
    workspaceSnapshot,
  ),
  "events.read": pair(
    s({ afterSeq: integer, limit: positive.max(200) }),
    s({
      events: z.array(domainEventSchema).max(200),
      lastSeq: integer,
      resetRequired: z.boolean(),
    }),
  ),
  "connections.list": pair(
    empty,
    z.array(
      s({ id: idSchema, displayName: text(200, 1), generation: positive }),
    ),
  ),
  "connections.capabilities": pair(
    s({ connectionId: idSchema, refresh: z.boolean() }),
    z.array(capabilitySchema).max(30),
  ),
  "connections.agents": pair(
    s({ connectionId: idSchema, page: pageRequestSchema }),
    s({
      items: z.array(agentSummary).max(50),
      nextCursor: bytesText(2048).optional(),
      total: count.optional(),
    }),
  ),
  "devices.detail": pair(deviceDetailInput, deviceDetail),
  "connections.configure": pair(
    s({
      id: idSchema.optional(),
      displayName: text(200, 1),
      platformInstanceId: idSchema,
      indexerBaseUrl: httpsUrl.optional(),
      serverBaseUrl: httpsUrl.optional(),
      alertsPattern: key,
      archivesPattern: key.optional(),
      mappingVersion: key,
      expectedGeneration: positive.optional(),
    }),
    s({ id: idSchema, generation: positive }),
  ),
  "connections.setCredential": pair(
    s({
      connectionId: idSchema,
      endpoint: z.enum(["indexer", "server"]),
      username: bytesText(4096),
      password: bytesText(4096),
      persist: z.boolean(),
      expectedGeneration: positive,
    }),
    s({ generation: positive }),
  ),
  "connections.setCa": pair(
    s({
      connectionId: idSchema,
      certificatePem: bytesText(524288),
      expectedGeneration: positive,
    }),
    s({ generation: positive }),
  ),
  "alerts.list": pair(
    s({
      connectionId: idSchema,
      page: pageRequestSchema,
      scope: queryScopeSchema.optional(),
      filter: alertFilterSchema.optional(),
      read: z.boolean().optional(),
    }),
    s({
      items: z.array(inboxAlert).max(50),
      nextCursor: bytesText(2048).optional(),
    }),
  ),
  "alerts.markRead": pair(
    s({ alertIds: z.array(idSchema).min(1).max(1000) }),
    z.null(),
  ),
  "alerts.getPolicy": pair(s({ connectionId: idSchema }), policySnapshot),
  "alerts.setPolicy": pair(s({ expectedRevision: integer, policy }), policy),
  "statistics.alerts": pair(queryScopeSchema, statistics),
  "cases.list": pair(
    s({
      connectionId: idSchema.optional(),
      text: text(200).optional(),
      status: caseState.optional(),
      page: pageRequestSchema,
    }),
    s({
      items: z.array(caseRecordSchema).max(50),
      nextCursor: bytesText(2048).optional(),
    }),
  ),
  "cases.create": pair(
    s({ title: text(200, 1), scope: scopeSchema, seedRefs: evidenceArray }),
    caseRecordSchema,
  ),
  "cases.snapshot": pair(
    s({ caseId: idSchema, evidencePage: pageRequestSchema }),
    caseSnapshotSchema,
  ),
  "evidence.get": pair(
    s({
      caseId: idSchema,
      ref: evidenceRefSchema,
      projectionId: idSchema.optional(),
    }),
    s({
      evidence: evidenceRecordSchema,
      projection: evidenceProjectionSchema.optional(),
    }),
  ),
  "cases.putContext": pair(
    s({
      caseId: idSchema,
      contextId: idSchema.optional(),
      expectedRevision: positive,
      context: businessContextBase
        .omit({ id: true, version: true, authorId: true })
        .refine((v) => v.from < v.to),
    }),
    businessContextSchema,
  ),
  "cases.setStatus": pair(
    s({
      caseId: idSchema,
      expectedRevision: positive,
      status: caseState,
      reason: text(2000, 1),
    }),
    caseRecordSchema,
  ),
  "cases.moveEvidence": pair(
    s({
      sourceCaseId: idSchema,
      targetCaseId: idSchema,
      sourceRevision: positive,
      targetRevision: positive,
      refs: evidenceArray,
      reason: text(2000, 1),
    }),
    s({ sourceRevision: positive, targetRevision: positive }),
  ),
  "retention.preview": pair(
    s({ caseIds: z.array(idSchema).min(1).max(100), olderThan: instantSchema }),
    cleanupPlan,
  ),
  "retention.apply": pair(
    s({ planId: idSchema, expectedPlanHash: hash }),
    s({ expiredVersions: integer }),
  ),
  "requests.create": pair(createRequestSchema, requestStatus),
  "requests.provideInput": pair(
    s({
      requestId: idSchema,
      scope: scopeSchema.optional(),
      text: text(8000, 1).optional(),
      idempotencyKey: key,
    }).refine((v) => v.scope !== undefined || v.text !== undefined),
    requestStatus,
  ),
  "requests.status": pair(requestId, requestStatus),
  "investigations.snapshot": pair(
    s({ runId: idSchema }),
    s({
      run: analysisRunSchema,
      job: jobRecordSchema,
      steps: z
        .array(
          s({
            id: idSchema,
            phase: text(128),
            summary: text(),
            purpose: text(500).optional(),
            createdAt: instantSchema,
          }),
        )
        .max(100),
      report: reportRecordSchema.optional(),
      budget,
    }),
  ),
  "requests.cancel": pair(
    s({ requestId: idSchema, reason: text(2000, 1) }),
    requestStatus,
  ),
  "requests.resume": pair(requestRevision, requestStatus),
  "requests.abandon": pair(
    s({
      requestId: idSchema,
      expectedJobRevision: positive,
      reason: text(2000, 1),
    }),
    requestStatus,
  ),
  "requests.reconcile": pair(requestRevision, requestStatus),
  "reports.review": pair(
    s({
      reportId: idSchema,
      expectedCaseRevision: positive,
      disposition: z.enum(["accepted", "revised", "rejected"]),
      humanConclusion: z.enum([
        "confirmed_attack",
        "confirmed_benign",
        "unknown",
      ]),
      note: text(8000, 1),
      revisedCandidate: reportCandidateSchema.optional(),
    }).refine((v) => v.disposition !== "revised" || !!v.revisedCandidate),
    reportRecordSchema,
  ),
  "results.publishReview": pair(
    s({
      requestId: idSchema,
      reportId: idSchema,
      expectedCaseRevision: positive,
      expectedResultVersion: positive,
    }),
    resultPackageSchema,
  ),
  "reports.list": pair(caseId, z.array(reportRecordSchema)),
  "followups.list": pair(caseId, z.array(followup)),
  "followups.search": pair(
    s({
      caseId: idSchema.optional(),
      state: z.enum(["open", "waiting", "completed"]).optional(),
      page: pageRequestSchema,
    }),
    s({
      items: z.array(followup).max(50),
      nextCursor: bytesText(2048).optional(),
    }),
  ),
  "followups.put": pair(
    s({ item: followup, expectedRevision: integer }),
    followup,
  ),
  "cases.export": pair(
    s({
      caseId: idSchema,
      caseRevision: positive,
      format: z.enum(["markdown", "json"]),
    }),
    s({ filename: text(200, 1), mediaType: z.string(), text: z.string() }),
  ),
  "results.get": pair(
    s({ requestId: idSchema, resultVersion: positive.optional() }),
    resultPackageSchema,
  ),
  "deliveries.status": pair(requestId, z.array(deliveryRecord)),
  "deliveries.recover": pair(deliveryRecoveryInput, deliveryRecord),
  "investigations.history": pair(
    investigationHistoryInput,
    s({
      items: z.array(investigationHistoryItem).max(50),
      nextCursor: bytesText(2048).optional(),
    }),
  ),
  "investigations.input": pair(
    investigationHistorySnapshotInput,
    investigationHistorySnapshot,
  ),
} satisfies MethodSchemas;

export function parseWith<V>(
  schema: z.ZodType<V>,
  input: unknown,
  maxBytes = 1048576,
): T.Result<V> {
  try {
    if (utf8Bytes(canonicalJson(input)) > maxBytes)
      return fail("INVALID_INPUT", "输入超过字节上限");
    const parsed = schema.safeParse(input);
    return parsed.success
      ? ok(parsed.data)
      : fail("INVALID_INPUT", "输入结构、字段、范围或枚举无效");
  } catch {
    return fail("INVALID_INPUT", "输入不是受支持的 JSON");
  }
}
export const parseScope = (input: unknown) =>
  parseWith<T.Scope>(scopeSchema, input);
export const parseInstant = (input: unknown) =>
  parseWith<string>(instantSchema, input);
export const parseActor = (input: unknown) =>
  parseWith<T.Actor>(actorSchema, input);
export const parseCreateRequest = (input: unknown) =>
  parseWith<T.CreateRequest>(createRequestSchema, input);
export const parseReportCandidate = (input: unknown) =>
  parseWith<T.ReportCandidate>(reportCandidateSchema, input, 65536);
export const parseDomainEvent = (input: unknown) =>
  parseWith<T.DomainEvent>(domainEventSchema, input);
export const parseFrozenRunInput = (input: unknown) =>
  parseWith<T.FrozenRunInput>(frozenRunInputSchema, input);
export const parseReportValidationInput = (input: unknown) =>
  parseWith<T.ReportValidationInput>(reportValidationInputSchema, input);
export const parseCompletionDecision = (input: unknown) =>
  parseWith<T.CompletionDecision>(completionDecisionSchema, input);

export const budgetReservationSchema = s({
  id: idSchema,
  runId: idSchema,
  toolName: key,
  toolOrdinal: positive.max(12),
  expiresAt: instantSchema,
  toolEpoch: positive,
  identityEpoch: positive,
  connectionGeneration: positive,
});
export const channelHandleSchema = s({
  id: idSchema,
  runId: idSchema,
  transport: z.enum(["streamable-http", "stdio"]),
  endpoint: z.string().url().optional(),
  secretRef: idSchema,
  expiresAt: instantSchema,
  state: z.enum(["pending", "active", "revoked"]),
});
export const toolInvocationSchema = s({
  transportBindingId: idSchema,
  callId: nativeId,
  toolName: key,
  arguments: jsonObjectSchema,
});
export const toolReplySchema = s({
  isError: z.boolean(),
  text: bytesText(16384),
  structured: jsonObjectSchema.optional(),
  preparedProjectionIds: z.array(idSchema).max(300),
});
export const evidenceToolEnvelopeSchema = s({
  schemaVersion: z.literal("0.1.0"),
  status: z.enum(["ok", "partial", "denied", "unavailable", "failed"]),
  queryId: idSchema.optional(),
  records: z
    .array(s({ ref: deliveredRefSchema, content: jsonObjectSchema }))
    .max(50),
  coverage: coverageSchema.optional(),
  nextCursor: bytesText(2048).optional(),
  budget,
  warnings: z.array(text()).max(30),
  context: s({
    question: text(2000, 1),
    scope: scopeSchema,
    capabilities: z.array(capabilitySchema).max(30),
    backgrounds: z
      .array(s({ ref: contextRef, context: businessContextSchema }))
      .max(100),
  }).optional(),
}).refine(
  (value) => utf8Bytes(canonicalJson(value)) <= 16384,
  "工具回复超过 16 KiB",
);
export const controlToolEnvelopeSchema = s({
  schemaVersion: z.literal("0.1.0"),
  status: z.enum(["ok", "needs_input", "failed"]),
  data: jsonObjectSchema,
  budget: budget.optional(),
  warnings: z.array(text()).max(30),
}).refine(
  (value) => utf8Bytes(canonicalJson(value)) <= 16384,
  "工具回复超过 16 KiB",
);
const runManifestMetadataSchema = s({
  initialInput: frozenRunInputSchema,
  profileVersion: key,
  mappingVersion: key,
  steps: z.array(s({ id: idSchema, input: investigationStepSchema })).max(100),
  stopReason: stopReason.optional(),
});
const resultContextSchema = s({
  requestId: idSchema,
  jobId: idSchema,
  caseId: idSchema,
  runId: idSchema.optional(),
  scope: scopeSchema,
});
const reviewInputSchema = s({
  reportId: idSchema,
  expectedCaseRevision: positive,
  disposition: z.enum(["accepted", "revised", "rejected"]),
  humanConclusion: z.enum(["confirmed_attack", "confirmed_benign", "unknown"]),
  note: text(8000, 1),
  revisedCandidate: reportCandidateSchema.optional(),
}).refine((v) => v.disposition !== "revised" || !!v.revisedCandidate);
export const parseToolInvocation = (input: unknown) =>
  parseWith<T.ToolInvocation>(toolInvocationSchema, input, 262144);
export const parseEvidenceToolEnvelope = (input: unknown) =>
  parseWith<T.EvidenceToolEnvelope>(evidenceToolEnvelopeSchema, input, 16384);

export function parseDesktopInput<K extends keyof T.DesktopMethodMap>(
  method: K,
  input: unknown,
): T.Result<T.DesktopMethodMap[K]["input"]> {
  if (!Object.hasOwn(desktopSchemas, method))
    return fail("INVALID_INPUT", "未知业务方法");
  return parseWith(
    desktopSchemas[method].input as z.ZodType<T.DesktopMethodMap[K]["input"]>,
    input,
  );
}
export function parseDesktopOutput<K extends keyof T.DesktopMethodMap>(
  method: K,
  input: unknown,
): T.Result<T.DesktopMethodMap[K]["output"]> {
  if (!Object.hasOwn(desktopSchemas, method))
    return fail("INVALID_INPUT", "未知业务方法");
  return parseWith(
    desktopSchemas[method].output as z.ZodType<T.DesktopMethodMap[K]["output"]>,
    input,
    4 * 1048576,
  );
}
export function parseRpcRequest(
  input: unknown,
): T.Result<T.RpcRequest<keyof T.DesktopMethodMap>> {
  const envelope = parseWith(
    s({
      protocolVersion: z.literal("0.1.0"),
      requestId: idSchema,
      method: z.string(),
      payload: z.unknown(),
    }),
    input,
  );
  if (!envelope.ok) return envelope;
  if (!Object.hasOwn(desktopSchemas, envelope.value.method))
    return fail("INVALID_INPUT", "未知业务方法");
  const method = envelope.value.method as keyof T.DesktopMethodMap;
  const payload = parseDesktopInput(method, envelope.value.payload);
  if (!payload.ok) return payload;
  return ok({
    protocolVersion: "0.1.0",
    requestId: envelope.value.requestId,
    method,
    payload: payload.value,
  });
}

export const dtoSchemas = {
  Actor: actorSchema,
  CallContext: callContextSchema,
  Scope: scopeSchema,
  Coverage: coverageSchema,
  PageRequest: pageRequestSchema,
  AppError: appErrorSchema,
  ConnectionProfile: connectionProfileSchema,
  Capability: capabilitySchema,
  AgentSummary: agentSummary,
  DeviceDetailInput: deviceDetailInput,
  DeviceDetail: deviceDetail,
  AlertFilter: alertFilterSchema,
  PlatformQuery: platformQuerySchema,
  SourceLocator: sourceLocatorSchema,
  SourceRecord: sourceRecordSchema,
  PlatformPage: platformPageSchema,
  AlertStatistics: statistics,
  EvidenceRef: evidenceRefSchema,
  DeliveredRef: deliveredRefSchema,
  ContextRef: contextRef,
  EvidenceRecord: evidenceRecordSchema,
  EvidenceProjection: evidenceProjectionSchema,
  CaseRecord: caseRecordSchema,
  BusinessContext: businessContextSchema,
  CaseSnapshot: caseSnapshotSchema,
  CleanupPlan: cleanupPlan,
  CreateRequest: createRequestSchema,
  InvestigationRequest: investigationRequestSchema,
  AnalysisRun: analysisRunSchema,
  JobRecord: jobRecordSchema,
  BudgetState: budget,
  RequestStatus: requestStatus,
  InboxAlert: inboxAlert,
  TriggerPolicy: policy,
  PolicySnapshot: policySnapshot,
  DeliveryRecoveryInput: deliveryRecoveryInput,
  InvestigationHistoryInput: investigationHistoryInput,
  InvestigationHistorySnapshotInput: investigationHistorySnapshotInput,
  InvestigationHistoryItem: investigationHistoryItem,
  InvestigationHistorySnapshot: investigationHistorySnapshot,
  HostCapability: hostCapability,
  OriginBinding: originBinding,
  PreparedProfile: preparedProfileSchema,
  ExecutionSnapshot: executionSnapshotSchema,
  HostReceipt: hostReceipt,
  InvestigationStepInput: investigationStepSchema,
  ReportCandidate: reportCandidateSchema,
  ReportRecord: reportRecordSchema,
  ReportStatement: statement,
  FollowupDraft: followupDraft,
  FollowupRecord: followup,
  ResultPackage: resultPackageSchema,
  DeliveryRecord: deliveryRecord,
  FrozenRunInput: frozenRunInputSchema,
  RunEvidenceView: runEvidenceViewSchema,
  ReportValidationInput: reportValidationInputSchema,
  CompletionDecision: completionDecisionSchema,
  DomainEvent: domainEventSchema,
  RuntimeSettings: runtimeSettings,
  WorkspaceSnapshot: workspaceSnapshot,
  Count: count,
  QueryCapture: s({
    runId: idSchema.optional(),
    caseId: idSchema.optional(),
    connectionId: idSchema,
    query: platformQuerySchema,
    page: platformPageSchema,
  }),
  RunManifestMetadata: runManifestMetadataSchema,
  AutoCandidate: s({
    id: idSchema,
    policyId: idSchema,
    policyEpoch: positive,
    caseId: idSchema,
    alertIds: z.array(idSchema).min(1).max(300),
    scope: scopeSchema,
    question: text(2000, 1),
    firstReceivedAt: instantSchema,
    lastReceivedAt: instantSchema,
    coalesceUntil: instantSchema,
    expiresAt: instantSchema,
  }),
  BudgetReservation: budgetReservationSchema,
  ChannelHandle: channelHandleSchema,
  InvestigationProfileInput: s({
    run: analysisRunSchema,
    initialInput: frozenRunInputSchema,
    seedProjections: z.array(evidenceProjectionSchema).max(300),
  }),
  ToolInvocation: toolInvocationSchema,
  ToolReply: toolReplySchema,
  EvidenceToolEnvelope: evidenceToolEnvelopeSchema,
  ControlToolEnvelope: controlToolEnvelopeSchema,
  ResultContext: resultContextSchema,
  ReportAssessment: s({
    reportId: idSchema.optional(),
    validation: z.enum(["valid", "invalid", "needs_review", "missing"]),
  }),
  ReviewInput: reviewInputSchema,
  HostMessage: s({
    kind: z.literal("external_investigation_result"),
    mediaType: z.literal("application/json"),
    text: bytesText(65536),
  }),
  ResultSubscription: s({
    requestId: idSchema,
    bindingId: idSchema,
    canCancel: z.boolean(),
    state: z.enum(["active", "withdrawn"]),
  }),
  RunSnapshot: desktopSchemas["investigations.snapshot"].output,
  HttpResponse: s({
    status: integer.min(100).max(599),
    headers: z.record(z.string(), z.string()),
    bodyText: bytesText(4 * 1048576),
  }),
};

// Static witnesses make schema/type drift a compiler error, in addition to runtime tests.
const schemaTypes: {
  [K in keyof typeof dtoSchemas]: z.ZodType<
    {
      Actor: T.Actor;
      CallContext: T.CallContext;
      Scope: T.Scope;
      Coverage: T.Coverage;
      PageRequest: T.PageRequest;
      AppError: T.AppError;
      ConnectionProfile: T.ConnectionProfile;
      Capability: T.Capability;
      AgentSummary: T.AgentSummary;
      DeviceDetailInput: T.DeviceDetailInput;
      DeviceDetail: T.DeviceDetail;
      AlertFilter: T.AlertFilter;
      PlatformQuery: T.PlatformQuery;
      SourceLocator: T.SourceLocator;
      SourceRecord: T.SourceRecord;
      PlatformPage: T.PlatformPage;
      AlertStatistics: T.AlertStatistics;
      EvidenceRef: T.EvidenceRef;
      DeliveredRef: T.DeliveredRef;
      ContextRef: T.ContextRef;
      EvidenceRecord: T.EvidenceRecord;
      EvidenceProjection: T.EvidenceProjection;
      CaseRecord: T.CaseRecord;
      BusinessContext: T.BusinessContext;
      CaseSnapshot: T.CaseSnapshot;
      CleanupPlan: T.CleanupPlan;
      CreateRequest: T.CreateRequest;
      InvestigationRequest: T.InvestigationRequest;
      AnalysisRun: T.AnalysisRun;
      JobRecord: T.JobRecord;
      BudgetState: T.BudgetState;
      RequestStatus: T.RequestStatus;
      InboxAlert: T.InboxAlert;
      TriggerPolicy: T.TriggerPolicy;
      PolicySnapshot: T.PolicySnapshot;
      DeliveryRecoveryInput: T.DeliveryRecoveryInput;
      InvestigationHistoryInput: T.InvestigationHistoryInput;
      InvestigationHistorySnapshotInput: T.InvestigationHistorySnapshotInput;
      InvestigationHistoryItem: T.InvestigationHistoryItem;
      InvestigationHistorySnapshot: T.InvestigationHistorySnapshot;
      HostCapability: T.HostCapability;
      OriginBinding: T.OriginBinding;
      PreparedProfile: T.PreparedProfile;
      ExecutionSnapshot: T.ExecutionSnapshot;
      HostReceipt: T.HostReceipt;
      InvestigationStepInput: T.InvestigationStepInput;
      ReportCandidate: T.ReportCandidate;
      ReportRecord: T.ReportRecord;
      ReportStatement: T.ReportStatement;
      FollowupDraft: T.FollowupDraft;
      FollowupRecord: T.FollowupRecord;
      ResultPackage: T.ResultPackage;
      DeliveryRecord: T.DeliveryRecord;
      FrozenRunInput: T.FrozenRunInput;
      RunEvidenceView: T.RunEvidenceView;
      ReportValidationInput: T.ReportValidationInput;
      CompletionDecision: T.CompletionDecision;
      DomainEvent: T.DomainEvent;
      RuntimeSettings: T.RuntimeSettings;
      WorkspaceSnapshot: T.WorkspaceSnapshot;
      Count: T.Count;
      QueryCapture: T.QueryCapture;
      RunManifestMetadata: T.RunManifestMetadata;
      AutoCandidate: T.AutoCandidate;
      BudgetReservation: T.BudgetReservation;
      ChannelHandle: T.ChannelHandle;
      InvestigationProfileInput: T.InvestigationProfileInput;
      ToolInvocation: T.ToolInvocation;
      ToolReply: T.ToolReply;
      EvidenceToolEnvelope: T.EvidenceToolEnvelope;
      ControlToolEnvelope: T.ControlToolEnvelope;
      ResultContext: T.ResultContext;
      ReportAssessment: T.ReportAssessment;
      ReviewInput: T.ReviewInput;
      HostMessage: T.HostMessage;
      ResultSubscription: T.ResultSubscription;
      RunSnapshot: T.RunSnapshot;
      HttpResponse: T.HttpResponse;
    }[K]
  >;
} = dtoSchemas;
void schemaTypes;

export function parseDto<K extends keyof typeof dtoSchemas>(
  name: K,
  input: unknown,
): T.Result<z.infer<(typeof dtoSchemas)[K]>> {
  if (!Object.hasOwn(dtoSchemas, name))
    return fail("INVALID_INPUT", "未知数据类型");
  return parseWith(
    dtoSchemas[name] as z.ZodType<z.infer<(typeof dtoSchemas)[K]>>,
    input,
  );
}

/** Strict response boundary with caller-owned correlation, not model-supplied identity. */
export function parseRpcResponse<K extends keyof T.DesktopMethodMap>(
  method: K,
  requestId: T.Id,
  input: unknown,
): T.Result<T.RpcResponse<T.DesktopMethodMap[K]["output"]>> {
  const result = z.discriminatedUnion("ok", [
    s({ ok: z.literal(true), value: z.unknown() }),
    s({ ok: z.literal(false), error: appErrorSchema }),
  ]);
  const envelope = parseWith(
    s({ protocolVersion: z.literal("0.1.0"), requestId: idSchema, result }),
    input,
    4 * 1048576,
  );
  if (!envelope.ok) return envelope;
  if (
    !idSchema.safeParse(requestId).success ||
    envelope.value.requestId !== requestId
  )
    return fail("INVALID_INPUT", "响应与请求不匹配");
  if (!Object.hasOwn(desktopSchemas, method))
    return fail("INVALID_INPUT", "未知业务方法");
  if (!envelope.value.result.ok)
    return ok({
      protocolVersion: "0.1.0",
      requestId,
      result: envelope.value.result,
    });
  const output = parseDesktopOutput(method, envelope.value.result.value);
  if (!output.ok) return output;
  return ok({ protocolVersion: "0.1.0", requestId, result: output });
}
export const parseControlToolEnvelope = (input: unknown) =>
  parseWith<T.ControlToolEnvelope>(controlToolEnvelopeSchema, input, 16384);
export const parseResultPackage = (input: unknown) =>
  parseWith<T.ResultPackage>(resultPackageSchema, input, 1048576);
