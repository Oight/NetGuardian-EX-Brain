import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fail,
  ok,
  type HostDeliveryPort,
  type OriginBinding,
  type Result,
} from "@campussec/contracts";
import { context, PRINCIPAL, SPACE } from "@campussec/testkit";
import { createDeliveryRecovery } from "@campussec/core/delivery/recovery";
import { setup, take, error, system } from "../../reports/tests/fixtures.js";

async function fixture() {
  const f = await setup();
  const sealed = await f.seal();
  const result = take(
    await f.db.write(system(), (tx) =>
      f.service.finalizeInTx(tx, system(), {
        run: f.run,
        context: f.resultContext,
        decision: { terminalState: "failed", reason: "没有草案" },
        manifestHash: sealed.manifestHash,
        assessment: take(f.service.assessInTx(tx, system(), f.run.id)),
      }),
    ),
  );
  const binding: OriginBinding = {
    id: f.ids.next(),
    spaceId: SPACE,
    principalId: PRINCIPAL,
    hostId: f.ids.next(),
    hostAccountId: f.ids.next(),
    workspaceId: f.ids.next(),
    sessionId: "source-session",
    requestMessageId: "source-message",
    state: "active",
    createdAt: f.clock.now(),
    expiresAt: f.run.expiresAt,
  };
  const deliveryId = f.ids.next();
  take(
    await f.db.write(context(), (tx) => {
      tx.run(
        "INSERT INTO origin_bindings(id,principal_id,host_id,host_account_id,workspace_id,session_id,request_message_id,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [
          binding.id,
          PRINCIPAL,
          binding.hostId,
          binding.hostAccountId,
          binding.workspaceId,
          binding.sessionId,
          binding.requestMessageId,
          binding.state,
          binding.createdAt,
          binding.expiresAt,
        ],
      );
      tx.run(
        "INSERT INTO result_subscriptions(request_id,binding_id,can_cancel,state) VALUES(?,?,0,'active')",
        [f.requestId, binding.id],
      );
      tx.run(
        "INSERT INTO result_deliveries(id,binding_id,request_id,run_id,result_version,delivery_key,state,attempts) VALUES(?,?,?,?,?,?,'blocked',3)",
        [
          deliveryId,
          binding.id,
          f.requestId,
          f.run.id,
          result.resultVersion,
          "a".repeat(64),
        ],
      );
      return ok(undefined);
    }),
  );
  let reconcile: () => Promise<
    Result<{
      state: "found" | "absent" | "unknown";
      receipt?: { messageId: string; visible: boolean; observedAt: string };
    }>
  > = async () => ok({ state: "unknown" });
  let safe = false,
    sends = 0,
    checks = 0;
  const host: HostDeliveryPort = {
    binding: async () => ok(binding),
    deliver: async () => {
      sends++;
      return fail("HOST_UNAVAILABLE", "unused");
    },
    reconcileDelivery: async () => {
      checks++;
      return reconcile();
    },
  };
  const recovery = createDeliveryRecovery({
    ...f,
    host,
    results: f.reader,
    retrySafety: { canRetryAbsent: async () => ok(safe) },
  });
  const input = {
    deliveryId,
    expectedState: "blocked" as const,
    expectedAttempts: 3,
    reason: "来源方核实后恢复",
  };
  return {
    ...f,
    binding,
    deliveryId,
    input,
    recovery,
    host,
    setReconcile: (work: typeof reconcile) => {
      reconcile = work;
    },
    setSafe: (value: boolean) => {
      safe = value;
    },
    stats: () => ({ sends, checks }),
    state: async () =>
      take(
        await f.db.read(context(), (tx) =>
          tx.get<{ state: string; attempts: number }>(
            "SELECT state,attempts FROM result_deliveries WHERE id=?",
            [deliveryId],
          )!,
        ),
      ),
  };
}

