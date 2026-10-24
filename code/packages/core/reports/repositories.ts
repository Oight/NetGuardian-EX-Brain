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
  type ReportAnchorReadPort,
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
  anchors: ReportAnchorReadPort;
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
/** S07 supplies a checked projection through its public read port. */
export function runAnchor(deps: Pick<Dependencies, "anchors">, tx: ReadTx, ctx: CallContext, runId: string): Result<AnalysisRun> {
  const value = deps.anchors.runInTx(tx, ctx, runId);
  return value.ok ? ok(value.value.run) : value;
}
export function contextIdentity(deps: Pick<Dependencies, "anchors">, tx: ReadTx, ctx: CallContext, context: ResultContext): Result<{hasRun: boolean}> {
  return deps.anchors.contextInTx(tx, ctx, context);
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
