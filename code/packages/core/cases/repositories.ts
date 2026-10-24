import { createHash } from "node:crypto";
import {
  canonicalJson,
  fail,
  ok,
  parseDto,
  callContextSchema,
  parseWith,
  type BusinessContext,
  type CallContext,
  type CaseRecord,
  type ClockPort,
  type DatabasePort,
  type EventPort,
  type EvidenceRecord,
  type EvidenceRef,
  type IdPort,
  type ReadTx,
  type Result,
  type Scope,
  type WriteTx,
} from "@campussec/contracts";
export interface Dependencies {
  db: DatabasePort;
  events: EventPort;
  clock: ClockPort;
  ids: IdPort;
}
export type CaseRow = {
  id: string;
  revision: number;
  title: string;
  connection_id: string;
  scope_json: string;
  status: CaseRecord["status"];
  current_report_id: string | null;
  latest_report_id: string | null;
  created_at: string;
  updated_at: string;
};
export type EvidenceRow = {
  evidence_id: string;
  version: number;
  connection_id: string;
  locator_json: string;
  kind: EvidenceRecord["kind"];
  observed_at: string | null;
  time_quality: EvidenceRecord["timeQuality"];
  retrieved_at: string;
  content_hash: string;
  fields_json: string;
  availability: EvidenceRecord["availability"];
};
export const hash = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
export const refsKey = (ref: EvidenceRef) => `${ref.evidenceId}:${ref.version}`;
export const uniqueRefs = (refs: EvidenceRef[]) => [
  ...new Map(refs.map((ref) => [refsKey(ref), ref])).values(),
];
export function authorized(tx: ReadTx, ctx: CallContext): Result<void> {
  if (!parseWith(callContextSchema, ctx).ok)
    return fail("UNAUTHENTICATED", "调用上下文无效");
  const identity = tx.get<{
    space_id: string;
    principal_id: string;
    identity_epoch: number;
  }>("SELECT space_id,principal_id,identity_epoch FROM space_metadata");
  if (
    !identity ||
    identity.space_id !== ctx.actor.spaceId ||
    identity.principal_id !== ctx.actor.principalId ||
    identity.identity_epoch !== ctx.actor.identityEpoch
  )
    return fail("FORBIDDEN", "主体空间不匹配");
  return ok(undefined);
}
export function caseRecord(row: CaseRow, ctx: CallContext): CaseRecord {
  const result = parseDto("CaseRecord", {
    id: row.id,
    spaceId: ctx.actor.spaceId,
    revision: row.revision,
    title: row.title,
    scope: JSON.parse(row.scope_json),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.current_report_id
      ? { currentReportId: row.current_report_id }
      : {}),
    ...(row.latest_report_id ? { latestReportId: row.latest_report_id } : {}),
  });
  if (!result.ok) throw new Error("Invalid stored case");
  return result.value;
}
export function getCase(
  tx: ReadTx,
  ctx: CallContext,
  id: string,
): Result<CaseRecord> {
  const auth = authorized(tx, ctx);
  if (!auth.ok) return auth;
  const row = tx.get<CaseRow>("SELECT * FROM cases WHERE id=?", [id]);
  if (!row) return fail("NOT_FOUND", "案件不存在");
  if (ctx.actor.role === "evidence" || ctx.actor.role === "delegation") {
    if (
      !ctx.actor.runId ||
      !tx.get(
        "SELECT id FROM analysis_runs WHERE id=? AND case_id=? AND identity_epoch=?",
        [ctx.actor.runId, id, ctx.actor.identityEpoch],
      )
    )
      return fail("FORBIDDEN", "当前调用不具备案件读取权");
  }
  return ok(caseRecord(row, ctx));
}
export const within = (inner: Scope, outer: Scope) =>
  inner.connectionId === outer.connectionId &&
  inner.from >= outer.from &&
  inner.to <= outer.to &&
  inner.agentIds.every((id) => outer.agentIds.includes(id));
