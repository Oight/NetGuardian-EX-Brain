import { createHash } from "node:crypto";
import {
  canonicalJson,
  decodeCursor,
  encodeCursor,
  fail,
  idSchema,
  ok,
  parseDto,
  parseWith,
  callContextSchema,
  type CallContext,
  type CaseAtomicPort,
  type DatabasePort,
  type InvestigationHistoryPort,
  type ReadTx,
  type ReportAnchorReadPort,
  type Result,
} from "@campussec/contracts";

const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
type Row = Record<string, unknown>;
function authorize(tx: ReadTx, ctx: CallContext): Result<void> {
  if (
    !parseWith(callContextSchema, ctx).ok ||
    !["ui", "system", "evidence", "delegation"].includes(ctx.actor.role)
  )
    return fail("FORBIDDEN", "调查读取入口未获授权");
  const space = tx.get<{
    space_id: string;
    principal_id: string;
    identity_epoch: number;
  }>("SELECT space_id,principal_id,identity_epoch FROM space_metadata");
  return space?.space_id === ctx.actor.spaceId &&
    space.principal_id === ctx.actor.principalId &&
    space.identity_epoch === ctx.actor.identityEpoch
    ? ok(undefined)
    : fail("IDENTITY_CHANGED", "主体空间已改变");
}
function runValue(row: Row) {
  return parseDto("AnalysisRun", {
    id: row.id,
    jobId: row.job_id,
    caseId: row.case_id,
    baseRevision: row.base_revision,
    scope: JSON.parse(row.scope_json as string),
    connectionGeneration: row.connection_generation,
    identityEpoch: row.identity_epoch,
    profileVersion: row.profile_version,
    toolEpoch: row.tool_epoch,
    expiresAt: row.expires_at,
    ...(row.manifest_hash ? { manifestHash: row.manifest_hash } : {}),
  });
}
function requestValue(row: Row) {
  return parseDto("InvestigationRequest", {
    id: row.id,
    origin: row.origin,
    state: row.state,
    connectionId: row.connection_id,
    question: row.question,
    seedRefs: JSON.parse(row.seed_refs_json as string),
    missingFields: JSON.parse(row.missing_fields_json as string),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.requested_scope_json
      ? { requestedScope: JSON.parse(row.requested_scope_json as string) }
      : {}),
    ...(row.effective_scope_json
      ? { effectiveScope: JSON.parse(row.effective_scope_json as string) }
      : {}),
    ...(row.case_id ? { caseId: row.case_id } : {}),
    ...(row.job_id ? { jobId: row.job_id } : {}),
    ...(row.origin_binding_id
      ? { originBindingId: row.origin_binding_id }
      : {}),
    ...(row.auto_candidate_id
      ? { autoCandidateId: row.auto_candidate_id }
      : {}),
  });
}
function jobValue(row: Row) {
  return parseDto("JobRecord", {
    id: row.id,
    requestId: row.request_id,
    caseId: row.case_id,
    origin: row.origin,
    state: row.state,
    revision: row.revision,
    recoveryHold: row.recovery_hold === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.policy_id ? { policyId: row.policy_id } : {}),
    ...(row.policy_epoch ? { policyEpoch: row.policy_epoch } : {}),
    ...(row.error_json ? { error: JSON.parse(row.error_json as string) } : {}),
  });
}
function ownedRun(tx: ReadTx, ctx: CallContext, runId: string): Result<Row> {
  const auth = authorize(tx, ctx);
  if (!auth.ok) return auth;
  if (!idSchema.safeParse(runId).success)
    return fail("INVALID_INPUT", "轮次标识无效");
  if (
    (ctx.actor.runId && ctx.actor.runId !== runId) ||
    (ctx.actor.role === "evidence" && ctx.actor.runId !== runId)
  )
    return fail("FORBIDDEN", "轮次不属于当前通道");
  const row = tx.get<Row>(
    "SELECT a.* FROM analysis_runs a JOIN jobs j ON j.id=a.job_id JOIN investigation_requests r ON r.id=j.request_id WHERE a.id=? AND r.principal_id=?",
    [runId, ctx.actor.principalId],
  );
  if (!row) return fail("NOT_FOUND", "调查轮次不存在");
  return row.identity_epoch === ctx.actor.identityEpoch
    ? ok(row)
    : fail("IDENTITY_CHANGED", "轮次身份已改变");
}

