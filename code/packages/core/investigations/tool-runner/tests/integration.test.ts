import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalJson,
  ok,
  type PlatformCall,
  type PlatformPage,
  type Result,
} from "@campussec/contracts";
import {
  CONNECTION,
  SPACE,
  context,
  createScriptedHttp,
  createScriptedSecrets,
  deferred,
} from "@campussec/testkit";
import { createStorage } from "@campussec/storage";
import { createCaseService } from "@campussec/core/cases";
import { createReportService } from "@campussec/core/reports";
import { createRunBudget } from "@campussec/core/requests/budgets";
import { createWazuhAdapter } from "@campussec/wazuh-adapter";
import { createInvestigationTools } from "@campussec/core/investigations/tools";
import { body, error, json, setup, system, take } from "./fixtures.js";

test("real S04 pagination/login, real S06 and budgets handle a cached page with zero new attempts", async () => {
  const f = await setup();
  try {
    const http = createScriptedHttp(),
      secrets = createScriptedSecrets();
    const adapter = createWazuhAdapter({
      ...f,
      http: http.port,
      secrets: secrets.port,
    });
    take(
      await adapter.save(context(), {
        id: CONNECTION,
        expectedGeneration: 1,
        spaceId: SPACE,
        platformInstanceId: SPACE,
        displayName: "合成接口",
        principalFingerprint: "synthetic",
        serverBaseUrl: "https://server.invalid/",
        serverSecretRef: f.ids.next(),
        alertsPattern: "synthetic-*",
        mappingVersion: "v1",
      }),
    );
    await f.write((tx) =>
      tx.run("UPDATE analysis_runs SET connection_generation=2 WHERE id=?", [
        f.run.id,
      ]),
    );
    secrets.read.push(async () =>
      ok(
        new TextEncoder().encode(
          JSON.stringify({ username: "synthetic", password: "synthetic" }),
        ),
      ),
    );
    const response = (body: unknown) =>
      ok({
        status: 200,
        headers: {},
        bodyText: typeof body === "string" ? body : JSON.stringify(body),
      });
    http.script.push(async () => response("synthetic.payload.signature"));
    const server = (id: string) =>
      response({
        error: 0,
        data: {
          affected_items: [
            {
              id,
              name: "package",
              scan: { id: "scan1", time: "2026-10-23T00:45:00Z" },
            },
          ],
          total_affected_items: 2,
          total_failed_items: 0,
        },
      });
    http.script.push(async () => server("row1"));
    http.script.push(async (req) => {
      assert.match(req.url, /offset=1/);
      return server("row2");
    });
    const tools = createInvestigationTools({ ...f.deps, query: adapter });
    const invoke = (id: string, page: { limit: number; cursor?: string }) =>
      tools.invoke(
        f.ctx,
        f.input(id, "get_host_inventory", {
          agentId: "001",
          category: "packages",
          page,
        }),
      );
    const first = body(await invoke("page1", { limit: 1 }));
    assert.ok(first.nextCursor);
    assert.equal(first.budget.platformAttempts, 2); // login + read
    const second = body(
      await invoke("page2", { limit: 1, cursor: first.nextCursor }),
    );
    assert.equal(second.records.length, 1);
    assert.equal(second.queryId, first.queryId);
    assert.equal(second.budget.platformAttempts, 3);
    const replay = body(
      await invoke("page2-replay", { limit: 1, cursor: first.nextCursor }),
    );
    assert.deepEqual(replay.records, second.records);
    assert.equal(replay.budget.platformAttempts, 3);
    assert.equal(replay.budget.toolsUsed, 3);
    assert.equal(http.script.calls.length, 3);
    assert.equal(await f.count("query_pages"), 2);
    assert.equal(await f.count("evidence_versions"), 2);
    http.script.assertDrained();
    secrets.read.assertDrained();
  } finally {
    await f.dispose();
  }
});

test("reply and idempotence survive actual SQLite close/reopen with no upstream query", async () => {
  const f = await setup();
  let close: (() => Promise<void>) | undefined;
  try {
    f.queue();
    const original = take(await f.invoke("persisted"));
    const entered = deferred<void>(),
      done = deferred<Result<PlatformPage>>();
    f.platform.query.push(async ({ call }) => {
      take(await call.beforeAttempt());
      entered.resolve();
      return done.promise;
    });
    const lost = f.invoke("lost-at-restart");
    await entered.promise;
    await f.close();
    const storage = take(await createStorage(f.storeDeps));
    close = storage.close;
    const deps = { ...f.deps, ...storage },
      cases = createCaseService(deps),
      budget = createRunBudget(deps);
    const tools = createInvestigationTools({
      ...deps,
      budget: budget.budget,
      budgetAtomic: budget.atomic,
      casesAtomic: cases.atomic,
      proposals: createReportService({
        ...deps,
        cases: cases.service,
        casesAtomic: cases.atomic,
      }),
    });
    assert.deepEqual(
      take(await tools.invoke(f.ctx, f.input("persisted"))),
      original,
    );
    error(await tools.invoke(f.ctx, f.input("lost-at-restart")), "UNCERTAIN");
    take(
      await tools.acknowledgeReply(f.ctx, {
        transportBindingId: f.binding,
        callId: "persisted",
        outcome: "released",
      }),
    );
    done.resolve(ok(f.page(f.platform.query.calls[1]!.input)));
    error(await lost, "STORAGE_UNAVAILABLE");
    assert.equal(f.platform.query.calls.length, 2);
  } finally {
    await close?.();
    await f.dispose();
  }
});

