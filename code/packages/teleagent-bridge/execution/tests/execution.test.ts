import { test } from "node:test";
import assert from "node:assert/strict";
import { createExecutionDriver, type ExecutionWire } from "../index.js";
import {
  ok,
  type ExecutionPort,
  type ExecutionSnapshot,
} from "@campussec/contracts";
import { deferred } from "@campussec/testkit";
import { composedFixture, take } from "../../../../tests/support/composed.js";
test("persisted submission intent blocks duplicate sends and rejects altered frozen profile or channel", async () => {
  let starts = 0,
    input: Parameters<ExecutionPort["start"]>[1];
  const wire: ExecutionWire = {
    start: async (_ctx, value) => {
      starts++;
      input = value;
      return ok({
        runId: value.run.id,
        phase: "running",
        verification: "verified",
        sessionId: "synthetic-session",
        userMessageId: "synthetic-input",
        observedAt: "2026-10-23T01:00:00.000Z",
      });
    },
    inspect: async () => {
      throw new Error("unused");
    },
    abort: async () => {
      throw new Error("unused");
    },
  };
  const f = await composedFixture(wire);
  try {
    take(
      await f.runtime.services.requests.create(
        f.ctx,
        f.request("driver-idempotent"),
      ),
    );
    take(await f.runtime.services.requests.tick(f.system));
    assert.equal(starts, 1);
    const recreated = createExecutionDriver({
      db: f.runtime.storage.db,
      clock: f.clock,
      ids: f.ids,
      wire,
    });
    assert.equal(
      take(await recreated.start(f.system, input!)).phase,
      "running",
    );
    assert.equal(starts, 1);
    const altered = await recreated.start(f.system, {
      ...input!,
      profile: { ...input!.profile, allowedTools: ["unrestricted_shell"] },
    });
    assert.equal(altered.ok, false);
    if (!altered.ok) assert.equal(altered.error.code, "REVISION_CONFLICT");
    assert.equal(starts, 1);
    const channel = await recreated.start(f.system, {
      ...input!,
      channel: { ...input!.channel, runId: f.ids.next() },
    });
    assert.equal(channel.ok, false);
    assert.equal(starts, 1);
  } finally {
    await f.close();
  }
});
test("a hung host observation times out to uncertain; its late response cannot replace the persisted observation", async () => {
  const late =
    deferred<import("@campussec/contracts").Result<ExecutionSnapshot>>();
  let runId = "";
  const wire: ExecutionWire = {
    start: async (_ctx, input) => {
      runId = input.run.id;
      return ok({
        runId,
        phase: "running",
        verification: "verified",
        sessionId: "synthetic-session",
        userMessageId: "synthetic-input",
        observedAt: "2026-10-23T01:00:00.000Z",
      });
    },
    inspect: async () => late.promise,
    abort: async () => {
      throw new Error("unused");
    },
  };
  const f = await composedFixture(wire);
  try {
    take(
      await f.runtime.services.requests.create(f.ctx, f.request("driver-hung")),
    );
    take(await f.runtime.services.requests.tick(f.system));
    const driver = createExecutionDriver({
      db: f.runtime.storage.db,
      clock: f.clock,
      ids: f.ids,
      wire,
      timeoutMs: 5,
    });
    const snapshot = take(await driver.inspect(f.system, runId));
    assert.equal(snapshot.phase, "uncertain");
    late.resolve(
      ok({
        runId,
        phase: "completed",
        verification: "verified",
        sessionId: "synthetic-session",
        userMessageId: "synthetic-input",
        resultMessageId: "synthetic-output",
        observedAt: f.clock.now(),
      }),
    );
    const stored = take(
      await f.runtime.storage.db.read(f.system, (tx) =>
        tx.get<{
          snapshot_json: string;
        }>(
          "SELECT snapshot_json FROM execution_attempts WHERE run_id=? AND operation='inspect'",
          [runId],
        ),
      ),
    );
    assert.equal(JSON.parse(stored!.snapshot_json).phase, "uncertain");
  } finally {
    await f.close();
  }
});
