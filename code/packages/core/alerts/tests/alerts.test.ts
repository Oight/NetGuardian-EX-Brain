import { test } from "node:test";
import assert from "node:assert/strict";
import { createAlertService } from "../index.js";
import {
  fixture as caseFixture,
  captureInput,
  take,
} from "../../cases/tests/fixtures.js";
import { context, CONNECTION, SPACE } from "@campussec/testkit";
import {
  ok,
  fail,
  type CallContext,
  type PlatformPage,
  type SourceRecord,
  type TriggerPolicy,
  type AutoCandidate,
  type PlatformQuery,
} from "@campussec/contracts";
async function fixture() {
  const f = await caseFixture(),
    ui = context(),
    system: CallContext = { ...ui, actor: { ...ui.actor, role: "system" } };
  let rows: SourceRecord[] = [],
    failure = false,
    submitted: AutoCandidate[] = [],
    notifications = 0,
    rejectAuto = false,
    queries: PlatformQuery[] = [];
  const deps = {
    ...f,
    cases: f.atomic,
    connections: {
      list: async () => ok([]),
      capabilities: async () => ok([]),
      agents: async () =>
        ok({
          items: [
            { id: "001", name: "synthetic-agent", status: "active" as const },
          ],
        }),
    },
    query: {
      query: async (_ctx: CallContext, query: PlatformQuery) => {
        queries.push(query);
        if (failure) return fail("UPSTREAM_DENIED", "synthetic denial");
        const page: PlatformPage = {
          ...captureInput(f).page,
          queryId: f.ids.next(),
          pageId: f.ids.next(),
          records: rows,
          coverage: {
            ...captureInput(f).page.coverage,
            requestedScope: query.scope,
            effectiveScope: query.scope,
            returned: rows.length,
          },
        };
        return ok(page);
      },
    },
    requests: {
      createAutoInTx(
        _tx: unknown,
        _ctx: CallContext,
        candidate: AutoCandidate,
      ) {
        submitted.push(candidate);
        return rejectAuto
          ? fail("BUDGET_EXHAUSTED", "synthetic daily cap")
          : fail("QUEUE_FULL", "synthetic queue full");
      },
      cancelPolicyInTx: () => ok({ revokeRunIds: [] as string[] }),
    },
    notification: {
      show: async () => {
        notifications++;
        return ok({ shown: true });
      },
    },
    revokeRun: async () => ok(undefined),
  };
  let alerts = createAlertService(deps);
  const row = (id: string, known = true, principal?: string): SourceRecord => {
    const { agentId, ...base } = captureInput(f).page.records[0]!;
    return {
      ...base,
      source: {
        platformInstanceId: SPACE,
        kind: "index_document",
        index: "wazuh-alerts-synthetic",
        documentId: id,
      },
      ...(known ? { agentId: "001" } : {}),
      observedAt: new Date(Date.parse(f.clock.now()) - 1000).toISOString(),
      fields: {
        "rule.id": "100",
        "rule.level": 7,
        ...(principal
          ? { "user.namespace": "synthetic-domain", "user.name": principal }
          : {}),
      },
    };
  };
  const policy: TriggerPolicy = {
    id: f.ids.next(),
    connectionId: CONNECTION,
    enabled: true,
    revision: 1,
    epoch: 1,
    agentIds: ["001"],
    filter: { minLevel: 5 },
    enabledAfterReceiveSeq: 0,
    dailyAttemptLimit: 10,
    timeZone: "Asia/Shanghai",
  };
  return {
    ...f,
    ui,
    system,
    get alerts() {
      return alerts;
    },
    policy,
    row,
    setRows: (v: SourceRecord[]) => {
      rows = v;
    },
    setFailure: (v: boolean) => {
      failure = v;
    },
    setReject: () => {
      rejectAuto = true;
    },
    restart: () => {
      alerts = createAlertService(deps);
    },
    submitted,
    queries,
    notifications: () => notifications,
  };
}
test("first poll is history, duplicate pages do not duplicate evidence notifications, unknown-agent material remains visible", async () => {
  const f = await fixture();
  try {
    f.setRows([f.row("first"), f.row("unknown", false)]);
    const first = take(await f.alerts.pollOnce(f.system, CONNECTION));
    assert.equal(first.inserted, 2);
    assert.equal(first.complete, true);
    let inbox = take(
      await f.alerts.list(f.ui, {
        connectionId: CONNECTION,
        page: { limit: 50 },
      }),
    );
    assert.equal(inbox.items.length, 2);
    assert.ok(inbox.items.every((a) => a.kind === "history"));
    assert.equal(
      inbox.items.find((a) => !a.agentId)?.decisionReason.includes("历史"),
      true,
    );
    assert.equal(f.notifications(), 2);
    take(await f.alerts.pollOnce(f.system, CONNECTION));
    assert.equal(f.notifications(), 2);
    inbox = take(
      await f.alerts.list(f.ui, {
        connectionId: CONNECTION,
        page: { limit: 50 },
      }),
    );
    assert.equal(inbox.items.length, 2);
    assert.equal(f.submitted.length, 0);
    take(await f.alerts.markRead(f.ui, [inbox.items[0]!.id]));
    assert.equal(
      take(
        await f.alerts.list(f.ui, {
          connectionId: CONNECTION,
          page: { limit: 50 },
          read: true,
        }),
      ).items.length,
      1,
    );
  } finally {
    await f.dispose();
  }
});
test("restart and failed polls remain recovery; policy does not dispatch historical or recovered alerts", async () => {
  const f = await fixture();
  try {
    f.setRows([f.row("history")]);
    take(await f.alerts.pollOnce(f.system, CONNECTION));
    take(
      await f.alerts.setPolicy(f.ui, { expectedRevision: 0, policy: f.policy }),
    );
    f.clock.advance(10000);
    f.restart();
    f.setRows([f.row("recovered")]);
    take(await f.alerts.pollOnce(f.system, CONNECTION));
    assert.equal(
      take(
        await f.alerts.list(f.ui, {
          connectionId: CONNECTION,
          page: { limit: 50 },
        }),
      ).items[0]?.kind,
      "recovery",
    );
    f.clock.advance(10000);
    f.setFailure(true);
    assert.equal((await f.alerts.pollOnce(f.system, CONNECTION)).ok, false);
    f.setFailure(false);
    f.setRows([f.row("after-denial")]);
    f.clock.advance(10000);
    take(await f.alerts.pollOnce(f.system, CONNECTION));
    assert.equal(
      take(
        await f.alerts.list(f.ui, {
          connectionId: CONNECTION,
          page: { limit: 50 },
        }),
      ).items[0]?.kind,
      "recovery",
    );
    f.clock.advance(10000);
    take(await f.alerts.flushCandidates(f.system));
    assert.equal(f.submitted.length, 0);
  } finally {
    await f.dispose();
  }
});
test("real-time known principals coalesce for a fixed ten-second window; missing principals never share a group", async () => {
  const f = await fixture();
  try {
    take(await f.alerts.pollOnce(f.system, CONNECTION));
    const policy = take(
      await f.alerts.setPolicy(f.ui, { expectedRevision: 0, policy: f.policy }),
    );
    assert.equal(policy.epoch, 1);
    f.clock.advance(1000);
    f.setRows([
      f.row("one", true, "alice"),
      f.row("two", true, "alice"),
      f.row("unknown-one"),
      f.row("unknown-two"),
    ]);
    take(await f.alerts.pollOnce(f.system, CONNECTION));
    const candidates = take(
      await f.db.read(f.system, (tx) =>
        tx.all<{
          candidate_json: string;
        }>("SELECT candidate_json FROM auto_candidates"),
      ),
    ).map((r) => JSON.parse(r.candidate_json) as AutoCandidate);
    assert.equal(candidates.length, 3);
    assert.deepEqual(
      candidates.map((c) => c.alertIds.length).sort(),
      [1, 1, 2],
    );
    assert.ok(
      candidates.every(
        (c) =>
          Date.parse(c.coalesceUntil) - Date.parse(c.firstReceivedAt) === 10000,
      ),
    );
    f.clock.advance(10001);
    take(await f.alerts.flushCandidates(f.system));
    assert.equal(f.submitted.length, 3);
    assert.equal(
      take(
        await f.alerts.list(f.ui, {
          connectionId: CONNECTION,
          page: { limit: 50 },
        }),
      ).items.length,
      4,
    );
    assert.equal(f.notifications(), 4);
    assert.ok(
      take(
        await f.alerts.list(f.ui, {
          connectionId: CONNECTION,
          page: { limit: 50 },
        }),
      ).items.every((a) => a.decisionReason.includes("QUEUE_FULL")),
    );
  } finally {
    await f.dispose();
  }
});
test("policy CAS and budget rejection preserve inbox and evidence and forbid evidence callers", async () => {
  const f = await fixture();
  try {
    take(await f.alerts.pollOnce(f.system, CONNECTION));
    take(
      await f.alerts.setPolicy(f.ui, { expectedRevision: 0, policy: f.policy }),
    );
    assert.equal(
      (
        await f.alerts.setPolicy(f.ui, {
          expectedRevision: 0,
          policy: f.policy,
        })
      ).ok,
      false,
    );
    f.setReject();
    f.clock.advance(1000);
    f.setRows([f.row("budget", true, "alice")]);
    take(await f.alerts.pollOnce(f.system, CONNECTION));
    f.clock.advance(10001);
    take(await f.alerts.flushCandidates(f.system));
    const inbox = take(
      await f.alerts.list(f.ui, {
        connectionId: CONNECTION,
        page: { limit: 50 },
      }),
    );
    assert.equal(inbox.items.length, 1);
    assert.ok(inbox.items[0]?.decisionReason.includes("BUDGET_EXHAUSTED"));
    assert.equal(f.notifications(), 1);
    const evidence = {
      ...f.ui,
      actor: { ...f.ui.actor, role: "evidence" as const },
    };
    assert.equal((await f.alerts.pollOnce(evidence, CONNECTION)).ok, false);
    assert.equal(
      (
        await f.alerts.setPolicy(evidence, {
          expectedRevision: 1,
          policy: f.policy,
        })
      ).ok,
      false,
    );
  } finally {
    await f.dispose();
  }
});
test("alerts for an already dispatched group attach to the case and notify without scheduling another automatic investigation", async () => {
  const f = await fixture();
  try {
    take(await f.alerts.pollOnce(f.system, CONNECTION));
    take(
      await f.alerts.setPolicy(f.ui, { expectedRevision: 0, policy: f.policy }),
    );
    f.clock.advance(1000);
    f.setRows([f.row("original", true, "alice")]);
    take(await f.alerts.pollOnce(f.system, CONNECTION));
    const first = take(
      await f.db.read(f.system, (tx) =>
        tx.get<{
          id: string;
          case_id: string;
        }>("SELECT id,case_id FROM auto_candidates"),
      ),
    );
    assert.ok(first);
    // The downstream request owner has accepted this group; S05 must not dispatch it a second time.
    take(
      await f.db.write(f.system, (tx) => {
        tx.run("UPDATE auto_candidates SET state='dispatched' WHERE id=?", [
          first.id,
        ]);
        return ok(undefined);
      }),
    );
    f.clock.advance(10000);
    f.setRows([f.row("later", true, "alice")]);
    take(await f.alerts.pollOnce(f.system, CONNECTION));
    f.clock.advance(10001);
    assert.equal(take(await f.alerts.flushCandidates(f.system)), 0);
    assert.equal(f.submitted.length, 0);
    const saved = take(
      await f.db.read(f.system, (tx) => ({
        candidates: tx.get<{
          n: number;
        }>("SELECT COUNT(*) AS n FROM auto_candidates")!.n,
        links: tx.get<{
          n: number;
        }>("SELECT COUNT(*) AS n FROM evidence_links WHERE case_id=?", [
          first.case_id,
        ])!.n,
      })),
    );
    assert.deepEqual(saved, { candidates: 1, links: 2 });
    assert.equal(f.notifications(), 2);
    assert.ok(
      take(
        await f.alerts.list(f.ui, {
          connectionId: CONNECTION,
          page: { limit: 50 },
        }),
      ).items[0]?.decisionReason.includes("不自动复查"),
    );
  } finally {
    await f.dispose();
  }
});
