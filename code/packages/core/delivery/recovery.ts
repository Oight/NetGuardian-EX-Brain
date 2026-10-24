import {
  callContextSchema,
  canonicalJson,
  fail,
  ok,
  parseDto,
  parseWith,
  type CallContext,
  type ClockPort,
  type DatabasePort,
  type DeliveryRecord,
  type DeliveryRecoveryInput,
  type DeliveryRecoveryPort,
  type DeliveryRetrySafetyPort,
  type EventPort,
  type HostDeliveryPort,
  type OriginBinding,
  type ReadTx,
  type Result,
  type ResultPackageReadPort,
} from "@campussec/contracts";

type Row = {
  id: string;
  binding_id: string;
  request_id: string;
  run_id: string | null;
  result_version: number;
  delivery_key: string;
  state: DeliveryRecord["state"];
  attempts: number;
  receipt_json: string | null;
  last_error_json: string | null;
  next_attempt_at: string | null;
};
export function createDeliveryRecovery(deps: {
  db: DatabasePort;
  clock: ClockPort;
  events: EventPort;
  host: HostDeliveryPort;
  retrySafety: DeliveryRetrySafetyPort;
  results: ResultPackageReadPort;
}): DeliveryRecoveryPort {
  function inspect(
    tx: ReadTx,
    ctx: CallContext,
    input: DeliveryRecoveryInput,
  ): Result<{ record: DeliveryRecord; binding: OriginBinding }> {
    if (!parseWith(callContextSchema, ctx).ok || ctx.actor.role !== "ui")
      return fail("FORBIDDEN", "投递恢复仅允许主体界面");
    const space = tx.get<{
      space_id: string;
      principal_id: string;
      identity_epoch: number;
    }>("SELECT space_id,principal_id,identity_epoch FROM space_metadata");
    if (
      space?.space_id !== ctx.actor.spaceId ||
      space.principal_id !== ctx.actor.principalId ||
      space.identity_epoch !== ctx.actor.identityEpoch
    )
      return fail("IDENTITY_CHANGED", "主体空间已改变");
    const row = tx.get<Row>("SELECT * FROM result_deliveries WHERE id=?", [
      input.deliveryId,
    ]);
    if (!row) return fail("NOT_FOUND", "投递记录不存在");
    if (
      row.state !== input.expectedState ||
      row.attempts !== input.expectedAttempts
    )
      return fail("REVISION_CONFLICT", "投递记录已改变，请重新读取");
    const origin = tx.get<Record<string, unknown>>(
      "SELECT * FROM origin_bindings WHERE id=?",
      [row.binding_id],
    );
    if (!origin || origin.principal_id !== ctx.actor.principalId)
      return fail("FORBIDDEN", "来源不属于当前主体");
    const binding = parseDto("OriginBinding", {
      id: origin.id,
      spaceId: ctx.actor.spaceId,
      principalId: origin.principal_id,
      hostId: origin.host_id,
      hostAccountId: origin.host_account_id,
      workspaceId: origin.workspace_id,
      sessionId: origin.session_id,
      requestMessageId: origin.request_message_id,
      state: origin.state,
      createdAt: origin.created_at,
      expiresAt: origin.expires_at,
    });
    if (!binding.ok) return binding;
    if (
      binding.value.state !== "active" ||
      binding.value.expiresAt <= deps.clock.now()
    )
      return fail("FORBIDDEN", "来源已撤销或过期");
    const subscription = tx.get<{ state: string }>(
      "SELECT state FROM result_subscriptions WHERE request_id=? AND binding_id=?",
      [row.request_id, row.binding_id],
    );
    if (subscription?.state !== "active")
      return fail("FORBIDDEN", "结果订阅已撤回");
    const result = deps.results.getInTx(tx, ctx, {
      requestId: row.request_id,
      resultVersion: row.result_version,
    });
    if (!result.ok) return result;
    if (result.value.runId !== (row.run_id ?? undefined))
      return fail("VALIDATION_FAILED", "投递轮次关联不匹配");
    try {
      const record = parseDto("DeliveryRecord", {
        id: row.id,
        originBindingId: row.binding_id,
        requestId: row.request_id,
        ...(row.run_id ? { runId: row.run_id } : {}),
        resultVersion: row.result_version,
        deliveryKey: row.delivery_key,
        state: row.state,
        attempts: row.attempts,
        result: result.value,
        ...(row.receipt_json ? { receipt: JSON.parse(row.receipt_json) } : {}),
        ...(row.last_error_json
          ? { lastError: JSON.parse(row.last_error_json) }
          : {}),
        ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
      });
      return record.ok
        ? ok({ record: record.value, binding: binding.value })
        : record;
    } catch {
      return fail("VALIDATION_FAILED", "投递快照损坏");
    }
  }
  return {
    async recover(ctx, raw) {
      const input = parseDto("DeliveryRecoveryInput", raw);
      if (!input.ok) return input;
      const read = await deps.db.read(ctx, (tx) =>
        inspect(tx, ctx, input.value),
      );
      if (!read.ok) return read;
      if (!read.value.ok) return read.value;
      const before = read.value.value;
      // Host I/O is outside transactions; authorization and CAS are repeated after I/O.
      const live = await deps.host.binding(ctx, before.binding.id);
      if (!live.ok) return live;
      const parsed = parseDto("OriginBinding", live.value);
      if (!parsed.ok) return parsed;
      if (canonicalJson(parsed.value) !== canonicalJson(before.binding))
        return fail("FORBIDDEN", "宿主来源绑定已改变");
      const reconciled = await deps.host.reconcileDelivery(ctx, {
        binding: parsed.value,
        deliveryKey: before.record.deliveryKey,
      });
      if (!reconciled.ok) return reconciled;
      if (reconciled.value.state === "unknown")
        return fail("UNCERTAIN", "宿主尚不能确认投递结果，禁止重发");
      let receipt: DeliveryRecord["receipt"];
      if (reconciled.value.state === "found") {
        const checked = parseDto("HostReceipt", reconciled.value.receipt);
        if (!checked.ok) return checked;
        if (!checked.value.visible)
          return fail("UNCERTAIN", "宿主回执尚不可见，禁止重发");
        receipt = checked.value;
      } else if (reconciled.value.state === "absent") {
        const safe = await deps.retrySafety.canRetryAbsent(ctx, {
          bindingId: before.binding.id,
          deliveryKey: before.record.deliveryKey,
        });
        if (!safe.ok) return safe;
        if (safe.value !== true)
          return fail("UNCERTAIN", "宿主没有确认相同投递键可安全重试");
      } else return fail("VALIDATION_FAILED", "宿主核实状态无效");
      return deps.db.write(ctx, (tx) => {
        const current = inspect(tx, ctx, input.value);
        if (!current.ok) return current;
        if (canonicalJson(current.value) !== canonicalJson(before))
          return fail("REVISION_CONFLICT", "核实期间投递或来源已改变");
        const state = receipt ? ("delivered" as const) : ("pending" as const);
        const updated = tx.run(
          "UPDATE result_deliveries SET state=?,receipt_json=?,last_error_json=NULL,next_attempt_at=NULL WHERE id=? AND state=? AND attempts=?",
          [
            state,
            receipt ? canonicalJson(receipt) : null,
            input.value.deliveryId,
            input.value.expectedState,
            input.value.expectedAttempts,
          ],
        );
        if (updated.changes !== 1)
          return fail("REVISION_CONFLICT", "投递恢复并发冲突");
        tx.run(
          "INSERT INTO delivery_recoveries(delivery_id,trace_id,identity_epoch,expected_state,expected_attempts,action,reason,created_at) VALUES(?,?,?,?,?,?,?,?)",
          [
            before.record.id,
            ctx.traceId,
            ctx.actor.identityEpoch,
            input.value.expectedState,
            input.value.expectedAttempts,
            state,
            input.value.reason,
            deps.clock.now(),
          ],
        );
        // Recovery never calls deliver(). The normal S11 dispatcher owns sending and attempt increments.
        deps.events.appendInTx(tx, ctx, {
          type: "delivery.changed",
          aggregateId: before.record.id,
          revision: before.record.attempts,
          payload: {
            deliveryId: before.record.id,
            requestId: before.record.requestId,
            state,
          },
        });
        const {
          lastError: _error,
          nextAttemptAt: _next,
          receipt: _old,
          ...record
        } = current.value.record;
        return ok({ ...record, state, ...(receipt ? { receipt } : {}) });
      });
    },
  };
}
