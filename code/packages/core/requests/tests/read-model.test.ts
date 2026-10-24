import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, ok } from "@campussec/contracts";
import {
  CASE,
  CONNECTION,
  PRINCIPAL,
  SPACE,
  context,
  scope,
} from "@campussec/testkit";
import {
  createInvestigationHistory,
  createReportAnchors,
} from "@campussec/core/requests/read-model";
import { setup, take, error, system } from "../../reports/tests/fixtures.js";
import { createStorage } from "@campussec/storage";
import { createCaseService } from "@campussec/core/cases";

test("history pages all requests including failed/cancelled no-report work beyond workspace limit; cursors bind identity/case", async () => {
  const f = await setup();
  try {
    take(
      await f.db.write(system(), (tx) => {
        tx.run("UPDATE jobs SET state='failed' WHERE id=?", [f.run.jobId]);
        for (let i = 0; i < 24; i++) {
          const requestId = f.ids.next(),
            jobId = f.ids.next();
          tx.run(
            "INSERT INTO investigation_requests(id,origin,state,principal_id,connection_id,question,seed_refs_json,case_id,job_id,missing_fields_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            [
              requestId,
              "client_user",
              "accepted",
              PRINCIPAL,
              CONNECTION,
              "无报告历史 " + i,
              "[]",
              CASE,
              jobId,
              "[]",
              f.clock.now(),
              f.run.expiresAt,
            ],
          );
          tx.run(
            "INSERT INTO jobs(id,request_id,case_id,origin,state,revision,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,1,?,?,?)",
            [
              jobId,
              requestId,
              CASE,
              "client_user",
              i % 2 ? "failed" : "cancelled",
              f.clock.now(),
              f.clock.now(),
              f.run.expiresAt,
            ],
          );
        }
        return ok(undefined);
      }),
    );
    const history = createInvestigationHistory({
      db: f.db,
      casesAtomic: f.cases.atomic,
    });
    let cursor: string | undefined;
    const ids: string[] = [];
    do {
      const page = take(
        await history.list(context(), {
          caseId: CASE,
          page: { limit: 7, ...(cursor ? { cursor } : {}) },
        }),
      );
      ids.push(...page.items.map((item) => item.request.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(ids.length, 25);
    assert.equal(new Set(ids).size, 25);
    const first = take(
      await history.list(context(), { caseId: CASE, page: { limit: 7 } }),
    );
    const foreign = take(
      await f.cases.service.create(context(), {
        title: "另案",
        scope,
        seedRefs: [],
      }),
    );
    error(
      await history.list(context(), {
        caseId: foreign.id,
        page: { limit: 7, cursor: first.nextCursor! },
      }),
      "CURSOR_INVALID",
    );
    const ctx = context();
    ctx.actor.principalId = SPACE;
    error(
      await history.list(ctx, { caseId: CASE, page: { limit: 7 } }),
      "FORBIDDEN",
    );
    error(
      await history.list(system(), { caseId: CASE, page: { limit: 7 } }),
      "FORBIDDEN",
    );
  } finally {
    await f.dispose();
  }
});

test("historical inputs preserve frozen context, prepared profile and released/expired projections through reopen and paging", async () => {
  const f = await setup(true);
  let reopened: Awaited<ReturnType<typeof createStorage>> | undefined;
  try {
    const evidence = await f.capture({ count: 3 });
    // The profile fixture below is a persisted historical value; it does not execute a model.
    const prepared = {
      version: f.run.profileVersion,
      systemText: "冻结配置",
      userText: "冻结材料",
      allowedTools: [],
      seedProjectionIds: [],
      contextRefs: [],
    };
    take(
      await f.db.write(system(), (tx) => {
        tx.run("UPDATE analysis_runs SET prepared_profile_json=? WHERE id=?", [
          canonicalJson(prepared),
          f.run.id,
        ]);
        return ok(undefined);
      }),
    );
    const history = createInvestigationHistory({
      db: f.db,
      casesAtomic: f.cases.atomic,
    });
    const first = take(
      await history.snapshot(context(), {
        runId: f.run.id,
        page: { limit: 2 },
      }),
    );
    assert.equal(first.initialInput.contexts[0]!.text, "维护说明，尚未核实");
    assert.deepEqual(first.preparedProfile, prepared);
    assert.equal(first.projections.length, 2);
    assert.ok(first.nextCursor);
    const second = take(
      await history.snapshot(context(), {
        runId: f.run.id,
        page: { limit: 2, cursor: first.nextCursor },
      }),
    );
    assert.equal(second.projections.length, 1);
    assert.equal(
      new Set([...first.projections, ...second.projections].map((p) => p.id))
        .size,
      3,
    );
    take(
      await f.db.write(system(), (tx) => {
        tx.run(
          "UPDATE evidence_projections SET availability='expired',content_json='{}' WHERE id=?",
          [evidence.projections[0]!.id],
        );
        return ok(undefined);
      }),
    );
    error(
      await history.snapshot(context(), {
        runId: f.run.id,
        page: { limit: 2, cursor: first.nextCursor },
      }),
      "CURSOR_INVALID",
    );
    await f.close();
    reopened = await createStorage(f.storeDeps);
    const storage = take(reopened),
      cases = createCaseService({ ...storage, clock: f.clock, ids: f.ids });
    const saved = take(
      await createInvestigationHistory({
        db: storage.db,
        casesAtomic: cases.atomic,
      }).snapshot(context(), { runId: f.run.id, page: { limit: 50 } }),
    );
    assert.deepEqual(saved.initialInput, f.initialInput);
    assert.ok(saved.projections.some((p) => p.availability === "expired"));
    const bad = {
      ...system(),
      actor: {
        ...system().actor,
        role: "evidence" as const,
        runId: f.ids.next(),
      },
    };
    error(
      take(
        await storage.db.read(bad, (tx) =>
          createReportAnchors().runInTx(tx, bad, f.run.id),
        ),
      ),
      "FORBIDDEN",
    );
  } finally {
    if (reopened?.ok) await reopened.value.close();
    await f.dispose();
  }
});