/** S07 owns these immutable read projections; consumers never parse S07 SQL/JSON. */
export function createReportAnchors(): ReportAnchorReadPort {
  return {
    runInTx(tx, ctx, runId) {
      const found = ownedRun(tx, ctx, runId);
      if (!found.ok) return found;
      const run = runValue(found.value);
      const input = parseDto(
        "FrozenRunInput",
        JSON.parse(found.value.initial_input_json as string),
      );
      if (!run.ok) return run;
      if (!input.ok) return input;
      return canonicalJson(input.value.scope) === canonicalJson(run.value.scope)
        ? ok({ run: run.value, question: input.value.question })
        : fail("VALIDATION_FAILED", "冻结范围不一致");
    },
    contextInTx(tx, ctx, context) {
      const auth = authorize(tx, ctx);
      if (!auth.ok) return auth;
      const parsed = parseDto("ResultContext", {
        requestId: context.requestId,
        jobId: context.jobId,
        caseId: context.caseId,
        scope: context.scope,
        ...(context.runId ? { runId: context.runId } : {}),
      });
      if (!parsed.ok) return parsed;
      const row = tx.get<Row>(
        "SELECT principal_id,job_id,case_id,connection_id FROM investigation_requests WHERE id=?",
        [context.requestId],
      );
      if (
        !row ||
        row.principal_id !== ctx.actor.principalId ||
        row.job_id !== context.jobId ||
        row.case_id !== context.caseId ||
        row.connection_id !== context.scope.connectionId
      )
        return fail("FORBIDDEN", "结果请求关联未获授权");
      const run = tx.get<Row>("SELECT id FROM analysis_runs WHERE job_id=?", [
        context.jobId,
      ]);
      if (context.runId && run?.id !== context.runId)
        return fail("FORBIDDEN", "结果轮次关联不匹配");
      if (ctx.actor.runId && ctx.actor.runId !== context.runId)
        return fail("FORBIDDEN", "结果超出当前轮次");
      return ok({ hasRun: !!run });
    },
  };
}

