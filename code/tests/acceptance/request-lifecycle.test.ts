import { test } from "node:test";
import assert from "node:assert/strict";
import { composeRuntime } from "../../apps/desktop/runtime/compose.js";
import {
  FakeClock,
  FakeIds,
  SPACE,
  PRINCIPAL,
  scope,
} from "@campussec/testkit";
import {
  ok,
  fail,
  type CallContext,
  type Result,
  type CreateRequest,
  type ExecutionSnapshot,
} from "@campussec/contracts";
import type { ExecutionWire } from "@campussec/teleagent-bridge/execution";
import { composedFixture as fixture, take } from "../support/composed.js";
test("request admission is durable, idempotent and source-bound; cancelled queued work stores an actual no-run result", async () => {
  const f = await fixture();
  try {
    const service = f.runtime.services.requests;
    const accepted = take(await service.create(f.ctx, f.request("idempotent")));
    assert.equal(accepted.job?.state, "queued");
    assert.equal(accepted.job?.runId, undefined);
    assert.equal(
      take(await service.create(f.ctx, f.request("idempotent"))).request.id,
      accepted.request.id,
    );
    const conflict = await service.create(f.ctx, {
      ...f.request("idempotent"),
      question: "不同请求",
    });
    assert.equal(conflict.ok, false);
    const forged = await service.create(f.ctx, {
      ...f.request("forged"),
      origin: "alert_auto",
    });
    assert.equal(forged.ok, false);
    const evidence = {
      ...f.ctx,
      actor: { ...f.ctx.actor, role: "evidence" as const },
    };
    assert.equal(
      (await service.create(evidence, f.request("evidence"))).ok,
      false,
    );
    assert.equal(
      take(
        await service.cancel(f.ctx, {
          requestId: accepted.request.id,
          reason: "尚未提交",
        }),
      ).job?.state,
      "cancelled",
    );
    const result = take(
      await f.runtime.services.delivery.getResult(f.ctx, {
        requestId: accepted.request.id,
      }),
    );
    assert.equal(result.terminalState, "cancelled");
    assert.equal(result.runId, undefined);
    await f.reopen();
    assert.equal(
      take(await f.runtime.services.requests.status(f.ctx, accepted.request.id))
        .job?.state,
      "cancelled",
    );
    assert.equal(f.network(), 0);
  } finally {
    await f.close();
  }
});
test("missing execution adapter produces an explicit failed sealed run, never a fake successful investigation", async () => {
  const f = await fixture();
  try {
    const accepted = take(
      await f.runtime.services.requests.create(f.ctx, f.request("no-host")),
    );
    take(await f.runtime.services.requests.tick(f.system));
    const status = take(
      await f.runtime.services.requests.status(f.ctx, accepted.request.id),
    );
    assert.equal(status.job?.state, "failed");
    assert.ok(status.job.runId);
    const result = take(
      await f.runtime.services.delivery.getResult(f.ctx, {
        requestId: accepted.request.id,
      }),
    );
    assert.equal(result.terminalState, "failed");
    assert.equal(result.runId, status.job.runId);
    assert.equal(result.error?.code, "CAPABILITY_UNAVAILABLE");
    assert.equal(f.network(), 0);
  } finally {
    await f.close();
  }
});
test("restart holds manual queue; resume requires current revision and never silently starts it", async () => {
  const f = await fixture();
  try {
    const accepted = take(
      await f.runtime.services.requests.create(f.ctx, f.request("hold")),
    );
    await f.reopen();
    const status = take(
      await f.runtime.services.requests.status(f.ctx, accepted.request.id),
    );
    assert.equal(status.job?.recoveryHold, true);
    take(await f.runtime.services.requests.tick(f.system));
    assert.equal(
      take(await f.runtime.services.requests.status(f.ctx, accepted.request.id))
        .job?.state,
      "queued",
    );
    assert.equal(
      (
        await f.runtime.services.requests.resume(f.ctx, {
          requestId: accepted.request.id,
          expectedJobRevision: 1,
        })
      ).ok,
      false,
    );
    const resumed = take(
      await f.runtime.services.requests.resume(f.ctx, {
        requestId: accepted.request.id,
        expectedJobRevision: status.job!.revision,
      }),
    );
    assert.equal(resumed.job?.recoveryHold, false);
  } finally {
    await f.close();
  }
});
test("scope supplementation is idempotent, creates one job, and does not mutate the frozen running question", async () => {
  const f = await fixture();
  try {
    const { requestedScope, ...input } = f.request("awaiting");
    const accepted = take(
      await f.runtime.services.requests.create(f.ctx, input),
    );
    assert.equal(accepted.request.state, "awaiting_scope");
    assert.equal(accepted.job, undefined);
    const supplement = {
      requestId: accepted.request.id,
      scope: requestedScope!,
      text: "补充资料",
      idempotencyKey: "scope",
    };
    const prepared = take(
      await f.runtime.services.requests.provideInput(f.ctx, supplement),
    );
    assert.equal(prepared.job?.state, "queued");
    assert.equal(
      take(await f.runtime.services.requests.provideInput(f.ctx, supplement))
        .job?.id,
      prepared.job?.id,
    );
    assert.equal(
      (
        await f.runtime.services.requests.provideInput(f.ctx, {
          ...supplement,
          text: "不同内容",
        })
      ).ok,
      false,
    );
  } finally {
    await f.close();
  }
});
test("lost submission response is never resubmitted; uncertain work blocks slot and requires explicit abandon", async () => {
  let starts = 0,
    inspects = 0;
  const wire: ExecutionWire = {
    start: async () => {
      starts++;
      throw new Error("synthetic lost response");
    },
    inspect: async (_ctx, runId) => {
      inspects++;
      return ok({
        runId,
        phase: "uncertain",
        verification: "unverified",
        observedAt: "2026-10-23T01:00:00.000Z",
      });
    },
    abort: async (_ctx, runId) =>
      ok({
        runId,
        phase: "uncertain",
        verification: "unverified",
        observedAt: "2026-10-23T01:00:00.000Z",
      }),
  };
  const f = await fixture(wire);
  try {
    const a = take(
        await f.runtime.services.requests.create(f.ctx, f.request("lost")),
      ),
      b = take(
        await f.runtime.services.requests.create(f.ctx, f.request("second")),
      );
    take(await f.runtime.services.requests.tick(f.system));
    assert.equal(starts, 1);
    assert.equal(
      take(await f.runtime.services.requests.status(f.ctx, a.request.id)).job
        ?.state,
      "uncertain",
    );
    for (const delta of [5000, 15000, 60000, 60000]) {
      f.clock.advance(delta);
      take(await f.runtime.services.requests.tick(f.system));
    }
    assert.equal(inspects, 3);
    assert.equal(starts, 1);
    assert.equal(
      take(await f.runtime.services.requests.status(f.ctx, b.request.id)).job
        ?.state,
      "queued",
    );
    await f.reopen();
    f.clock.advance(60000);
    take(await f.runtime.services.requests.tick(f.system));
    assert.equal(starts, 1);
    assert.equal(inspects, 3);
    const latest = take(
      await f.runtime.services.requests.status(f.ctx, a.request.id),
    );
    const abandoned = take(
      await f.runtime.services.requests.abandon(f.ctx, {
        requestId: a.request.id,
        expectedJobRevision: latest.job!.revision,
        reason: "人工明确放弃；远端可能仍运行",
      }),
    );
    assert.equal(abandoned.job?.state, "needs_review");
    assert.equal(
      take(
        await f.runtime.services.delivery.getResult(f.ctx, {
          requestId: a.request.id,
        }),
      ).terminalState,
      "needs_review",
    );
  } finally {
    await f.close();
  }
});
test("policy cancellation and deadline fence tools before abort; abort observation cannot impersonate a different message", async () => {
  let runId = "",
    aborts = 0;
  let f: Awaited<ReturnType<typeof fixture>>;
  const snapshot = (phase: ExecutionSnapshot["phase"]): ExecutionSnapshot => ({
    runId,
    phase,
    verification: "verified",
    sessionId: "synthetic-session",
    userMessageId: "synthetic-input",
    observedAt: "2026-10-23T01:00:00.000Z",
  });
  const wire: ExecutionWire = {
    start: async (_ctx, input) => {
      runId = input.run.id;
      return ok(snapshot("running"));
    },
    inspect: async () => ok(snapshot("running")),
    abort: async () => {
      aborts++;
      const observed = take(
        await f.runtime.storage.db.read(f.system, (tx) => ({
          job: tx.get<{
            state: string;
          }>("SELECT state FROM jobs WHERE run_id=?", [runId]),
          grant: tx.get<{
            state: string;
          }>("SELECT state FROM mcp_grants WHERE run_id=?", [runId]),
        })),
      );
      assert.equal(observed.job?.state, "cancel_requested");
      assert.equal(observed.grant?.state, "revoked");
      return ok({ ...snapshot("cancelled"), sessionId: "different-session" });
    },
  };
  f = await fixture(wire);
  try {
    const a = take(
      await f.runtime.services.requests.create(f.ctx, f.request("timeout")),
    );
    take(await f.runtime.services.requests.tick(f.system));
    assert.equal(
      take(await f.runtime.services.requests.status(f.ctx, a.request.id)).job
        ?.state,
      "running",
    );
    f.clock.advance(300001);
    take(await f.runtime.services.requests.tick(f.system));
    assert.equal(aborts, 1);
    assert.equal(
      take(await f.runtime.services.requests.status(f.ctx, a.request.id)).job
        ?.state,
      "uncertain",
    );
    for (let i = 0; i < 10; i++) {
      f.clock.advance(1000);
      take(await f.runtime.services.requests.tick(f.system));
    }
    assert.equal(aborts, 1);
  } finally {
    await f.close();
  }
});
test("queue admission deadline and the five-minute execution deadline are independent", async () => {
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
        observedAt: f.clock.now(),
      });
    },
    inspect: async () => {
      throw new Error("unused");
    },
    abort: async () => {
      throw new Error("unused");
    },
  };
  const f = await fixture(wire);
  try {
    const accepted = take(
      await f.runtime.services.requests.create(
        f.ctx,
        f.request("independent-deadlines"),
      ),
    );
    f.clock.advance(899000);
    take(await f.runtime.services.requests.tick(f.system));
    const state = take(
      await f.runtime.services.requests.status(f.ctx, accepted.request.id),
    );
    assert.equal(state.job?.state, "running");
    assert.equal(
      Date.parse(state.budget!.deadline) - Date.parse(f.clock.now()),
      300000,
    );
    assert.ok(state.budget!.deadline > state.request.expiresAt);
  } finally {
    await f.close();
  }
});
test("concurrent admissions enforce the actual queue cap atomically without orphan cases or consuming retries", async () => {
  const f = await fixture();
  try {
    const outcomes = await Promise.all(
      Array.from({ length: 22 }, (_, index) =>
        f.runtime.services.requests.create(f.ctx, f.request("queue-" + index)),
      ),
    );
    const accepted = outcomes.filter((r) => r.ok),
      rejected = outcomes.filter((r) => !r.ok);
    assert.equal(accepted.length, 20);
    assert.equal(rejected.length, 2);
    assert.ok(rejected.every((r) => !r.ok && r.error.code === "QUEUE_FULL"));
    const counts = take(
      await f.runtime.storage.db.read(f.system, (tx) => ({
        cases: tx.get<{
          n: number;
        }>("SELECT COUNT(*) AS n FROM cases")!.n,
        jobs: tx.get<{
          n: number;
        }>("SELECT COUNT(*) AS n FROM jobs")!.n,
        requests: tx.get<{
          n: number;
        }>("SELECT COUNT(*) AS n FROM investigation_requests")!.n,
      })),
    );
    assert.deepEqual(counts, { cases: 20, jobs: 20, requests: 20 });
    assert.equal(
      take(
        await f.runtime.services.requests.create(f.ctx, f.request("queue-0")),
      ).request.id,
      take(outcomes[0]!).request.id,
    );
    assert.equal(f.network(), 0);
  } finally {
    await f.close();
  }
});
