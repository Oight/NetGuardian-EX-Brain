import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalJson,
  fail,
  ok,
  parseEvidenceToolEnvelope,
  type PlatformCall,
  type Result,
  type PlatformPage,
} from "@campussec/contracts";
import { context, deferred } from "@campussec/testkit";
import {
  createInvestigationTools,
  createToolReplyAtomic,
} from "@campussec/core/investigations/tools";
import { body, error, json, setup, system, take } from "./fixtures.js";

test("native call identifiers use the same Unicode character limit at invoke and acknowledgement", async () => {
  const f = await setup();
  try {
    const id = "🔎".repeat(200);
    take(await f.invoke(id, "get_case_context", {}));
    take(await f.ack(id));
    error(await f.ack("🔎".repeat(257)), "INVALID_INPUT");
    assert.equal(await f.count("tool_reservations"), 1);
  } finally {
    await f.dispose();
  }
});

test("construction is inert; strict arguments, actor, scope and frozen capability reject before quota or IO", async () => {
  const f = await setup();
  try {
    createInvestigationTools(
      new Proxy(f.deps, {
        get() {
          throw new Error("unexpected dependency access");
        },
      }),
    );
    error(await f.tools.invoke(context(), f.input("ui")), "FORBIDDEN");
    error(await f.invoke("shell", "shell", {}), "FORBIDDEN");
    error(
      await f.invoke("extra", "search_related_alerts", {
        agentIds: ["001"],
        url: "https://example.invalid",
      }),
      "INVALID_INPUT",
    );
    error(
      await f.invoke("scope", "search_related_alerts", { agentIds: ["002"] }),
      "SCOPE_EXCEEDED",
    );
    error(
      await f.invoke("fields", "get_evidence", {
        ref: { evidenceId: f.ids.next(), version: 1 },
        fieldNames: ["full_log"],
      }),
      "INVALID_INPUT",
    );
    await f.write((tx) =>
      tx.run("UPDATE analysis_runs SET initial_input_json=? WHERE id=?", [
        canonicalJson({ ...f.initial, capabilities: [] }),
        f.run.id,
      ]),
    );
    error(await f.invoke("capability"), "CAPABILITY_UNAVAILABLE");
    assert.equal(await f.count("tool_reservations"), 0);
    assert.equal(f.platform.query.calls.length, 0);
  } finally {
    await f.dispose();
  }
});

test("query, cached retry, conflict, read projection and explicit release compose with real budgets/cases/reports", async () => {
  const f = await setup();
  try {
    f.queue();
    const first = take(await f.invoke("q")),
      result = body(ok(first));
    take(parseEvidenceToolEnvelope(result));
    assert.equal(result.budget.toolsUsed, 1);
    assert.equal(result.budget.platformAttempts, 1);
    assert.equal(result.budget.distinctEvents, 1);
    assert.equal((await f.view()).projections[0]!.state, "prepared");
    assert.deepEqual(take(await f.invoke("q")), first);
    error(
      await f.invoke("q", "search_related_alerts", {
        agentIds: ["001"],
        filter: { minLevel: 10 },
      }),
      "CONFLICT",
    );
    assert.equal(await f.count("tool_reservations"), 1);
    assert.equal(f.platform.query.calls.length, 1);
    const candidate = f.candidate(result);
    const invalid = body(
      await f.invoke("bad-report", "propose_report", json(candidate)),
    ) as unknown as { data: { validation: string } };
    assert.equal(invalid.data.validation, "invalid");
    take(await f.ack("q", "uncertain"));
    assert.equal((await f.view()).projections[0]!.state, "uncertain");
    take(await f.ack("q"));
    take(await f.ack("q", "uncertain"));
    assert.equal((await f.view()).projections[0]!.state, "released");
    const valid = body(
      await f.invoke("good-report", "propose_report", json(candidate)),
    ) as unknown as { data: { validation: string } };
    assert.equal(valid.data.validation, "valid");
    const narrowed = body(
      await f.invoke("detail", "get_evidence", {
        ref: {
          evidenceId: result.records[0]!.ref.evidenceId,
          version: result.records[0]!.ref.version,
        },
        fieldNames: ["agent.id"],
      }),
    );
    assert.deepEqual(narrowed.records[0]!.content, { "agent.id": "001" });
    assert.equal(f.platform.query.calls.length, 1);
  } finally {
    await f.dispose();
  }
});

