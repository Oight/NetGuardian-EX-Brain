import {
  dtoSchemas,
  parseWith,
  type CallContext,
  type ClockPort,
  type DatabasePort,
  type Result,
  type WorkspaceSnapshot,
} from "@campussec/contracts";

const optional = (key: string, value: unknown) =>
  value === null || value === undefined ? {} : { [key]: value };
const json = (value: unknown): unknown => JSON.parse(String(value));

/** Approved, read-only projection of public summary columns; no private repository import. */
export function readWorkspace(
  db: DatabasePort,
  clock: ClockPort,
  ctx: CallContext,
  connectionId?: string,
): Promise<Result<WorkspaceSnapshot>> {
  return db.read(ctx, (tx) => {
    const filter = connectionId ? " WHERE connection_id=?" : "";
    const parameters = connectionId ? [connectionId] : [];
    const connections = tx
      .all<{ id: string; display_name: string; generation: number }>(
        `SELECT id,display_name,generation FROM connections${connectionId ? " WHERE id=?" : ""} ORDER BY id`,
        parameters,
      )
      .map((row) => ({
        id: row.id,
        displayName: row.display_name,
        generation: row.generation,
      }));
    const cases = tx
      .all<Record<string, unknown>>(
        `SELECT id,revision,title,scope_json,status,current_report_id,latest_report_id,created_at,updated_at FROM cases${filter} ORDER BY updated_at DESC,id DESC LIMIT 20`,
        parameters,
      )
      .map((row) => ({
        id: row.id,
        spaceId: ctx.actor.spaceId,
        revision: row.revision,
        title: row.title,
        scope: json(row.scope_json),
        status: row.status,
        ...optional("currentReportId", row.current_report_id),
        ...optional("latestReportId", row.latest_report_id),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    const requestFilter =
      " WHERE principal_id=?" + (connectionId ? " AND connection_id=?" : "");
    const requestParameters = [ctx.actor.principalId, ...parameters];
    const requests = tx
      .all<Record<string, unknown>>(
        `SELECT id,origin,state,connection_id,question,requested_scope_json,effective_scope_json,seed_refs_json,case_id,job_id,origin_binding_id,auto_candidate_id,missing_fields_json,created_at,expires_at FROM investigation_requests${requestFilter} ORDER BY created_at DESC,id DESC LIMIT 20`,
        requestParameters,
      )
      .map((row) => ({
        id: row.id,
        origin: row.origin,
        state: row.state,
        connectionId: row.connection_id,
        question: row.question,
        ...(row.requested_scope_json
          ? { requestedScope: json(row.requested_scope_json) }
          : {}),
        ...(row.effective_scope_json
          ? { effectiveScope: json(row.effective_scope_json) }
          : {}),
        seedRefs: json(row.seed_refs_json),
        ...optional("caseId", row.case_id),
        ...optional("jobId", row.job_id),
        ...optional("originBindingId", row.origin_binding_id),
        ...optional("autoCandidateId", row.auto_candidate_id),
        missingFields: json(row.missing_fields_json),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      }));
    const active =
      "('preparing','submitting','running','verifying','cancel_requested','uncertain')";
    const jobFilter = ` WHERE r.principal_id=?${connectionId ? " AND r.connection_id=?" : ""}`;
    const jobs = tx
      .all<Record<string, unknown>>(
        `SELECT j.id,j.request_id,j.case_id,j.run_id,j.origin,j.state,j.revision,j.created_at,j.updated_at,j.expires_at,j.recovery_hold,j.policy_id,j.policy_epoch,j.error_json FROM jobs j JOIN investigation_requests r ON r.id=j.request_id${jobFilter} AND j.state IN ${active} ORDER BY j.created_at,j.id`,
        requestParameters,
      )
      .map((row) => ({
        id: row.id,
        requestId: row.request_id,
        caseId: row.case_id,
        ...optional("runId", row.run_id),
        origin: row.origin,
        state: row.state,
        revision: row.revision,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at,
        recoveryHold: Boolean(row.recovery_hold),
        ...optional("policyId", row.policy_id),
        ...optional("policyEpoch", row.policy_epoch),
        ...(row.error_json ? { error: json(row.error_json) } : {}),
      }));
    const caseTotal = tx.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM cases${filter}`,
      parameters,
    )!.total;
    const queued = tx.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM jobs j JOIN investigation_requests r ON r.id=j.request_id${jobFilter} AND j.state IN ('coalescing','queued')`,
      requestParameters,
    )!.total;
    const eventSeq = tx.get<{ seq: number }>(
      "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='domain_events'),0) AS seq",
    )!.seq;
    const parsed = parseWith(dtoSchemas.WorkspaceSnapshot, {
      eventSeq,
      generatedAt: clock.now(),
      connections,
      cases,
      requests,
      jobs,
      totals: { cases: caseTotal, queued, active: jobs.length },
    });
    if (!parsed.ok) throw new Error("Stored workspace projection is invalid");
    return parsed.value;
  });
}
