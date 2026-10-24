import { test } from "node:test";
import assert from "node:assert/strict";
import { fail, ok, type ReadTx, type Result } from "@campussec/contracts";
import {
  CASE,
  context,
  foundationSamples,
  SqlScript,
  createScriptedDatabase,
  createScriptedPlatformQuery,
  createScriptedConnectionRead,
  createScriptedNotification,
  createScriptedRequestAtomic,
  createScriptedDelivery,
  SyncScriptedPort,
  deferred,
  FakeClock,
  createScriptedSecrets,
} from "@campussec/testkit";

test("scripted database checks SQL ordering/parameters, closes handles and never claims persistence", async () => {
  const db = createScriptedDatabase();
  db.read(
    new SqlScript().expectGet("SELECT id FROM synthetic WHERE id=?", [CASE], {
      id: CASE,
    }),
  );
  let leaked: ReadTx | undefined;
  const result = await db.port.read(context(), (tx) => {
    leaked = tx;
    return tx.get<{ id: string }>("SELECT id FROM synthetic WHERE id=?", [
      CASE,
    ]);
  });
  assert.ok(result.ok);
  assert.equal(result.value?.id, CASE);
  assert.equal(db.calls[0]?.outcome, "read");
  assert.throws(() => leaked!.all("SELECT id FROM synthetic"), /Expired/);
  db.write(new SqlScript().expectRun("UPDATE synthetic SET value=?", [1], 1));
  const denied = await db.port.write(context(), (tx) => {
    tx.run("UPDATE synthetic SET value=?", [1]);
    return fail("BUDGET_EXHAUSTED", "合成拒绝");
  });
  assert.equal(denied.ok, false);
  assert.equal(db.calls[1]?.outcome, "rolled_back");
  db.write(new SqlScript());
  assert.equal((await db.port.write(context(), () => ok("explicit"))).ok, true);
  assert.equal(db.calls[2]?.outcome, "committed");
  db.read(new SqlScript().expectGet("SELECT 1", [], { value: 1 }));
  await assert.rejects(
    () => db.port.read(context(), (tx) => tx.get("SELECT 2")),
    /mismatch/,
  );
  await assert.rejects(() => db.port.read(context(), () => 1), /Unscripted/);
});
test("scripted transactions reject async callbacks and async atomic fake handlers", async () => {
  const db = createScriptedDatabase();
  db.read(new SqlScript());
  assert.equal((await db.port.read(context(), async () => 1)).ok, false);
  const atomic = new SyncScriptedPort<number, number>();
  // @ts-expect-error Bad third-party test script must not permit awaiting inside InTx.
  atomic.push(async () => ok(1));
  assert.throws(() => atomic.invoke(1), /synchronous/);
  assert.equal(atomic.pending(), 0);
});
test("B query/read/notification fakes preserve partial, denied and missing-script failures", async () => {
  const data = foundationSamples();
  const query = createScriptedPlatformQuery();
  const read = createScriptedConnectionRead();
  const notification = createScriptedNotification();
  let attempts = 0;
  const input = {
    kind: "alerts" as const,
    scope: data.caseRecord.scope,
    filter: {},
    page: { limit: 10 },
    fixedUpper: data.coverage.retrievedAt,
  };
  const call = {
    signal: new AbortController().signal,
    beforeAttempt: async () => {
      attempts++;
      return ok(undefined);
    },
  };
  query.query.push(async ({ call: supplied }) => {
    assert.equal(supplied, call);
    await supplied.beforeAttempt();
    return ok(data.page);
  });
  const partial = await query.port.query(context(), input, call);
  assert.ok(partial.ok);
  assert.equal(partial.value.status, "partial");
  assert.equal(partial.value.coverage.collectionCoverage, "unknown");
  assert.equal(attempts, 1);
  query.query.push(async () => fail("UPSTREAM_DENIED", "合成403"));
  assert.equal((await query.port.query(context(), input, call)).ok, false);
  read.list.push(async () => ok([data.connection]));
  assert.ok((await read.port.list(context())).ok);
  read.capabilities.push(async () =>
    ok([
      {
        name: "alerts",
        state: "denied",
        checkedAt: data.coverage.retrievedAt,
        evidence: "synthetic403",
        endpointKind: "indexer",
      },
    ]),
  );
  const caps = await read.port.capabilities(
    context(),
    data.connection.id,
    true,
  );
  assert.ok(caps.ok);
  assert.equal(caps.value[0]?.state, "denied");
  read.agents.push(async () =>
    ok({ items: [{ id: "001" }], nextCursor: "synthetic-next-page" }),
  );
  assert.ok(
    (
      await read.port.agents(context(), {
        connectionId: data.connection.id,
        page: { limit: 1 },
      })
    ).ok,
  );
  notification.show.push(async () => fail("HOST_UNAVAILABLE", "合成通知失败"));
  assert.equal(
    (
      await notification.port.show({
        notificationId: CASE,
        title: "合成提醒",
        body: "权限不足仍保留提醒",
        alertIds: [CASE],
      })
    ).ok,
    false,
  );
  await assert.rejects(
    () =>
      notification.port.show({
        notificationId: CASE,
        title: "no default",
        body: "",
        alertIds: [],
      }),
    /Unscripted/,
  );
});
test("atomic request fake preserves tx identity and scripts rejection/revocation synchronously", async () => {
  const data = foundationSamples();
  const db = createScriptedDatabase();
  const requests = createScriptedRequestAtomic();
  db.write(new SqlScript());
  requests.createAutoInTx.push(({ input, tx }) => {
    assert.equal(input.policyEpoch, 1);
    assert.equal(typeof tx.run, "function");
    return fail("QUEUE_FULL", "合成队列已满");
  });
  const result = await db.port.write(context(), (tx) =>
    requests.port.createAutoInTx(tx, context(), data.autoCandidate),
  );
  assert.equal(result.ok, false);
  assert.equal(db.calls[0]?.outcome, "rolled_back");
  db.write(new SqlScript());
  requests.cancelPolicyInTx.push(({ input }) => {
    assert.equal(input.obsoleteEpoch, 1);
    return ok({ revokeRunIds: [CASE] });
  });
  const cancelled = await db.port.write(context(), (tx) =>
    requests.port.cancelPolicyInTx(tx, context(), {
      policyId: CASE,
      obsoleteEpoch: 1,
    }),
  );
  assert.ok(cancelled.ok);
  assert.deepEqual(cancelled.value.revokeRunIds, [CASE]);
});
test("delivery fake models remote effect, lost reply, reconcile and expired binding without duplicates", async () => {
  const data = foundationSamples();
  const delivery = createScriptedDelivery();
  let effects = 0;
  delivery.binding.push(async () => ok({ ...data.binding, state: "expired" }));
  const binding = await delivery.port.binding(context(), CASE);
  assert.ok(binding.ok);
  assert.equal(binding.value.state, "expired");
  delivery.deliver.push(async () => {
    effects++;
    return fail("UNCERTAIN", "合成已发送但回执丢失");
  });
  const input: Parameters<typeof delivery.port.deliver>[1] = {
    binding: data.binding,
    deliveryKey: "synthetic-idempotency-key",
    message: {
      kind: "external_investigation_result",
      mediaType: "application/json",
      text: JSON.stringify(data.result),
    },
  };
  assert.equal((await delivery.port.deliver(context(), input)).ok, false);
  delivery.reconcile.push(async () =>
    ok({
      state: "found",
      receipt: {
        messageId: "synthetic-message",
        visible: true,
        observedAt: data.coverage.retrievedAt,
      },
    }),
  );
  const reconciled = await delivery.port.reconcileDelivery(context(), {
    binding: data.binding,
    deliveryKey: input.deliveryKey,
  });
  assert.ok(reconciled.ok);
  assert.equal(reconciled.value.state, "found");
  assert.equal(effects, 1);
});
test("deferred response allows cancellation followed by a late versioned result", async () => {
  const query = createScriptedPlatformQuery();
  const data = foundationSamples();
  const late = deferred<Result<typeof data.page>>();
  const controller = new AbortController();
  query.query.push(async ({ call }) => {
    assert.equal(call.signal, controller.signal);
    return late.promise;
  });
  const pending = query.port.query(
    context(),
    {
      kind: "alerts",
      scope: data.caseRecord.scope,
      filter: {},
      page: { limit: 1 },
      fixedUpper: data.coverage.retrievedAt,
    },
    { signal: controller.signal, beforeAttempt: async () => ok(undefined) },
  );
  controller.abort();
  late.resolve(ok({ ...data.page, pageOrdinal: 1 }));
  const result = await pending;
  assert.ok(result.ok);
  assert.equal(result.value.pageOrdinal, 1);
  assert.equal(controller.signal.aborted, true);
  const clock = new FakeClock();
  const start = clock.monotonicMs();
  clock.advance(1000);
  assert.equal(clock.monotonicMs() - start, 1000);
  assert.throws(() => clock.advance(-1));
});