test("initial seed identities use the same budget key as later versions of that source", async () => {
  const f = await setup();
  try {
    const captured = await f.capture({ released: false });
    const initial = { ...f.initial, seedRefs: captured.refs };
    const profile = take(
      await f.service.prepare(system(), {
        run: f.run,
        initialInput: initial,
        seedProjections: captured.projections,
      }),
    );
    await f.write((tx) =>
      tx.run(
        "UPDATE analysis_runs SET initial_input_json=?,prepared_profile_json=? WHERE id=?",
        [canonicalJson(initial), canonicalJson(profile), f.run.id],
      ),
    );
    const first = body(await f.invoke("seed-context", "get_case_context", {}));
    assert.equal(first.records.length, 1);
    assert.equal(first.budget.distinctEvents, 1);
    const locator = take(
      await f.db.read(
        system(),
        (tx) =>
          tx.get<{ locator_json: string }>(
            "SELECT locator_json FROM evidence_sources WHERE evidence_id=?",
            [captured.refs[0]!.evidenceId],
          )!,
      ),
    );
    const source = JSON.parse(locator.locator_json);
    f.platform.query.push(async ({ input, call }) => {
      take(await call.beforeAttempt());
      const page = f.page(input, { fields: { text: "新内容版本" } });
      page.records[0]!.source = source;
      return ok(page);
    });
    const next = body(await f.invoke("seed-version"));
    assert.equal(next.records[0]!.ref.evidenceId, captured.refs[0]!.evidenceId);
    assert.equal(next.budget.distinctEvents, 1);
    assert.equal(await f.count("evidence_versions"), 2);
  } finally {
    await f.dispose();
  }
});

test("timeout is bounded even if an upstream port ignores AbortSignal; late callbacks cannot query", async () => {
  const f = await setup();
  try {
    f.clock.advance(299999);
    let call: PlatformCall | undefined;
    f.platform.query.push(async (args) => {
      call = args.call;
      take(await args.call.beforeAttempt());
      return new Promise<Result<PlatformPage>>(() => undefined);
    });
    const reply = body(await f.invoke("timeout"));
    assert.equal(reply.status, "unavailable");
    assert.ok(reply.warnings.some((w) => w.includes("UPSTREAM_TIMEOUT")));
    assert.equal(call!.signal.aborted, true);
    error(await call!.beforeAttempt(), "EXPIRED");
    assert.deepEqual(body(await f.invoke("timeout")), reply);
  } finally {
    await f.dispose();
  }
});

test("oversized frozen backgrounds omitted from context replies are not made report references by acknowledgement", async () => {
  const f = await setup();
  try {
    const initial = {
      ...f.initial,
      contexts: f.initial.contexts.map((c) => ({
        ...c,
        text: "背景".repeat(4000),
      })),
    };
    const profile = take(
      await f.service.prepare(system(), {
        run: f.run,
        initialInput: initial,
        seedProjections: [],
      }),
    );
    await f.write((tx) =>
      tx.run(
        "UPDATE analysis_runs SET initial_input_json=?,prepared_profile_json=? WHERE id=?",
        [canonicalJson(initial), canonicalJson(profile), f.run.id],
      ),
    );
    const reply = body(await f.invoke("large-context", "get_case_context", {}));
    assert.equal(reply.status, "partial");
    assert.equal(reply.context!.backgrounds.length, 0);
    take(await f.ack("large-context"));
    const c = initial.contexts[0]!;
    const candidate = {
      ...f.candidate(),
      analysis: [
        {
          text: "未交付背景",
          evidenceRefs: [],
          queryIds: [],
          contextRefs: [{ contextId: c.id, version: c.version }],
        },
      ],
    };
    const proposed = body(
      await f.invoke("omitted-report", "propose_report", json(candidate)),
    ) as unknown as { data: { validation: string } };
    assert.equal(proposed.data.validation, "invalid");
  } finally {
    await f.dispose();
  }
});
