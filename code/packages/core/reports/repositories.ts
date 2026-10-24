import { createHash } from "node:crypto";
import {
  canonicalJson,
  fail,
  ok,
  parseDto,
  parseWith,
  callContextSchema,
  idSchema,
  type AnalysisRun,
  type CallContext,
  type CaseAtomicPort,
  type CaseReadPort,
  type ClockPort,
  type ContextRef,
  type DatabasePort,
  type EventPort,
  type FollowupRecord,
  type IdPort,
  type ReadTx,
  type ReportCandidate,
  type ReportRecord,
  type Result,
  type ResultContext,
  type ResultPackage,
  type Scope,
  type WriteTx,
} from "@campussec/contracts";

export interface Dependencies {
  db: DatabasePort;
  events: EventPort;
  clock: ClockPort;
  ids: IdPort;
  cases: CaseReadPort;
  casesAtomic: CaseAtomicPort;
}
export interface ReportRow {
  id: string;
  case_id: string;
  run_id: string;
  version: number;
  base_revision: number;
  candidate_json: string;
  validation: ReportRecord["validation"];
  review: ReportRecord["review"];
  validation_issues_json: string;
  created_at: string;
}
export interface ReferencePolicy {
  contextRefs: ContextRef[];
  uncertainContexts: string[];
}
export const refKey = (ref: { evidenceId: string; version: number }) =>
  `${ref.evidenceId}:${ref.version}`;
export const contextKey = (ref: ContextRef) =>
  `${ref.contextId}:${ref.version}`;
export const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
export const within = (inner: Scope, outer: Scope) =>
  inner.connectionId === outer.connectionId &&
  inner.agentIds.every((id) => outer.agentIds.includes(id)) &&
  inner.from >= outer.from &&
  inner.to <= outer.to;