test("all five query tools use typed queries, scope fences and per-attempt reservations; steps do not add a second tool charge", async () => {
  const f = await setup();
  try {
    const calls = [
      ["search_related_alerts", { agentIds: ["001"] }],
      [
        "search_authentication_events",
        {
          agentIds: ["001"],
          outcome: "failure",
          account: { namespace: "local", name: "test" },
        },
      ],
      ["get_host_inventory", { agentId: "001", category: "processes" }],
      ["search_file_changes", { agentIds: ["001"], pathEquals: "/etc/test" }],
      ["get_host_findings", { agentId: "001", category: "sca" }],
    ] as const;
    for (const [name, args] of calls) {
      f.queue();
      assert.equal(
        body(
          await f.invoke(
            name,
            name,
            json({
              ...args,
              purpose: "核实材料",
              step: {
                phase: "querying",
                summary: "发出受控查询",
                evidenceRefs: [],
              },
            }),
          ),
        ).status,
        "ok",
      );
    }
    assert.deepEqual(
      f.platform.query.calls.map((c) => c.input.kind),
      ["alerts", "authentication", "inventory", "file_changes", "findings"],
    );
    assert.equal(await f.count("tool_reservations"), 5);
    assert.equal(await f.count("platform_attempts"), 5);
    assert.equal(await f.count("investigation_steps"), 5);
    take(
      await f.invoke("step", "record_investigation_step", {
        phase: "evaluating",
        summary: "合成步骤",
        evidenceRefs: [],
      }),
    );
    assert.equal(await f.count("investigation_steps"), 6);
  } finally {
    await f.dispose();
  }
});

test("concurrent duplicate and reconstructed executor leave inflight uncertainty intact without requery", async () => {
  const f = await setup();
  try {
    const entered = deferred<void>(),
      done = deferred<Result<PlatformPage>>();
    f.platform.query.push(async ({ input, call }) => {
      take(await call.beforeAttempt());
      entered.resolve();
      return done.promise;
    });
    const first = f.invoke("inflight");
    await entered.promise;
    error(await f.invoke("inflight"), "UNCERTAIN");
    error(
      await createInvestigationTools(f.deps).invoke(f.ctx, f.input("inflight")),
      "UNCERTAIN",
    );
    done.resolve(ok(f.page(f.platform.query.calls[0]!.input)));
    take(await first);
    assert.equal(f.platform.query.calls.length, 1);
    assert.equal(await f.count("tool_reservations"), 1);
  } finally {
    await f.dispose();
  }
});

for (const mutation of [
  "cancel",
  "epoch",
  "generation",
  "identity",
  "deadline",
] as const)
  test(`late ${mutation} closes admission, storage, cached reply and acknowledgement`, async () => {
    const f = await setup();
    try {
      const entered = deferred<void>(),
        done = deferred<Result<PlatformPage>>();
      f.platform.query.push(async ({ call }) => {
        take(await call.beforeAttempt());
        entered.resolve();
        return done.promise;
      });
      const first = f.invoke("late");
      await entered.promise;
      if (mutation === "deadline") f.clock.advance(300001);
      else
        await f.write((tx) => {
          if (mutation === "cancel")
            tx.run("UPDATE jobs SET state='cancel_requested' WHERE id=?", [
              f.run.jobId,
            ]);
          if (mutation === "epoch")
            tx.run("UPDATE analysis_runs SET tool_epoch=2 WHERE id=?", [
              f.run.id,
            ]);
          if (mutation === "generation")
            tx.run("UPDATE connections SET generation=2 WHERE id=?", [
              f.run.scope.connectionId,
            ]);
          if (mutation === "identity")
            tx.run("UPDATE space_metadata SET identity_epoch=2");
        });
      done.resolve(ok(f.page(f.platform.query.calls[0]!.input)));
      error(await first);
      error(await f.invoke("late"));
      error(await f.ack("late"));
      assert.equal(await f.count("evidence_versions"), 0);
      assert.equal(await f.count("platform_attempts"), 1);
    } finally {
      await f.dispose();
    }
  });

