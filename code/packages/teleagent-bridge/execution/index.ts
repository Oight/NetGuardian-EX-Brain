import {
  canonicalJson,
  fail,
  ok,
  parseDto,
  type AnalysisRun,
  type CallContext,
  type ClockPort,
  type DatabasePort,
  type ExecutionPort,
  type ExecutionSnapshot,
  type IdPort,
  type Result,
} from "@campussec/contracts";
/** Version-specific network adapter. A caller must provide a verified mapping; none is inferred from /ready. */
export interface ExecutionControl {
  signal: AbortSignal;
  /** Save a newly created session before any prompt can be submitted. */
  checkpoint(snapshot: ExecutionSnapshot): Promise<Result<void>>;
}
export interface ExecutionWire {
  start(
    ctx: CallContext,
    input: Parameters<ExecutionPort["start"]>[1],
    control?: ExecutionControl,
  ): Promise<Result<ExecutionSnapshot>>;
  inspect(
    ctx: CallContext,
    runId: string,
    known: ExecutionSnapshot,
    control?: ExecutionControl,
  ): Promise<Result<ExecutionSnapshot>>;
  abort(
    ctx: CallContext,
    runId: string,
    known: ExecutionSnapshot,
    control?: ExecutionControl,
  ): Promise<Result<ExecutionSnapshot>>;
}
export interface ExecutionDependencies {
  db: DatabasePort;
  clock: ClockPort;
  ids: IdPort;
  wire?: ExecutionWire;
  timeoutMs?: number;
}
interface Attempt {
  id: string;
  phase: string;
  snapshot_json: string | null;
  host_identity_json: string;
}
export function createExecutionDriver(
  deps: ExecutionDependencies,
): ExecutionPort {
  const pending = new Map<string, Promise<Result<ExecutionSnapshot>>>();
  const unknown = (runId: string): ExecutionSnapshot => ({
    runId,
    phase: "uncertain",
    verification: "unverified",
    observedAt: deps.clock.now(),
  });
  async function operate(
    ctx: CallContext,
    runId: string,
    operation: "start" | "inspect" | "abort",
    input?: Parameters<ExecutionPort["start"]>[1],
  ): Promise<Result<ExecutionSnapshot>> {
    if (ctx.actor.role !== "system")
      return fail("FORBIDDEN", "执行驱动仅允许协调者调用");
    if (!deps.wire)
      return fail(
        "CAPABILITY_UNAVAILABLE",
        "尚未配置经核实的 TeleAgent 版本接口与专用调查通道",
      );
    if (operation === "start") {
      const run = parseDto("AnalysisRun", input?.run),
        profile = parseDto("PreparedProfile", input?.profile),
        channel = parseDto("ChannelHandle", input?.channel);
      if (!run.ok) return run;
      if (!profile.ok) return profile;
      if (!channel.ok) return channel;
      if (channel.value.runId !== runId || channel.value.state === "revoked")
        return fail("FORBIDDEN", "提交通道不属于当前轮次");
    }
    const prepared = await deps.db.write<
      | {
          existing: ExecutionSnapshot;
        }
      | {
          id: string;
          known: ExecutionSnapshot;
        }
    >(ctx, (tx) => {
      const row = tx.get<{
        identity_epoch: number;
        scope_json: string;
        expires_at: string;
        tool_epoch: number;
        prepared_profile_json: string;
        connection_generation: number;
        base_revision: number;
        job_id: string;
        case_id: string;
        profile_version: string;
      }>("SELECT * FROM analysis_runs WHERE id=?", [runId]);
      if (!row || row.identity_epoch !== ctx.actor.identityEpoch)
        return fail("IDENTITY_CHANGED", "执行轮次或身份不匹配");
      if (operation === "start" && row.expires_at <= deps.clock.now())
        return fail("EXPIRED", "提交前轮次已过期");
      if (
        operation === "start" &&
        (canonicalJson(input!.run.scope) !== row.scope_json ||
          input!.run.toolEpoch !== row.tool_epoch ||
          input!.run.connectionGeneration !== row.connection_generation ||
          input!.run.baseRevision !== row.base_revision ||
          input!.run.jobId !== row.job_id ||
          input!.run.caseId !== row.case_id ||
          input!.run.profileVersion !== row.profile_version ||
          canonicalJson(input!.profile) !== row.prepared_profile_json)
      )
        return fail("REVISION_CONFLICT", "提交输入与冻结轮次不一致");
      const old = tx.get<Attempt>(
        "SELECT * FROM execution_attempts WHERE run_id=? AND operation='start' ORDER BY attempt DESC LIMIT 1",
        [runId],
      );
      if (operation === "start" && old) {
        // An intent surviving a lost response is NOT permission to submit again.
        try {
          return ok({
            existing: old.snapshot_json
              ? (JSON.parse(old.snapshot_json) as ExecutionSnapshot)
              : unknown(runId),
          });
        } catch {
          return fail("VALIDATION_FAILED", "执行账本损坏");
        }
      }
      if (operation !== "start" && !old)
        return fail("NOT_FOUND", "轮次没有已保存的提交意图");
      const known = old?.snapshot_json
        ? (JSON.parse(old.snapshot_json) as ExecutionSnapshot)
        : unknown(runId);
      const attempt = tx.get<{
        n: number;
      }>(
        "SELECT COALESCE(MAX(attempt),0)+1 AS n FROM execution_attempts WHERE run_id=? AND operation=?",
        [runId, operation],
      )!.n;
      const id = deps.ids.next();
      tx.run(
        "INSERT INTO execution_attempts(id,run_id,attempt,operation,phase,host_identity_json,intent_at) VALUES(?,?,?,?,?,?,?)",
        [
          id,
          runId,
          attempt,
          operation,
          "intent",
          canonicalJson({
            principalId: ctx.actor.principalId,
            identityEpoch: ctx.actor.identityEpoch,
            toolEpoch: row.tool_epoch,
          }),
          deps.clock.now(),
        ],
      );
      return ok({ id, known });
    });
    if (!prepared.ok) return prepared;
    if ("existing" in prepared.value) return ok(prepared.value.existing);
    const { id, known } = prepared.value;
    const controller = new AbortController();
    let accepting = true;
    let checkpointed = known;
    const control: ExecutionControl = {
      signal: controller.signal,
      async checkpoint(value) {
        if (!accepting || operation !== "start")
          return fail("EXPIRED", "执行映射写入窗口已关闭");
        const parsed = parseDto("ExecutionSnapshot", value);
        if (
          !parsed.ok ||
          parsed.value.runId !== runId ||
          (checkpointed.sessionId &&
            parsed.value.sessionId !== checkpointed.sessionId) ||
          (checkpointed.userMessageId &&
            parsed.value.userMessageId !== checkpointed.userMessageId)
        )
          return fail("IDENTITY_CHANGED", "执行映射不能重定向");
        const saved = await deps.db.write(ctx, (tx) => {
          if (!accepting) return fail("EXPIRED", "执行映射写入窗口已关闭");
          const live = tx.get<{
            identity_epoch: number;
            expires_at: string;
            state: string;
            tool_epoch: number;
            connection_generation: number;
            live_generation: number;
            job_expires_at: string;
          }>(
            "SELECT r.identity_epoch,r.expires_at,r.tool_epoch,r.connection_generation,j.state,j.expires_at AS job_expires_at,c.generation AS live_generation FROM analysis_runs r JOIN jobs j ON j.id=r.job_id JOIN investigation_requests q ON q.id=j.request_id JOIN connections c ON c.id=q.connection_id WHERE r.id=?",
            [runId],
          );
          if (!live || live.identity_epoch !== ctx.actor.identityEpoch)
            return fail("IDENTITY_CHANGED", "保存执行映射时身份已改变");
          if (
            live.connection_generation !== live.live_generation ||
            live.tool_epoch !== input!.run.toolEpoch
          )
            return fail("IDENTITY_CHANGED", "提交前连接或工具代次已变化");
          if (
            live.expires_at <= deps.clock.now() ||
            live.job_expires_at <= deps.clock.now() ||
            !["submitting", "running"].includes(live.state)
          )
            return fail("CANCELLED", "保存执行映射前轮次已停止");
          tx.run(
            "UPDATE execution_attempts SET session_id=?,user_message_id=?,snapshot_json=?,observed_at=? WHERE id=?",
            [
              value.sessionId ?? null,
              value.userMessageId ?? null,
              canonicalJson(parsed.value),
              deps.clock.now(),
              id,
            ],
          );
          return ok(undefined);
        });
        if (saved.ok) checkpointed = parsed.value;
        return saved;
      },
    };
    let snapshot: ExecutionSnapshot;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const response = await Promise.race([
        Promise.resolve().then(() =>
          operation === "start"
            ? deps.wire!.start(ctx, input!, control)
            : operation === "abort"
              ? deps.wire!.abort(ctx, runId, known, control)
              : deps.wire!.inspect(ctx, runId, known, control),
        ),
        new Promise<Result<ExecutionSnapshot>>((resolve) => {
          timer = setTimeout(
            () => {
              accepting = false;
              controller.abort();
              resolve(
                ok({
                  ...unknown(runId),
                  ...(checkpointed.sessionId
                    ? { sessionId: checkpointed.sessionId }
                    : {}),
                  ...(checkpointed.userMessageId
                    ? { userMessageId: checkpointed.userMessageId }
                    : {}),
                }),
              );
            },
            Math.max(1, Math.min(10000, deps.timeoutMs ?? 10000)),
          );
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      const parsed = response.ok
        ? parseDto("ExecutionSnapshot", response.value)
        : response;
      snapshot =
        parsed.ok && parsed.value.runId === runId
          ? parsed.value
          : unknown(runId);
      if (
        (checkpointed.sessionId &&
          snapshot.sessionId !== checkpointed.sessionId) ||
        (checkpointed.userMessageId &&
          snapshot.userMessageId !== checkpointed.userMessageId)
      )
        snapshot = unknown(runId);
      if (
        snapshot.phase === "completed" &&
        (snapshot.verification !== "verified" ||
          !snapshot.sessionId ||
          !snapshot.userMessageId ||
          !snapshot.resultMessageId)
      )
        snapshot = unknown(runId);
      if (
        ["submitted", "running"].includes(snapshot.phase) &&
        (!snapshot.sessionId || !snapshot.userMessageId)
      )
        snapshot = unknown(runId);
    } catch {
      snapshot = {
        ...unknown(runId),
        ...(checkpointed.sessionId
          ? { sessionId: checkpointed.sessionId }
          : {}),
        ...(checkpointed.userMessageId
          ? { userMessageId: checkpointed.userMessageId }
          : {}),
      };
    } finally {
      accepting = false;
      controller.abort();
    }
    // Unknown responses must retain the last durable association for reconciliation.
    if (!snapshot.sessionId && checkpointed.sessionId)
      snapshot = { ...snapshot, sessionId: checkpointed.sessionId };
    if (!snapshot.userMessageId && checkpointed.userMessageId)
      snapshot = { ...snapshot, userMessageId: checkpointed.userMessageId };
    const saved = await deps.db.write(ctx, (tx) => {
      const live = tx.get<{
        identity_epoch: number;
      }>("SELECT identity_epoch FROM analysis_runs WHERE id=?", [runId]);
      if (!live || live.identity_epoch !== ctx.actor.identityEpoch)
        return fail("IDENTITY_CHANGED", "执行响应到达时身份已改变");
      tx.run(
        "UPDATE execution_attempts SET phase=?,session_id=?,user_message_id=?,result_message_id=?,snapshot_json=?,observed_at=? WHERE id=?",
        [
          snapshot.phase,
          snapshot.sessionId ?? null,
          snapshot.userMessageId ?? null,
          snapshot.resultMessageId ?? null,
          canonicalJson(snapshot),
          deps.clock.now(),
          id,
        ],
      );
      // Persist latest normalized observation on the original start ledger as well.
      if (operation !== "start")
        tx.run(
          "UPDATE execution_attempts SET phase=?,session_id=?,user_message_id=?,result_message_id=?,snapshot_json=?,observed_at=? WHERE run_id=? AND operation='start'",
          [
            snapshot.phase,
            snapshot.sessionId ?? null,
            snapshot.userMessageId ?? null,
            snapshot.resultMessageId ?? null,
            canonicalJson(snapshot),
            deps.clock.now(),
            runId,
          ],
        );
      return ok(snapshot);
    });
    return saved;
  }
  async function serialize(
    ctx: CallContext,
    runId: string,
    operation: "start" | "inspect" | "abort",
    input?: Parameters<ExecutionPort["start"]>[1],
  ) {
    const previous = pending.get(runId);
    const task = (
      previous ? previous.catch(() => undefined) : Promise.resolve()
    ).then(() => operate(ctx, runId, operation, input));
    pending.set(runId, task);
    try {
      return await task;
    } finally {
      if (pending.get(runId) === task) pending.delete(runId);
    }
  }
  return {
    start: (ctx, input) => serialize(ctx, input.run.id, "start", input),
    inspect: (ctx, id) => serialize(ctx, id, "inspect"),
    abort: (ctx, id) => serialize(ctx, id, "abort"),
  };
}