export function evidenceRecord(
  row: EvidenceRow,
  ctx: CallContext,
): EvidenceRecord {
  const result = parseDto("EvidenceRecord", {
    id: row.evidence_id,
    version: row.version,
    spaceId: ctx.actor.spaceId,
    connectionId: row.connection_id,
    source: JSON.parse(row.locator_json),
    kind: row.kind,
    ...(row.observed_at ? { observedAt: row.observed_at } : {}),
    timeQuality: row.time_quality,
    retrievedAt: row.retrieved_at,
    contentHash: row.content_hash,
    fields: JSON.parse(row.fields_json),
    availability: row.availability,
  });
  if (!result.ok) throw new Error("Invalid stored evidence");
  return result.value;
}
export function getEvidence(
  tx: ReadTx,
  ctx: CallContext,
  ref: EvidenceRef,
): Result<EvidenceRecord> {
  const row = tx.get<EvidenceRow>(
    "SELECT v.*,s.connection_id,s.locator_json FROM evidence_versions v JOIN evidence_sources s ON s.evidence_id=v.evidence_id WHERE v.evidence_id=? AND v.version=?",
    [ref.evidenceId, ref.version],
  );
  return row ? ok(evidenceRecord(row, ctx)) : fail("NOT_FOUND", "材料不存在");
}
export function linked(tx: ReadTx, caseId: string, ref: EvidenceRef) {
  return !!tx.get(
    "SELECT case_id FROM evidence_links WHERE case_id=? AND evidence_id=? AND evidence_version=? AND removed_revision IS NULL",
    [caseId, ref.evidenceId, ref.version],
  );
}
export function historical(
  tx: ReadTx,
  ctx: CallContext,
  caseId: string,
  ref: EvidenceRef,
) {
  return !!tx.get(
    "SELECT r.run_id FROM run_evidence r JOIN analysis_runs a ON a.id=r.run_id WHERE a.case_id=? AND r.evidence_id=? AND r.evidence_version=?" +
      (ctx.actor.runId ? " AND r.run_id=?" : ""),
    [
      caseId,
      ref.evidenceId,
      ref.version,
      ...(ctx.actor.runId ? [ctx.actor.runId] : []),
    ],
  );
}
type ContextRow = {
  id: string;
  case_id: string | null;
  connection_id: string;
  version: number;
  agent_ids_json: string;
  text: string;
  department: string | null;
  purpose: string | null;
  valid_from: string;
  valid_to: string;
  source_label: string;
  verification: BusinessContext["verification"];
  author_id: string;
};
function contextRecord(row: ContextRow): BusinessContext {
  const parsed = parseDto("BusinessContext", {
    id: row.id,
    ...(row.case_id ? { caseId: row.case_id } : {}),
    connectionId: row.connection_id,
    agentIds: JSON.parse(row.agent_ids_json),
    version: row.version,
    text: row.text,
    ...(row.department !== null ? { department: row.department } : {}),
    ...(row.purpose !== null ? { purpose: row.purpose } : {}),
    from: row.valid_from,
    to: row.valid_to,
    sourceLabel: row.source_label,
    verification: row.verification,
    authorId: row.author_id,
  });
  if (!parsed.ok) throw new Error("Invalid stored context");
  return parsed.value;
}
export function contextMatches(
  value: Pick<
    BusinessContext,
    "caseId" | "connectionId" | "agentIds" | "from" | "to"
  >,
  record: CaseRecord,
): boolean {
  return (
    value.connectionId === record.scope.connectionId &&
    (!value.caseId || value.caseId === record.id) &&
    value.from < record.scope.to &&
    value.to > record.scope.from &&
    value.agentIds.some((id) => record.scope.agentIds.includes(id))
  );
}
export function getContext(
  tx: ReadTx,
  id: string,
): BusinessContext | undefined {
  const row = tx.get<ContextRow>(
    "SELECT b.id,b.case_id,b.connection_id,v.* FROM business_context b JOIN context_versions v ON v.context_id=b.id AND v.version=b.latest_version WHERE b.id=?",
    [id],
  );
  return row ? contextRecord(row) : undefined;
}
export function contexts(tx: ReadTx, record: CaseRecord): BusinessContext[] {
  return tx
    .all<ContextRow>(
      "SELECT b.id,b.case_id,b.connection_id,v.* FROM business_context b JOIN context_versions v ON v.context_id=b.id AND v.version=b.latest_version WHERE b.connection_id=? AND (b.case_id=? OR b.case_id IS NULL) ORDER BY b.id",
      [record.scope.connectionId, record.id],
    )
    .map(contextRecord)
    .filter((value) => contextMatches(value, record));
}
export function change(
  deps: Dependencies,
  tx: WriteTx,
  ctx: CallContext,
  record: CaseRecord,
  expected: number,
  reason: string,
): Result<number> {
  if (!reason.trim()) return fail("INVALID_INPUT", "必须填写变更原因");
  if (record.revision !== expected)
    return fail("REVISION_CONFLICT", "案件已更新，请重新读取并审阅");
  const revision = expected + 1;
  if (
    tx.run(
      "UPDATE cases SET revision=?,updated_at=? WHERE id=? AND revision=?",
      [revision, deps.clock.now(), record.id, expected],
    ).changes !== 1
  )
    return fail("REVISION_CONFLICT", "案件已更新");
  audit(deps, tx, ctx, record.id, revision, reason);
  return ok(revision);
}
export function audit(
  deps: Dependencies,
  tx: WriteTx,
  ctx: CallContext,
  caseId: string,
  revision: number,
  reason: string,
) {
  tx.run(
    "INSERT INTO case_changes(id,case_id,revision,reason,actor_id,change_json,created_at) VALUES(?,?,?,?,?,?,?)",
    [
      deps.ids.next(),
      caseId,
      revision,
      reason,
      ctx.actor.principalId,
      canonicalJson({ reason }),
      deps.clock.now(),
    ],
  );
  deps.events.appendInTx(tx, ctx, {
    type: "case.changed",
    aggregateId: caseId,
    revision,
    payload: { caseId, revision, reason },
  });
}
export function runView(tx: ReadTx, ctx: CallContext, runId: string) {
  const auth = authorized(tx, ctx);
  if (!auth.ok) return auth;
  if (ctx.actor.runId && ctx.actor.runId !== runId)
    return fail("FORBIDDEN", "轮次不匹配");
  const row = tx.get<{
    id: string;
    case_id: string;
    scope_json: string;
    base_revision: number;
    identity_epoch: number;
  }>(
    "SELECT id,case_id,scope_json,base_revision,identity_epoch FROM analysis_runs WHERE id=?",
    [runId],
  );
  if (!row || row.identity_epoch !== ctx.actor.identityEpoch)
    return fail("NOT_FOUND", "轮次不存在或身份已改变");
  const record = getCase(tx, ctx, row.case_id);
  if (!record.ok) return record;
  return ok({
    id: row.id,
    caseId: row.case_id,
    scope: JSON.parse(row.scope_json) as Scope,
    baseRevision: row.base_revision,
    case: record.value,
  });
}
export function mutable(tx: ReadTx, runId: string): Result<void> {
  return tx.get("SELECT run_id FROM case_run_manifests WHERE run_id=?", [runId])
    ? fail("CONFLICT", "轮次已经封存")
    : ok(undefined);
}
export async function readResult<T>(
  db: DatabasePort,
  ctx: CallContext,
  work: (tx: ReadTx) => Result<T>,
): Promise<Result<T>> {
  const result = await db.read(ctx, work);
  return result.ok ? result.value : result;
}