test("context delivery is established only by acknowledged replies; uncertain/prepared refs cannot validate a proposal", async () => {
  const f = await setup();
  try {
    const contextReply = body(
      await f.invoke("context", "get_case_context", {}),
    );
    assert.equal(contextReply.context!.backgrounds.length, 1);
    const ref = contextReply.context!.backgrounds[0]!.ref;
    const candidate = {
      ...f.candidate(),
      analysis: [
        {
          text: "人工说明，未核实",
          evidenceRefs: [],
          queryIds: [],
          contextRefs: [ref],
        },
      ],
    };
    const validation = async (id: string) =>
      (
        body(
          await f.invoke(id, "propose_report", json(candidate)),
        ) as unknown as { data: { validation: string } }
      ).data.validation;
    assert.equal(await validation("prepared"), "invalid");
    take(await f.ack("context", "uncertain"));
    assert.equal(await validation("uncertain"), "invalid");
    take(await f.ack("context"));
    assert.equal(await validation("released"), "needs_review");
    error(
      await f.invoke("spoof", "propose_report", {
        ...json(candidate),
        validationInput: { contexts: [] },
      }),
      "INVALID_INPUT",
    );
  } finally {
    await f.dispose();
  }
});

test("16 KiB fitting keeps valid JSON and source coverage; omitted projections are never released", async () => {
  const f = await setup();
  try {
    f.queue({
      count: 50,
      fields: {
        text: "中文事件".repeat(600),
        full_log: "PRIVATE",
        os: { name: "Linux", token: "PRIVATE" },
      },
    });
    const result = body(await f.invoke("large"));
    assert.equal(result.status, "partial");
    assert.equal(result.coverage!.returned, 50);
    assert.ok(result.records.length > 0 && result.records.length < 50);
    assert.ok(!JSON.stringify(result).includes("PRIVATE"));
    take(await f.ack("large"));
    const view = await f.view();
    assert.equal(
      view.projections.filter((p) => p.state === "released").length,
      result.records.length,
    );
    assert.equal(
      view.projections.filter((p) => p.state === "prepared").length,
      50 - result.records.length,
    );
  } finally {
    await f.dispose();
  }
});

test("nested unsafe explicit evidence is rejected and its projection rolled back", async () => {
  const f = await setup();
  try {
    const captured = await f.capture({
      released: false,
      fields: { os: { name: "Linux", secret: "PRIVATE" } },
    });
    const before = await f.count("evidence_projections");
    const reply = body(
      await f.invoke(
        "unsafe",
        "get_evidence",
        json({ ref: captured.refs[0]!, fieldNames: ["os"] }),
      ),
    );
    assert.equal(reply.status, "denied");
    assert.equal(await f.count("evidence_projections"), before);
    assert.ok(!JSON.stringify(reply).includes("PRIVATE"));
  } finally {
    await f.dispose();
  }
});

test("300 distinct source identities commit; event 301 rolls back evidence while keeping tool/platform charges", async () => {
  const f = await setup();
  try {
    for (let i = 0; i < 6; i++) {
      f.queue({ count: 50 });
      assert.equal(
        body(await f.invoke(`q${i}`)).budget.distinctEvents,
        (i + 1) * 50,
      );
    }
    f.queue();
    const failed = body(await f.invoke("overflow"));
    assert.equal(failed.status, "failed");
    assert.ok(failed.warnings.some((w) => w.includes("BUDGET_EXHAUSTED")));
    assert.equal(failed.coverage!.queryCompleteness, "not_executed");
    assert.equal(await f.count("evidence_versions"), 300);
    assert.equal(await f.count("run_event_keys"), 300);
    assert.equal(await f.count("tool_reservations"), 7);
    assert.equal(await f.count("platform_attempts"), 7);
    assert.deepEqual(body(await f.invoke("overflow")), failed);
  } finally {
    await f.dispose();
  }
});

test("different versions of one source consume one event; failed retries still consume each reserved attempt", async () => {
  const f = await setup();
  try {
    for (let i = 0; i < 2; i++) {
      f.platform.query.push(async ({ input, call }) => {
        take(await call.beforeAttempt());
        take(await call.beforeAttempt());
        return ok(
          f.page(input, {
            documentId: "stable-source",
            fields: { text: `version-${i}` },
            attempts: 2,
          }),
        );
      });
      const result = body(await f.invoke(`version${i}`));
      assert.equal(result.budget.distinctEvents, 1);
    }
    assert.equal(await f.count("evidence_versions"), 2);
    assert.equal(await f.count("platform_attempts"), 4);
  } finally {
    await f.dispose();
  }
});

