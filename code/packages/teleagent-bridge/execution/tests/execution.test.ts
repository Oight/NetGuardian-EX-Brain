import { test } from "node:test";
import assert from "node:assert/strict";
import { createExecutionDriver, type ExecutionWire } from "../index.js";
import {
  fail,
  ok,
  type ExecutionPort,
  type ExecutionSnapshot,
} from "@campussec/contracts";
import { deferred } from "@campussec/testkit";
import { composedFixture, take } from "../../../../tests/support/composed.js";
test("an unavailable pinned backend produces an actual failed result, not success or an uncertain model submission", async () => {
  const f = await composedFixture(undefined, undefined, {
    teleagent: {
      binaryPath: process.cwd() + "/missing-teleagent-test-only.exe",
      model: {
        baseUrl: "http://127.0.0.1:1/v1",
        modelId: "synthetic",
        apiKey: "synthetic",
      },
      review: {
        baseUrl: "http://127.0.0.1:1/review",
        accessKey: "synthetic",
        secretKey: "synthetic",
      },
    },
  });
  try {
    const request = take(
      await f.runtime.services.requests.create(
        f.ctx,
        f.request("missing-owned-backend"),
      ),
    );
    take(await f.runtime.services.requests.tick(f.system));
    assert.equal(
      take(await f.runtime.services.requests.status(f.ctx, request.request.id))
        .job?.state,
      "failed",
    );
    const row = take(
      await f.runtime.storage.db.read(f.system, (tx) =>
        tx.get<{ snapshot_json: string }>(
          "SELECT snapshot_json FROM execution_attempts WHERE operation='start'",
        ),
      ),
    );
    assert.equal(JSON.parse(row!.snapshot_json).phase, "not_submitted");
    assert.equal(JSON.parse(row!.snapshot_json).userMessageId, undefined);
    assert.equal(f.network(), 0);
  } finally {
    await f.close();
  }
});
test("a connection generation change fences the session checkpoint before any model submission", async () => {
  let f: Awaited<ReturnType<typeof composedFixture>>;
  const wire: ExecutionWire = {
    async start(_ctx, input, control) {
      take(
        await f.runtime.storage.db.write(f.system, (tx) => {
          tx.run("UPDATE connections SET generation=generation+1 WHERE id=?", [
            input.run.scope.connectionId,
          ]);
          return ok(undefined);
        }),
      );
      const checked = await control!.checkpoint({
        runId: input.run.id,
        sessionId: "ses_not_submitted",
        phase: "not_submitted",
        verification: "verified",
        observedAt: f.clock.now(),
      });
      assert.equal(checked.ok, false);
      if (!checked.ok) assert.equal(checked.error.code, "IDENTITY_CHANGED");
      return ok({
        runId: input.run.id,
        phase: "not_submitted",
        verification: "verified",
        observedAt: f.clock.now(),
        error: {
          code: "IDENTITY_CHANGED",
          message: "synthetic generation change",
          retryable: false,
        },
      });
    },
    inspect: async () => fail("NOT_FOUND", "no submission"),
    abort: async () => fail("NOT_FOUND", "no submission"),
  };
  f = await composedFixture(wire);
  try {
    const request = take(
      await f.runtime.services.requests.create(
        f.ctx,
        f.request("checkpoint-generation"),
      ),
    );
    take(await f.runtime.services.requests.tick(f.system));
    assert.equal(
      take(await f.runtime.services.requests.status(f.ctx, request.request.id))
        .job?.state,
      "failed",
    );
  } finally {
    await f.close();
  }
});
test("a created session is checkpointed before submission and survives a lost response without a second start", async () => {
  let runId = "",
    starts = 0;
  let captured: Parameters<ExecutionPort["start"]>[1];
  const wire: ExecutionWire = {
    async start(_ctx, input, control) {
      starts++;
      runId = input.run.id;
      captured = input;
      assert.ok(control);
      take(
        await control.checkpoint({
          runId,
          sessionId: "ses_checkpoint",
          phase: "not_submitted",
          verification: "verified",
          observedAt: "2026-10-23T01:00:00.000Z",
        }),
      );
      throw Error("synthetic lost submission response");
    },
    async inspect(_ctx, id, known) {
      assert.equal(known.sessionId, "ses_checkpoint");
      return ok({
        ...known,
        runId: id,
        phase: "uncertain",
        verification: "unverified",
      });
    },
    abort: async () => fail("UNCERTAIN", "not observed"),
  };
  const f = await composedFixture(wire);
  try {
    take(
      await f.runtime.services.requests.create(
        f.ctx,
        f.request("checkpoint-lost-response"),
      ),
    );
    take(await f.runtime.services.requests.tick(f.system));
    const driver = createExecutionDriver({
      db: f.runtime.storage.db,
      clock: f.clock,
      ids: f.ids,
      wire,
    });
    assert.equal(
      take(await driver.start(f.system, captured!)).sessionId,
      "ses_checkpoint",
    );
    assert.equal(starts, 1);
    assert.equal(
      take(await driver.inspect(f.system, runId)).phase,
      "uncertain",
    );
  } finally {
    await f.close();
  }
});
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