test("connection generations and identity epochs remain observable to the consumer", async () => {
  const read = createScriptedConnectionRead();
  const data = foundationSamples();
  read.list.push(async (ctx) => {
    assert.equal(ctx.actor.identityEpoch, 1);
    return ok([data.connection]);
  });
  read.list.push(async (ctx) => {
    assert.equal(ctx.actor.identityEpoch, 2);
    return ok([{ ...data.connection, generation: 2 }]);
  });
  const first = await read.port.list(context());
  const changed = context();
  changed.actor.identityEpoch = 2;
  const second = await read.port.list(changed);
  assert.ok(first.ok && second.ok);
  assert.notEqual(first.value[0]?.generation, second.value[0]?.generation);
  assert.equal(read.list.calls[1]?.actor.identityEpoch, 2);
});

test("C secret fake denies unscripted access, zeroes temporary bytes and preserves explicit failures", async () => {
  const secrets = createScriptedSecrets();
  await assert.rejects(
    () => secrets.port.use(CASE, "synthetic", async () => 1),
    /Unscripted/,
  );
  secrets.read.push(async () => fail("FORBIDDEN", "合成用途不匹配"));
  let invoked = false;
  assert.equal(
    (
      await secrets.port.use(CASE, "synthetic", async () => {
        invoked = true;
        return 1;
      })
    ).ok,
    false,
  );
  assert.equal(invoked, false);
  const template = new TextEncoder().encode("synthetic-only");
  secrets.put.push(async () => ok(CASE));
  assert.ok(
    (
      await secrets.port.put({
        owner: CASE,
        purpose: "synthetic",
        value: template,
        persist: false,
      })
    ).ok,
  );
  secrets.read.push(async () => ok(template));
  let borrowed: Uint8Array | undefined;
  const result = await secrets.port.use(CASE, "synthetic", async (bytes) => {
    borrowed = bytes;
    return new TextDecoder().decode(bytes);
  });
  assert.ok(result.ok);
  assert.equal(result.value, "synthetic-only");
  assert.ok(borrowed!.every((byte) => byte === 0));
  assert.ok(template.some((byte) => byte !== 0));
  secrets.remove.push(async () => ok(undefined));
  assert.ok((await secrets.port.remove(CASE)).ok);
});