test("delivery recovery retains blocked on unknown/unsafe absence, then atomically audits a trusted safe retry without sending", async () => {
  const f = await fixture();
  try {
    error(await f.recovery.recover(context(), f.input), "UNCERTAIN");
    f.setReconcile(async () => ok({ state: "absent" }));
    error(await f.recovery.recover(context(), f.input), "UNCERTAIN");
    assert.deepEqual(
      { ...(await f.state()) },
      { state: "blocked", attempts: 3 },
    );
    assert.equal(await f.count("delivery_recoveries"), 0);
    f.setSafe(true);
    const recovered = take(await f.recovery.recover(context(), f.input));
    assert.equal(recovered.state, "pending");
    assert.equal(recovered.attempts, 3);
    assert.equal(await f.count("delivery_recoveries"), 1);
    assert.equal(f.stats().sends, 0);
    error(await f.recovery.recover(context(), f.input), "REVISION_CONFLICT");
  } finally {
    await f.dispose();
  }
});
test("a visible reconciled receipt records delivery instead of resending; malformed/invisible receipts fail closed", async () => {
  const f = await fixture();
  try {
    f.setReconcile(async () => ok({ state: "found" }));
    error(await f.recovery.recover(context(), f.input), "INVALID_INPUT");
    f.setReconcile(async () =>
      ok({
        state: "found",
        receipt: {
          messageId: "original",
          visible: false,
          observedAt: f.clock.now(),
        },
      }),
    );
    error(await f.recovery.recover(context(), f.input), "UNCERTAIN");
    f.setReconcile(async () =>
      ok({
        state: "found",
        receipt: {
          messageId: "original",
          visible: true,
          observedAt: f.clock.now(),
        },
      }),
    );
    assert.equal(
      take(await f.recovery.recover(context(), f.input)).state,
      "delivered",
    );
    assert.equal(f.stats().sends, 0);
  } finally {
    await f.dispose();
  }
});
test("recovery rechecks subscriptions and CAS after host I/O; rollback leaves no audit or pending state", async () => {
  const f = await fixture();
  try {
    error(await f.recovery.recover(system(), f.input), "FORBIDDEN");
    error(
      await f.recovery.recover(context(), { ...f.input, expectedAttempts: 2 }),
      "REVISION_CONFLICT",
    );
    f.setSafe(true);
    f.setReconcile(async () => {
      take(
        await f.db.write(context(), (tx) => {
          tx.run(
            "UPDATE result_subscriptions SET state='withdrawn' WHERE request_id=?",
            [f.requestId],
          );
          return ok(undefined);
        }),
      );
      return ok({ state: "absent" });
    });
    error(await f.recovery.recover(context(), f.input), "FORBIDDEN");
    assert.deepEqual(
      { ...(await f.state()) },
      { state: "blocked", attempts: 3 },
    );
    assert.equal(await f.count("delivery_recoveries"), 0);
  } finally {
    await f.dispose();
  }
});
test("a changed trusted origin or concurrent delivery state cannot be redirected or overwritten", async () => {
  const f = await fixture();
  try {
    f.host.binding = async () => ok({ ...f.binding, sessionId: "different" });
    error(await f.recovery.recover(context(), f.input), "FORBIDDEN");
    assert.equal(f.stats().checks, 0);
    f.host.binding = async () => ok(f.binding);
    f.setSafe(true);
    f.setReconcile(async () => {
      take(
        await f.db.write(context(), (tx) => {
          tx.run("UPDATE result_deliveries SET state='uncertain' WHERE id=?", [
            f.deliveryId,
          ]);
          return ok(undefined);
        }),
      );
      return ok({ state: "absent" });
    });
    error(await f.recovery.recover(context(), f.input), "REVISION_CONFLICT");
    assert.equal((await f.state()).state, "uncertain");
    assert.equal(f.stats().sends, 0);
  } finally {
    await f.dispose();
  }
});

test("a malformed truthy retry guarantee cannot authorize a resend", async () => {
  const f = await fixture();
  try {
    f.setReconcile(async () => ok({ state: "absent" }));
    f.setSafe("true" as unknown as boolean);
    error(await f.recovery.recover(context(), f.input), "UNCERTAIN");
    assert.deepEqual(
      { ...(await f.state()) },
      { state: "blocked", attempts: 3 },
    );
    assert.equal(await f.count("delivery_recoveries"), 0);
    assert.equal(f.stats().sends, 0);
  } finally {
    await f.dispose();
  }
});