export function authorize(
  tx: ReadTx,
  ctx: CallContext,
  roles: string[],
): Result<void> {
  const parsed = parseWith(callContextSchema, ctx);
  if (!parsed.ok) return parsed;
  if (!roles.includes(parsed.value.actor.role))
    return fail("FORBIDDEN", "当前入口无此报告权限");
  const owner = tx.get<{
    space_id: string;
    principal_id: string;
    identity_epoch: number;
  }>("SELECT * FROM space_metadata");
  return owner &&
    owner.space_id === ctx.actor.spaceId &&
    owner.principal_id === ctx.actor.principalId &&
    owner.identity_epoch === ctx.actor.identityEpoch
    ? ok(undefined)
    : fail("FORBIDDEN", "报告主体空间不匹配");
}
/** Immutable run identity/input projection only. S10 never reads job state, execution facts or cancellation state. */
export function runAnchor(
  tx: ReadTx,
  ctx: CallContext,
  runId: string,
): Result<AnalysisRun> {
  const auth = authorize(tx, ctx, ["ui", "system", "evidence"]);
  if (!auth.ok) return auth;
  if (!idSchema.safeParse(runId).success)
    return fail("INVALID_INPUT", "轮次标识无效");
  if (
    (ctx.actor.runId && ctx.actor.runId !== runId) ||
    (ctx.actor.role === "evidence" && ctx.actor.runId !== runId)
  )
    return fail("FORBIDDEN", "报告轮次未授权");
  const row = tx.get<{
    id: string;
    job_id: string;
    case_id: string;
    base_revision: number;
    scope_json: string;
    connection_generation: number;
    identity_epoch: number;
    profile_version: string;
    tool_epoch: number;
    expires_at: string;
    manifest_hash: string | null;
  }>(
    "SELECT id,job_id,case_id,base_revision,scope_json,connection_generation,identity_epoch,profile_version,tool_epoch,expires_at,manifest_hash FROM analysis_runs WHERE id=?",
    [runId],
  );
  if (!row) return fail("NOT_FOUND", "报告轮次不存在");
  if (row.identity_epoch !== ctx.actor.identityEpoch)
    return fail("IDENTITY_CHANGED", "报告身份已改变");
  try {
    return parseDto("AnalysisRun", {
      id: row.id,
      jobId: row.job_id,
      caseId: row.case_id,
      baseRevision: row.base_revision,
      scope: JSON.parse(row.scope_json),
      connectionGeneration: row.connection_generation,
      identityEpoch: row.identity_epoch,
      profileVersion: row.profile_version,
      toolEpoch: row.tool_epoch,
      expiresAt: row.expires_at,
      ...(row.manifest_hash ? { manifestHash: row.manifest_hash } : {}),
    });
  } catch {
    return fail("VALIDATION_FAILED", "轮次冻结元数据损坏");
  }
}
/** Request identity projection, not request/job state. The coordinator retains all terminal-state decisions. */
export function contextIdentity(
  tx: ReadTx,
  ctx: CallContext,
  context: ResultContext,
): Result<void> {
  const row = tx.get<{
    principal_id: string;
    job_id: string | null;
    case_id: string | null;
    connection_id: string;
  }>(
    "SELECT principal_id,job_id,case_id,connection_id FROM investigation_requests WHERE id=?",
    [context.requestId],
  );
  return row &&
    row.principal_id === ctx.actor.principalId &&
    row.job_id === context.jobId &&
    row.case_id === context.caseId &&
    row.connection_id === context.scope.connectionId
    ? ok(undefined)
    : fail("FORBIDDEN", "结果请求关联未获授权");
}
export function decodeReport(row: ReportRow): {
  record: ReportRecord;
  policy: ReferencePolicy;
} {
  const stored = JSON.parse(row.candidate_json);
  const candidate = stored.formatVersion === 1 ? stored.candidate : stored;
  const parsed = parseDto("ReportRecord", {
    id: row.id,
    caseId: row.case_id,
    runId: row.run_id,
    version: row.version,
    baseRevision: row.base_revision,
    candidate,
    validation: row.validation,
    review: row.review,
    validationIssues: JSON.parse(row.validation_issues_json),
    createdAt: row.created_at,
  });
  if (!parsed.ok) throw new Error("Invalid stored report");
  return {
    record: parsed.value,
    policy:
      stored.formatVersion === 1
        ? stored.referencePolicy
        : {
            contextRefs: [
              ...candidate.facts,
              ...candidate.analysis,
              ...candidate.conflicts,
            ].flatMap((s: ReportCandidate["facts"][number]) => s.contextRefs),
            uncertainContexts: [],
          },
  };
}
export function findReport(
  tx: ReadTx,
  id: string,
): ReturnType<typeof decodeReport> | undefined {
  const row = tx.get<ReportRow>("SELECT * FROM report_drafts WHERE id=?", [id]);
  return row ? decodeReport(row) : undefined;
}
export function reports(tx: ReadTx, caseId: string): ReportRecord[] {
  return tx
    .all<ReportRow>(
      "SELECT * FROM report_drafts WHERE case_id=? ORDER BY created_at,run_id,version",
      [caseId],
    )
    .map((row) => decodeReport(row).record);
}
export function saveReport(
  deps: Dependencies,
  tx: WriteTx,
  ctx: CallContext,
  record: ReportRecord,
  policy: ReferencePolicy,
): Result<ReportRecord> {
  const parsed = parseDto("ReportRecord", record);
  if (!parsed.ok) return parsed;
  tx.run(
    "INSERT INTO report_drafts(id,case_id,run_id,version,base_revision,candidate_json,validation,review,validation_issues_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [
      record.id,
      record.caseId,
      record.runId,
      record.version,
      record.baseRevision,
      canonicalJson({
        formatVersion: 1,
        candidate: record.candidate,
        referencePolicy: policy,
      }),
      record.validation,
      record.review,
      canonicalJson(record.validationIssues),
      record.createdAt,
    ],
  );
  reportEvent(deps, tx, ctx, record);
  return parsed;
}
export function reportEvent(
  deps: Dependencies,
  tx: WriteTx,
  ctx: CallContext,
  record: ReportRecord,
) {
  deps.events.appendInTx(tx, ctx, {
    type: "report.changed",
    aggregateId: record.id,
    revision: record.version,
    payload: {
      reportId: record.id,
      caseId: record.caseId,
      review: record.review,
    },
  });
}
export function followup(row: Record<string, unknown>): FollowupRecord {
  const parsed = parseDto("FollowupRecord", {
    id: row.id,
    caseId: row.case_id,
    revision: row.revision,
    state: row.state,
    question: row.question,
    suggestedAction: row.suggested_action,
    evidenceRefs: JSON.parse(row.evidence_refs_json as string),
    ...(row.report_id ? { reportId: row.report_id } : {}),
    ...(row.responsible_role !== null
      ? { responsibleRole: row.responsible_role }
      : {}),
    ...(row.due_at !== null ? { dueAt: row.due_at } : {}),
    ...(row.note !== null ? { note: row.note } : {}),
  });
  if (!parsed.ok) throw new Error("Invalid stored followup");
  return parsed.value;
}
export function decodeResult(text: string): {
  result: ResultPackage;
  fingerprint?: string;
} {
  const stored = JSON.parse(text),
    parsed = parseDto(
      "ResultPackage",
      stored.formatVersion === 1 ? stored.result : stored,
    );
  if (!parsed.ok) throw new Error("Invalid stored result");
  return {
    result: parsed.value,
    ...(stored.formatVersion === 1 ? { fingerprint: stored.fingerprint } : {}),
  };
}
export function resultAt(tx: ReadTx, requestId: string, version?: number) {
  const row = tx.get<{ result_json: string }>(
    "SELECT result_json FROM result_packages WHERE request_id=?" +
      (version === undefined
        ? " ORDER BY result_version DESC LIMIT 1"
        : " AND result_version=?"),
    version === undefined ? [requestId] : [requestId, version],
  );
  return row ? decodeResult(row.result_json) : undefined;
}
export function saveResult(
  deps: Dependencies,
  tx: WriteTx,
  result: ResultPackage,
  fingerprint: string,
): Result<ResultPackage> {
  const parsed = parseDto("ResultPackage", result);
  if (!parsed.ok) return parsed;
  tx.run(
    "INSERT INTO result_packages(request_id,run_id,result_version,result_json,created_at) VALUES(?,?,?,?,?)",
    [
      result.requestId,
      result.runId ?? null,
      result.resultVersion,
      canonicalJson({ formatVersion: 1, result: parsed.value, fingerprint }),
      deps.clock.now(),
    ],
  );
  return parsed;
}
export async function readResult<T>(
  deps: Pick<Dependencies, "db">,
  ctx: CallContext,
  work: (tx: ReadTx) => Result<T>,
): Promise<Result<T>> {
  const value = await deps.db.read(ctx, work);
  return value.ok ? value.value : value;
}