test("upstream denied/unavailable/throw/invalid count are explicit cached query failures, distinct from zero matches", async () => {
  const f = await setup();
  try {
    const expected = ["denied", "unavailable", "unavailable", "failed", "ok"];
    f.platform.query.push(async ({ call }) => {
      take(await call.beforeAttempt());
      return fail("UPSTREAM_DENIED", "PRIVATE");
    });
    f.platform.query.push(async ({ call }) => {
      take(await call.beforeAttempt());
      return fail("UPSTREAM_UNAVAILABLE", "PRIVATE");
    });
    f.platform.query.push(async () => {
      throw new Error("PRIVATE");
    });
    f.platform.query.push(async ({ input }) =>
      ok(f.page(input, { attempts: 1 })),
    );
    f.queue({ count: 0 });
    for (let i = 0; i < expected.length; i++) {
      const result = body(await f.invoke(`failure${i}`));
      assert.equal(result.status, expected[i]);
      assert.ok(result.queryId);
      assert.equal(
        result.coverage!.queryCompleteness,
        i === 4 ? "complete" : "not_executed",
      );
      assert.ok(!JSON.stringify(result).includes("PRIVATE"));
      assert.deepEqual(body(await f.invoke(`failure${i}`)), result);
    }
    assert.equal(f.platform.query.calls.length, 5);
    assert.equal(await f.count("query_runs"), 5);
  } finally {
    await f.dispose();
  }
});

test("settled queries invalidate retained beforeAttempt callbacks; platform budget exhaustion is never successful empty", async () => {
  const f = await setup();
  try {
    let saved: PlatformCall | undefined;
    f.platform.query.push(async ({ input, call }) => {
      saved = call;
      for (let i = 0; i < 20; i++) take(await call.beforeAttempt());
      return ok(f.page(input, { attempts: 20 }));
    });
    body(await f.invoke("twenty"));
    error(await saved!.beforeAttempt(), "EXPIRED");
    f.queue();
    const result = body(await f.invoke("over"));
    assert.equal(result.status, "failed");
    assert.equal(result.budget.platformAttempts, 20);
    assert.equal(result.coverage!.queryCompleteness, "not_executed");
  } finally {
    await f.dispose();
  }
});

test("cleanup and reply expiry share one real transaction; stale cache cannot redeliver deleted evidence", async () => {
  const f = await setup();
  try {
    f.queue();
    body(await f.invoke("expire"));
    take(await f.ack("expire"));
    const atomic = createToolReplyAtomic();
    const input = {
      caseIds: [f.run.caseId],
      olderThan: "2026-10-24T00:00:00.000Z",
      protectedRunIds: [],
    };
    const preview = take(
      await f.db.write(system(), (tx) =>
        f.cases.atomic.previewCleanupInTx(tx, system(), input),
      ),
    );
    const clean = (commit: boolean) =>
      f.db.write(system(), (tx) => {
        const cleaned = f.cases.atomic.applyCleanupInTx(tx, system(), {
          planId: preview.id,
          expectedPlanHash: preview.planHash,
          protectedRunIds: [],
        });
        if (!cleaned.ok) return cleaned;
        const expired = atomic.expireRepliesInTx(tx, system(), {
          projectionIds: cleaned.value.projectionIds,
        });
        return expired.ok && !commit ? fail("INTERNAL", "合成回滚") : expired;
      });
    error(await clean(false), "INTERNAL");
    take(await f.invoke("expire"));
    take(await clean(true));
    error(await f.invoke("expire"), "EXPIRED");
    error(await f.ack("expire"), "EXPIRED");
    assert.equal(f.platform.query.calls.length, 1);
    const stored = take(
      await f.db.read(system(), (tx) =>
        tx.get<{ reply_json: string | null }>(
          "SELECT reply_json FROM mcp_calls WHERE call_id='expire'",
        )!,
      ),
    );
    assert.equal(stored.reply_json, null);
  } finally {
    await f.dispose();
  }
});
