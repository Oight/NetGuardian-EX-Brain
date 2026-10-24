import { createHash } from "node:crypto";
import {
  canonicalJson,
  fail,
  ok,
  parseDto,
  parseWith,
  callContextSchema,
  idSchema,
  type CallContext,
  type DatabasePort,
  type EventPort,
  type ClockPort,
  type IdPort,
  type HostDeliveryPort,
  type ResultPackageReadPort,
  type DeliveryRecord,
  type DeliveryService,
  type SubscriptionAtomicPort,
  type ResultSubscription,
  type Result,
  type ReadTx,
  type WriteTx,
  type ResultPackage,
  type AppError,
} from "@campussec/contracts";
export interface DeliveryDependencies {
  db: DatabasePort;
  events: EventPort;
  clock: ClockPort;
  ids: IdPort;
  hostDelivery: HostDeliveryPort;
  results: ResultPackageReadPort;
}
interface Row {
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
}
export function createDeliveryService(deps: DeliveryDependencies): {
  service: DeliveryService;
  atomic: SubscriptionAtomicPort;
  recover(ctx: CallContext): Promise<Result<void>>;
} {
  let worker: Promise<Result<number>> | undefined;
  function auth(tx: ReadTx, ctx: CallContext): Result<void> {
    if (
      !parseWith(callContextSchema, ctx).ok ||
      !["ui", "system", "delegation"].includes(ctx.actor.role)
    )
      return fail("FORBIDDEN", "投递入口未授权");
    const meta = tx.get<{
      space_id: string;
      principal_id: string;
      identity_epoch: number;
    }>("SELECT * FROM space_metadata");
    return meta?.space_id === ctx.actor.spaceId &&
      meta.principal_id === ctx.actor.principalId &&
      meta.identity_epoch === ctx.actor.identityEpoch
      ? ok(undefined)
      : fail("IDENTITY_CHANGED", "投递主体已改变");
  }
  function permission(
    tx: ReadTx,
    ctx: CallContext,
    requestId: string,
  ): Result<void> {
    const valid = auth(tx, ctx);
    if (!valid.ok) return valid;
    if (
      ctx.actor.role === "delegation" &&
      (!ctx.actor.originBindingId ||
        !tx.get(
          "SELECT request_id FROM result_subscriptions WHERE request_id=? AND binding_id=? AND state='active'",
          [requestId, ctx.actor.originBindingId],
        ))
    )
      return fail("FORBIDDEN", "结果订阅未授权或已退订");
    return ok(undefined);
  }
  function decode(
    tx: ReadTx,
    ctx: CallContext,
    row: Row,
  ): Result<DeliveryRecord> {
    const result = deps.results.getInTx(tx, ctx, {
      requestId: row.request_id,
      resultVersion: row.result_version,
    });
    if (!result.ok) return result;
    try {
      return parseDto("DeliveryRecord", {
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
    } catch {
      return fail("VALIDATION_FAILED", "投递记录损坏");
    }
  }
  const atomic: SubscriptionAtomicPort = {
    subscribeInTx(tx, ctx, input) {
      const valid = auth(tx, ctx);
      if (!valid.ok) return valid;
      if (
        !["system", "delegation"].includes(ctx.actor.role) ||
        !idSchema.safeParse(input.requestId).success ||
        !idSchema.safeParse(input.bindingId).success ||
        (ctx.actor.role === "delegation" &&
          ctx.actor.originBindingId !== input.bindingId)
      )
        return fail("FORBIDDEN", "不能订阅其他来源");
      const old = tx.get<{
        can_cancel: number;
        state: string;
      }>(
        "SELECT * FROM result_subscriptions WHERE request_id=? AND binding_id=?",
        [input.requestId, input.bindingId],
      );
      if (old)
        return old.state === "active" && !!old.can_cancel === input.canCancel
          ? ok(undefined)
          : fail("CONFLICT", "订阅内容已改变，不能自动恢复已退订来源");
      tx.run(
        "INSERT INTO result_subscriptions(request_id,binding_id,can_cancel,state) VALUES(?,?,?,'active')",
        [input.requestId, input.bindingId, input.canCancel ? 1 : 0],
      );
      return ok(undefined);
    },
    listInTx(tx, ctx, requestId) {
      const valid = permission(tx, ctx, requestId);
      if (!valid.ok) return valid;
      return ok(
        tx
          .all<{
            request_id: string;
            binding_id: string;
            can_cancel: number;
            state: ResultSubscription["state"];
          }>("SELECT * FROM result_subscriptions WHERE request_id=?", [
            requestId,
          ])
          .filter(
            (row) =>
              ctx.actor.role !== "delegation" ||
              row.binding_id === ctx.actor.originBindingId,
          )
          .map((row) => ({
            requestId: row.request_id,
            bindingId: row.binding_id,
            canCancel: !!row.can_cancel,
            state: row.state,
          })),
      );
    },
    withdrawInTx(tx, ctx, input) {
      const valid = permission(tx, ctx, input.requestId);
      if (!valid.ok) return valid;
      if (
        ctx.actor.role !== "system" &&
        (ctx.actor.role !== "delegation" ||
          ctx.actor.originBindingId !== input.bindingId)
      )
        return fail("FORBIDDEN", "不能退订其他来源");
      return tx.run(
        "UPDATE result_subscriptions SET state='withdrawn' WHERE request_id=? AND binding_id=?",
        [input.requestId, input.bindingId],
      ).changes
        ? ok(undefined)
        : fail("NOT_FOUND", "订阅不存在");
    },
  };
  function changed(
    tx: WriteTx,
    ctx: CallContext,
    row: Row,
    state: Row["state"],
    error?: AppError,
    receipt?: DeliveryRecord["receipt"],
  ) {
    tx.run(
      "UPDATE result_deliveries SET state=?,receipt_json=?,last_error_json=?,next_attempt_at=? WHERE id=?",
      [
        state,
        receipt ? canonicalJson(receipt) : row.receipt_json,
        error ? canonicalJson(error) : null,
        ["uncertain", "retryable_failed"].includes(state) ||
        (state === "pending" && row.attempts > 0)
          ? new Date(
              Date.parse(deps.clock.now()) +
                [5000, 15000, 60000][
                  Math.min(2, Math.max(0, row.attempts - 1))
                ]!,
            ).toISOString()
          : null,
        row.id,
      ],
    );
    deps.events.appendInTx(tx, ctx, {
      type: "delivery.changed",
      aggregateId: row.id,
      revision: row.attempts + 1,
      payload: { deliveryId: row.id, requestId: row.request_id, state },
    });
  }
  async function tick(ctx: CallContext): Promise<Result<number>> {
    if (ctx.actor.role !== "system")
      return fail("FORBIDDEN", "投递 worker 仅限系统调用");
    const caller = ctx;
    const picked = await deps.db.write(caller, (tx) => {
      const valid = auth(tx, caller);
      if (!valid.ok) return valid;
      const row = tx.get<Row>(
        "SELECT * FROM result_deliveries WHERE state IN ('pending','retryable_failed','uncertain','sending') AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY rowid LIMIT 1",
        [deps.clock.now()],
      );
      if (!row) return ok(undefined);
      if (
        !tx.get(
          "SELECT request_id FROM result_subscriptions WHERE request_id=? AND binding_id=? AND state='active'",
          [row.request_id, row.binding_id],
        )
      ) {
        changed(tx, caller, row, "blocked", {
          code: "FORBIDDEN",
          message: "来源已退订",
          retryable: false,
        });
        return ok(undefined);
      }
      const value = decode(tx, caller, row);
      if (!value.ok) return value;
      if (row.state === "sending") {
        changed(tx, caller, row, "uncertain");
        row.state = "uncertain";
      }
      if (!["uncertain"].includes(row.state)) {
        if (row.attempts >= 3) {
          changed(tx, caller, row, "blocked");
          return ok(undefined);
        }
        tx.run(
          "UPDATE result_deliveries SET state='sending',attempts=attempts+1,next_attempt_at=? WHERE id=?",
          [
            new Date(Date.parse(deps.clock.now()) + 60000).toISOString(),
            row.id,
          ],
        );
        row.attempts++;
        row.state = "sending";
      }
      return ok({ row, result: value.value.result });
    });
    if (!picked.ok) return picked;
    if (!picked.value) return ok(0);
    const { row, result } = picked.value;
    const binding = await deps.hostDelivery.binding(caller, row.binding_id);
    const active =
      binding.ok &&
      binding.value.state === "active" &&
      binding.value.spaceId === caller.actor.spaceId &&
      binding.value.principalId === caller.actor.principalId &&
      binding.value.expiresAt > deps.clock.now();
    if (!active)
      return deps.db.write(caller, (tx) => {
        changed(
          tx,
          caller,
          row,
          "blocked",
          binding.ok
            ? { code: "FORBIDDEN", message: "来源绑定失效", retryable: false }
            : binding.error,
        );
        return ok(0);
      });
    const admitted = await deps.db.read(
      caller,
      (tx) =>
        !!tx.get(
          "SELECT request_id FROM result_subscriptions WHERE request_id=? AND binding_id=? AND state='active'",
          [row.request_id, row.binding_id],
        ),
    );
    if (!admitted.ok) return admitted;
    if (!admitted.value)
      return deps.db.write(caller, (tx) => {
        changed(tx, caller, row, "blocked", {
          code: "FORBIDDEN",
          message: "发送前来源已退订",
          retryable: false,
        });
        return ok(0);
      });
    let next: Row["state"] = "uncertain",
      receipt: DeliveryRecord["receipt"],
      error: AppError | undefined;
    try {
      if (row.state === "uncertain") {
        const check = await deps.hostDelivery.reconcileDelivery(caller, {
          binding: binding.value,
          deliveryKey: row.delivery_key,
        });
        if (
          check.ok &&
          check.value.state === "found" &&
          check.value.receipt?.visible &&
          check.value.receipt.messageId
        ) {
          const parsed = parseDto("HostReceipt", check.value.receipt);
          if (parsed.ok) {
            next = "delivered";
            receipt = parsed.value;
          }
        } else if (check.ok && check.value.state === "absent")
          next = row.attempts < 3 ? "pending" : "blocked";
        else {
          next = "blocked";
          error = check.ok
            ? {
                code: "UNCERTAIN",
                message:
                  "宿主无法核实前次投递，停止自动发送；可在客户端取回结果",
                retryable: false,
              }
            : check.error;
        }
      } else {
        const sent = await deps.hostDelivery.deliver(caller, {
          binding: binding.value,
          deliveryKey: row.delivery_key,
          message: {
            kind: "external_investigation_result",
            mediaType: "application/json",
            text: canonicalJson(result),
          },
        });
        if (sent.ok) {
          const parsed = parseDto("HostReceipt", sent.value);
          if (parsed.ok) {
            receipt = parsed.value;
            if (receipt.visible && receipt.messageId) next = "delivered";
          }
        } else {
          error = sent.error;
          if (
            [
              "FORBIDDEN",
              "UPSTREAM_AUTH",
              "UPSTREAM_DENIED",
              "IDENTITY_CHANGED",
            ].includes(error.code)
          )
            next = "blocked";
        }
      }
    } catch {
      error = {
        code: "UNCERTAIN",
        message: "投递响应未核实，禁止盲目重发",
        retryable: false,
      };
    }
    return deps.db.write(caller, (tx) => {
      const current = tx.get<Row>(
        "SELECT * FROM result_deliveries WHERE id=?",
        [row.id],
      );
      if (!current) return fail("NOT_FOUND", "投递记录不存在");
      if (current.state === "delivered") return ok(0);
      changed(tx, caller, current, next, error, receipt);
      return ok(next === "delivered" ? 1 : 0);
    });
  }
  const service: DeliveryService = {
    enqueueInTx(tx, ctx, input) {
      const valid = permission(tx, ctx, input.result.requestId);
      if (!valid.ok) return valid;
      if (ctx.actor.role !== "system")
        return fail("FORBIDDEN", "仅协调者可以排队结果");
      const parsed = parseDto("ResultPackage", input.result);
      if (!parsed.ok) return parsed;
      const stored = deps.results.getInTx(tx, ctx, {
        requestId: input.result.requestId,
        resultVersion: input.result.resultVersion,
      });
      if (!stored.ok) return stored;
      if (canonicalJson(stored.value) !== canonicalJson(parsed.value))
        return fail("CONFLICT", "投递内容不是已保存的结果版本");
      if (
        !tx.get(
          "SELECT request_id FROM result_subscriptions WHERE request_id=? AND binding_id=? AND state='active'",
          [input.result.requestId, input.bindingId],
        )
      )
        return fail("FORBIDDEN", "来源未订阅该结果");
      const key = createHash("sha256")
        .update(
          canonicalJson([
            ctx.actor.spaceId,
            input.bindingId,
            parsed.value.requestId,
            parsed.value.runId ?? "unstarted",
            parsed.value.resultVersion,
          ]),
        )
        .digest("hex");
      const old = tx.get<Row>(
        "SELECT * FROM result_deliveries WHERE delivery_key=?",
        [key],
      );
      if (old) return decode(tx, ctx, old);
      const id = deps.ids.next();
      tx.run(
        "INSERT INTO result_deliveries(id,binding_id,request_id,run_id,result_version,delivery_key,state,attempts) VALUES(?,?,?,?,?,?,'pending',0)",
        [
          id,
          input.bindingId,
          parsed.value.requestId,
          parsed.value.runId ?? null,
          parsed.value.resultVersion,
          key,
        ],
      );
      return decode(
        tx,
        ctx,
        tx.get<Row>("SELECT * FROM result_deliveries WHERE id=?", [id])!,
      );
    },
    async tick(ctx) {
      if (ctx.actor.role !== "system")
        return fail("FORBIDDEN", "投递 worker 仅限系统调用");
      if (worker) return worker;
      worker = tick(ctx);
      try {
        return await worker;
      } finally {
        worker = undefined;
      }
    },
    async status(ctx, requestId) {
      const read = await deps.db.read(ctx, (tx) => {
        const valid = permission(tx, ctx, requestId);
        if (!valid.ok) return valid;
        const result = deps.results.getInTx(tx, ctx, { requestId });
        if (!result.ok) return result;
        const records: DeliveryRecord[] = [];
        for (const row of tx.all<Row>(
          "SELECT * FROM result_deliveries WHERE request_id=?" +
            (ctx.actor.role === "delegation" ? " AND binding_id=?" : "") +
            " ORDER BY result_version,id",
          ctx.actor.role === "delegation"
            ? [requestId, ctx.actor.originBindingId!]
            : [requestId],
        )) {
          const decoded = decode(tx, ctx, row);
          if (!decoded.ok) return decoded;
          records.push(decoded.value);
        }
        return ok(records);
      });
      return read.ok ? read.value : read;
    },
    async getResult(ctx, input) {
      const read = await deps.db.read(ctx, (tx) => {
        const valid = permission(tx, ctx, input.requestId);
        return valid.ok ? deps.results.getInTx(tx, ctx, input) : valid;
      });
      return read.ok ? read.value : read;
    },
  };
  return {
    service,
    atomic,
    async recover(ctx) {
      if (ctx.actor.role !== "system")
        return fail("FORBIDDEN", "投递恢复仅允许系统调用");
      return deps.db.write(ctx, (tx) => {
        for (const row of tx.all<Row>(
          "SELECT * FROM result_deliveries WHERE state='sending'",
        )) {
          changed(tx, ctx, row, "uncertain");
          tx.run("UPDATE result_deliveries SET next_attempt_at=? WHERE id=?", [
            deps.clock.now(),
            row.id,
          ]);
        }
        return ok(undefined);
      });
    },
  };
}