export function createInvestigationHistory(deps: {
  db: DatabasePort;
  casesAtomic: CaseAtomicPort;
}): InvestigationHistoryPort {
  async function read<T>(
    ctx: CallContext,
    work: (tx: ReadTx) => Result<T>,
  ): Promise<Result<T>> {
    const result = await deps.db.read(ctx, (tx) => {
      const auth = authorize(tx, ctx);
      if (!auth.ok) return auth;
      if (ctx.actor.role !== "ui")
        return fail("FORBIDDEN", "历史浏览仅允许当前主体界面");
      return work(tx);
    });
    return result.ok ? result.value : result;
  }
  return {
    list(ctx, raw) {
      const input = parseDto("InvestigationHistoryInput", raw);
      if (!input.ok) return Promise.resolve(input);
      return read(ctx, (tx) => {
        const found = deps.casesAtomic.getInTx(tx, ctx, input.value.caseId);
        if (!found.ok) return found;
        const queryHash = digest({
          kind: "history",
          caseId: input.value.caseId,
          principalId: ctx.actor.principalId,
          epoch: ctx.actor.identityEpoch,
        });
        let last: string[] = [];
        if (input.value.page.cursor) {
          const decoded = decodeCursor(input.value.page.cursor, {
            spaceId: ctx.actor.spaceId,
            queryHash,
          });
          if (!decoded.ok) return decoded;
          if (
            decoded.value.lastKeys.length !== 2 ||
            decoded.value.lastKeys.some((v) => typeof v !== "string")
          )
            return fail("CURSOR_INVALID", "历史游标无效");
          last = decoded.value.lastKeys as string[];
        }
        const rows = tx.all<Row>(
          "SELECT * FROM investigation_requests WHERE case_id=? AND principal_id=?" +
            (last.length
              ? " AND (created_at<? OR (created_at=? AND id<?))"
              : "") +
            " ORDER BY created_at DESC,id DESC LIMIT ?",
          [
            input.value.caseId,
            ctx.actor.principalId,
            ...(last.length ? [last[0]!, last[0]!, last[1]!] : []),
            input.value.page.limit + 1,
          ],
        );
        const items = [];
        for (const row of rows.slice(0, input.value.page.limit)) {
          const request = requestValue(row);
          if (!request.ok) return request;
          const jobRow = row.job_id
            ? tx.get<Row>("SELECT * FROM jobs WHERE id=? AND request_id=?", [
                row.job_id as string,
                row.id as string,
              ])
            : undefined;
          const job = jobRow ? jobValue(jobRow) : undefined;
          if (job && !job.ok) return job;
          const runRow = jobRow
            ? tx.get<Row>("SELECT * FROM analysis_runs WHERE job_id=?", [
                jobRow.id as string,
              ])
            : undefined;
          const run = runRow ? runValue(runRow) : undefined;
          if (run && !run.ok) return run;
          items.push({
            request: request.value,
            ...(job?.ok ? { job: job.value } : {}),
            ...(run?.ok ? { run: run.value } : {}),
          });
        }
        const lastRow = rows[Math.min(rows.length, input.value.page.limit) - 1];
        return ok({
          items,
          ...(rows.length > input.value.page.limit && lastRow
            ? {
                nextCursor: encodeCursor({
                  version: "0.1.0",
                  spaceId: ctx.actor.spaceId,
                  queryHash,
                  lastKeys: [
                    lastRow.created_at as string,
                    lastRow.id as string,
                  ],
                }),
              }
            : {}),
        });
      });
    },
    snapshot(ctx, raw) {
      const input = parseDto("InvestigationHistorySnapshotInput", raw);
      if (!input.ok) return Promise.resolve(input);
      return read(ctx, (tx) => {
        const found = ownedRun(tx, ctx, input.value.runId);
        if (!found.ok) return found;
        const run = runValue(found.value);
        if (!run.ok) return run;
        const permitted = deps.casesAtomic.getInTx(tx, ctx, run.value.caseId);
        if (!permitted.ok) return permitted;
        const view = deps.casesAtomic.inspectRunInTx(tx, ctx, run.value);
        if (!view.ok) return view;
        const jobRow = tx.get<Row>("SELECT * FROM jobs WHERE id=?", [
          run.value.jobId,
        ]);
        if (!jobRow) return fail("VALIDATION_FAILED", "历史任务缺失");
        const job = jobValue(jobRow);
        if (!job.ok) return job;
        const initial = parseDto(
          "FrozenRunInput",
          JSON.parse(found.value.initial_input_json as string),
        );
        if (!initial.ok) return initial;
        const profile = found.value.prepared_profile_json
          ? parseDto(
              "PreparedProfile",
              JSON.parse(found.value.prepared_profile_json as string),
            )
          : undefined;
        if (profile && !profile.ok) return profile;
        const projections = [...view.value.projections].sort((a, b) =>
          a.id.localeCompare(b.id),
        );
        const queries = [...view.value.queries].sort((a, b) =>
          a.queryId.localeCompare(b.queryId),
        );
        // Bind pages to the exact read view so concurrent delivery/cleanup requires a fresh browse.
        const queryHash = digest({
          kind: "run-input",
          runId: run.value.id,
          epoch: ctx.actor.identityEpoch,
          view: view.value,
        });
        let offset = 0;
        if (input.value.page.cursor) {
          const decoded = decodeCursor(input.value.page.cursor, {
            spaceId: ctx.actor.spaceId,
            queryHash,
          });
          if (!decoded.ok) return decoded;
          if (
            decoded.value.lastKeys.length !== 1 ||
            !Number.isSafeInteger(decoded.value.lastKeys[0]) ||
            Number(decoded.value.lastKeys[0]) < 0
          )
            return fail("CURSOR_INVALID", "输入清单游标无效");
          offset = Number(decoded.value.lastKeys[0]);
        }
        const end = offset + input.value.page.limit;
        return ok({
          run: run.value,
          job: job.value,
          initialInput: initial.value,
          ...(profile?.ok ? { preparedProfile: profile.value } : {}),
          projections: projections.slice(offset, end),
          queries: queries.slice(offset, end),
          ...(end < Math.max(projections.length, queries.length)
            ? {
                nextCursor: encodeCursor({
                  version: "0.1.0",
                  spaceId: ctx.actor.spaceId,
                  queryHash,
                  lastKeys: [end],
                }),
              }
            : {}),
        });
      });
    },
  };
}
