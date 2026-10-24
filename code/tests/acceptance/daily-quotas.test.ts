import { test } from "node:test";
import assert from "node:assert/strict";
import { ok, canonicalJson, type TriggerPolicy } from "@campussec/contracts";
import { composedFixture, take } from "../support/composed.js";
test("daily automatic attempts persist across failure and reopen and are never refunded; next attempt is denied", async () => {
  const f = await composedFixture();
  try {
    const first = take(
        await f.runtime.services.requests.create(
          f.ctx,
          f.request("auto-quota-1"),
        ),
      ),
      policyId = f.ids.next();
    const policy: TriggerPolicy = {
      id: policyId,
      connectionId: first.request.connectionId,
      revision: 1,
      epoch: 1,
      enabled: true,
      agentIds: ["001"],
      filter: {},
      enabledAfterReceiveSeq: 0,
      dailyAttemptLimit: 1,
      timeZone: "Asia/Shanghai",
    };
    take(
      await f.runtime.storage.db.write(f.system, (tx) => {
        tx.run(
          "INSERT INTO trigger_policies(id,connection_id,revision,epoch,enabled,enabled_after_receive_seq,policy_json) VALUES(?,?,1,1,1,0,?)",
          [policyId, first.request.connectionId, canonicalJson(policy)],
        );
        tx.run(
          "UPDATE jobs SET origin='alert_auto',policy_id=?,policy_epoch=1 WHERE id=?",
          [policyId, first.job!.id],
        );
        tx.run(
          "UPDATE investigation_requests SET origin='alert_auto' WHERE id=?",
          [first.request.id],
        );
        return ok(undefined);
      }),
    );
    take(await f.runtime.services.requests.tick(f.system));
    assert.equal(
      take(await f.runtime.services.requests.status(f.ctx, first.request.id))
        .job?.state,
      "failed",
    );
    const count = async () =>
      take(
        await f.runtime.storage.db.read(
          f.system,
          (tx) =>
            tx.get<{
              n: number;
            }>(
              "SELECT COUNT(*) AS n FROM quota_ledger WHERE kind='automatic_attempt'",
            )!.n,
        ),
      );
    assert.equal(await count(), 1);
    await f.reopen();
    assert.equal(await count(), 1);
    const second = take(
      await f.runtime.services.requests.create(
        f.ctx,
        f.request("auto-quota-2"),
      ),
    );
    take(
      await f.runtime.storage.db.write(f.system, (tx) => {
        tx.run(
          "UPDATE jobs SET origin='alert_auto',policy_id=?,policy_epoch=1 WHERE id=?",
          [policyId, second.job!.id],
        );
        tx.run(
          "UPDATE investigation_requests SET origin='alert_auto' WHERE id=?",
          [second.request.id],
        );
        return ok(undefined);
      }),
    );
    const denied = await f.runtime.services.requests.tick(f.system);
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, "BUDGET_EXHAUSTED");
    assert.equal(await count(), 1);
    const status = take(
      await f.runtime.services.requests.status(f.ctx, second.request.id),
    );
    assert.equal(status.job?.state, "failed");
    assert.equal(status.job?.runId, undefined);
  } finally {
    await f.close();
  }
});
test("unknown usage is persisted as unknown and configured token threshold pauses subsequent dispatch", async () => {
  const f = await composedFixture();
  try {
    await f.invoke("runtime.configure", {
      expectedRevision: 1,
      settings: {
        trayEnabled: false,
        budgetTimeZone: "Asia/Shanghai",
        dailyTotalTokenLimit: 100,
      },
    });
    const a = take(
      await f.runtime.services.requests.create(
        f.ctx,
        f.request("unknown-usage"),
      ),
    );
    take(await f.runtime.services.requests.tick(f.system));
    assert.equal(
      take(await f.runtime.services.requests.status(f.ctx, a.request.id)).job
        ?.state,
      "failed",
    );
    const usage = take(
      await f.runtime.storage.db.read(f.system, (tx) =>
        tx.get<{
          usage_json: string;
        }>("SELECT usage_json FROM quota_ledger WHERE kind='token_usage'"),
      ),
    );
    assert.ok(usage);
    assert.equal(JSON.parse(usage.usage_json).known, false);
    const b = take(
      await f.runtime.services.requests.create(f.ctx, f.request("pause-usage")),
    );
    const paused = await f.runtime.services.requests.tick(f.system);
    assert.equal(paused.ok, false);
    if (!paused.ok) assert.equal(paused.error.code, "BUDGET_EXHAUSTED");
    assert.equal(
      take(await f.runtime.services.requests.status(f.ctx, b.request.id)).job
        ?.runId,
      undefined,
    );
  } finally {
    await f.close();
  }
});
