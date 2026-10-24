import {
  DEFAULT_LIMITS, fail, ok, parseDto, parseScope, parseWith, callContextSchema, idSchema,
  type AnalysisRun, type BudgetReservation, type CallContext, type ClockPort, type DatabasePort,
  type IdPort, type ReadTx, type Result, type RunBudgetAtomicPort, type RunBudgetPort, type WriteTx,
} from '@campussec/contracts';

export interface RunBudgetDependencies { db: DatabasePort; clock: ClockPort; ids: IdPort }
interface RunRow {
  id: string; job_id: string; case_id: string; base_revision: number; scope_json: string;
  connection_generation: number; identity_epoch: number; profile_version: string; tool_epoch: number;
  expires_at: string; manifest_hash: string | null; sealed_at: string | null;
  state: string; recovery_hold: number; job_expires_at: string; request_principal: string;
  space_id: string; principal_id: string; space_epoch: number;
}
interface ReservationRow { id: string; run_id: string; tool_epoch: number; identity_epoch: number; connection_generation: number; expires_at: string }

/** Standalone S07 budget owner: no host, MCP, evidence callback or business-state transition. */
export function createRunBudget(deps: RunBudgetDependencies): { budget: RunBudgetPort; atomic: RunBudgetAtomicPort } {
  function assertOpen(tx: ReadTx, ctx: CallContext, runId: string): Result<AnalysisRun> {
    if (!parseWith(callContextSchema, ctx).ok || !idSchema.safeParse(runId).success) return fail('INVALID_INPUT', '调用上下文或轮次无效');
    if ((ctx.actor.runId && ctx.actor.runId !== runId) || (ctx.actor.role === 'evidence' && ctx.actor.runId !== runId)) return fail('FORBIDDEN', '调用主体未绑定该轮次');
    // Read-only fence projection: only identities, run/job lifecycle and connection generation.
    const row = tx.get<RunRow>(`SELECT r.*, j.state, j.recovery_hold, j.expires_at AS job_expires_at,
      q.principal_id AS request_principal, m.space_id, m.principal_id, m.identity_epoch AS space_epoch
      FROM analysis_runs r JOIN jobs j ON j.id=r.job_id AND j.run_id=r.id
      JOIN investigation_requests q ON q.id=j.request_id CROSS JOIN space_metadata m WHERE r.id=?`, [runId]);
    if (!row) return fail('NOT_FOUND', '调查轮次不存在');
    if (row.space_id !== ctx.actor.spaceId || row.principal_id !== ctx.actor.principalId || row.request_principal !== ctx.actor.principalId) return fail('FORBIDDEN', '调查主体不匹配');
    if (row.identity_epoch !== ctx.actor.identityEpoch || row.space_epoch !== ctx.actor.identityEpoch) return fail('IDENTITY_CHANGED', '调查身份代次已改变');
    if (row.recovery_hold || row.state === 'uncertain') return fail('UNCERTAIN', '调查尚待恢复核实');
    if (row.state === 'cancel_requested' || row.state === 'cancelled') return fail('CANCELLED', '调查已请求取消');
    if (!['preparing', 'submitting', 'running'].includes(row.state) || row.sealed_at) return fail('EXPIRED', '调查不再接受取证');
    const now = Date.parse(deps.clock.now());
    if (!Number.isFinite(now)) return fail('INVALID_INPUT', '时钟无效');
    if (Date.parse(row.expires_at) <= now || Date.parse(row.job_expires_at) <= now) return fail('EXPIRED', '调查已过期');
    let scope;
    try { scope = parseScope(JSON.parse(row.scope_json)); } catch { return fail('VALIDATION_FAILED', '轮次作用域损坏'); }
    if (!scope.ok) return fail('VALIDATION_FAILED', '轮次作用域无效');
    const connection = tx.get<{ generation: number }>('SELECT generation FROM connections WHERE id=?', [scope.value.connectionId]);
    if (!connection || connection.generation !== row.connection_generation) return fail('IDENTITY_CHANGED', '连接代次已改变');
    return parseDto('AnalysisRun', { id: row.id, jobId: row.job_id, caseId: row.case_id, baseRevision: row.base_revision, scope: scope.value,
      connectionGeneration: row.connection_generation, identityEpoch: row.identity_epoch, profileVersion: row.profile_version,
      toolEpoch: row.tool_epoch, expiresAt: row.expires_at, ...(row.manifest_hash ? { manifestHash: row.manifest_hash } : {}) });
  }
  const atomic: RunBudgetAtomicPort = {
    assertRunOpenInTx: assertOpen,
    reserveToolInTx(tx, ctx, input) {
      const run = assertOpen(tx, ctx, input.runId); if (!run.ok) return run;
      if (typeof input.isRead !== 'boolean' || typeof input.toolName !== 'string' || !input.toolName.length || input.toolName.length > 128 || /[\u0000-\u001f\u007f]/.test(input.toolName)) return fail('INVALID_INPUT', '工具名或读取类别无效');
      const counts = tx.get<{ tools: number; reads: number }>('SELECT COUNT(*) AS tools, COALESCE(SUM(is_read),0) AS reads FROM tool_reservations WHERE run_id=?', [input.runId])!;
      if (counts.tools >= DEFAULT_LIMITS.toolCalls || (input.isRead && counts.reads >= DEFAULT_LIMITS.readCalls)) return fail('BUDGET_EXHAUSTED', '工具或读取预算耗尽');
      const reservation: BudgetReservation = { id: deps.ids.next(), runId: input.runId, toolName: input.toolName, toolOrdinal: counts.tools + 1,
        expiresAt: run.value.expiresAt, toolEpoch: run.value.toolEpoch, identityEpoch: run.value.identityEpoch, connectionGeneration: run.value.connectionGeneration };
      const valid = parseDto('BudgetReservation', reservation); if (!valid.ok) return valid;
      tx.run('INSERT INTO tool_reservations(id,run_id,tool_name,tool_ordinal,is_read,expires_at,tool_epoch,identity_epoch,connection_generation) VALUES(?,?,?,?,?,?,?,?,?)',
        [reservation.id, reservation.runId, reservation.toolName, reservation.toolOrdinal, input.isRead ? 1 : 0, reservation.expiresAt, reservation.toolEpoch, reservation.identityEpoch, reservation.connectionGeneration]);
      return ok(reservation);
    },
    recordEventsInTx(tx, ctx, input) {
      const run = assertOpen(tx, ctx, input.runId); if (!run.ok) return run;
      if (!Array.isArray(input.sourceKeys) || !input.sourceKeys.every(key => typeof key === 'string' && key.length > 0 && key.length <= 4096)) return fail('INVALID_INPUT', '来源身份无效');
      const existing = new Set(tx.all<{ source_key: string }>('SELECT source_key FROM run_event_keys WHERE run_id=?', [input.runId]).map(row => row.source_key));
      const added = [...new Set(input.sourceKeys)].filter(key => !existing.has(key));
      if (existing.size + added.length > DEFAULT_LIMITS.distinctEvents) return fail('BUDGET_EXHAUSTED', '不同事件预算耗尽');
      for (const key of added) tx.run('INSERT INTO run_event_keys(run_id,source_key) VALUES(?,?)', [input.runId, key]);
      return ok(undefined);
    },
  };
  const budget: RunBudgetPort = {
    async assertRunOpen(ctx, runId) { const read = await deps.db.read(ctx, tx => assertOpen(tx, ctx, runId)); return read.ok ? read.value : read; },
    reservePlatformAttempt(ctx, reservationId) {
      return deps.db.write(ctx, tx => {
        if (!idSchema.safeParse(reservationId).success) return fail('INVALID_INPUT', '预算凭据无效');
        const reservation = tx.get<ReservationRow>('SELECT * FROM tool_reservations WHERE id=?', [reservationId]);
        if (!reservation) return fail('NOT_FOUND', '预算凭据不存在');
        const run = assertOpen(tx, ctx, reservation.run_id); if (!run.ok) return run;
        if (reservation.tool_epoch !== run.value.toolEpoch || reservation.identity_epoch !== run.value.identityEpoch || reservation.connection_generation !== run.value.connectionGeneration) return fail('IDENTITY_CHANGED', '旧预算凭据已失效');
        if (Date.parse(reservation.expires_at) <= Date.parse(deps.clock.now())) return fail('EXPIRED', '预算凭据已过期');
        const count = tx.get<{ used: number }>('SELECT COUNT(*) AS used FROM platform_attempts WHERE run_id=?', [run.value.id])!.used;
        if (count >= DEFAULT_LIMITS.platformAttempts) return fail('BUDGET_EXHAUSTED', '平台请求预算耗尽');
        tx.run('INSERT INTO platform_attempts(id,reservation_id,run_id,attempted_at) VALUES(?,?,?,?)', [deps.ids.next(), reservationId, run.value.id, deps.clock.now()]);
        return ok(undefined);
      });
    },
  };
  return { budget, atomic };
}
