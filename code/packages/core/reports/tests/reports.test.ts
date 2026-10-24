import { createReportAnchors } from "@campussec/core/requests/read-model";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalJson,
  fail,
  ok,
  type ReportCandidate,
} from "@campussec/contracts";
import { CASE, PRINCIPAL, context } from "@campussec/testkit";
import { createStorage } from "@campussec/storage";
import { createCaseService } from "@campussec/core/cases";
import {
  createReportService,
  createResultPackageReader,
} from "@campussec/core/reports";
import { error, setup, system, take } from "./fixtures.js";

test("proposals preserve frozen baseRevision, version history and reference failures", async () => {
  const f = await setup();
  try {
    const { candidate, refs } = await f.capture();
    await f.attach(refs);
    const first = take(await f.propose(candidate));
    assert.equal(first.validation, "valid");
    assert.equal(first.review, "unreviewed");
    assert.equal(first.baseRevision, f.run.baseRevision);
    assert.ok((await f.caseRevision()) > first.baseRevision);
    const bad: ReportCandidate = {
      ...candidate,
      facts: [
        {
          ...candidate.facts[0]!,
          evidenceRefs: [
            {
              ...candidate.facts[0]!.evidenceRefs[0]!,
              projectionId: f.ids.next(),
            },
          ],
        },
      ],
    };
    const second = take(await f.propose(bad));
    assert.equal(second.validation, "invalid");
    assert.equal(second.version, 2);
    assert.equal((await f.service.list(context(), CASE)).ok, true);
    assert.equal(await f.count("report_drafts"), 2);
  } finally {
    await f.dispose();
  }
});
test("prepared/uncertain/expired projections and foreign query/context references are invalid", async () => {
  const f = await setup();
  try {
    const captured = await f.capture({ released: false });
    assert.equal(
      take(await f.propose(captured.candidate)).validation,
      "invalid",
    );
    take(
      await f.db.write(system(), (tx) =>
        f.cases.atomic.releaseInTx(tx, system(), {
          runId: f.run.id,
          projectionIds: captured.projections.map((v) => v.id),
          outcome: "uncertain",
        }),
      ),
    );
    assert.equal(
      take(await f.propose(captured.candidate)).validation,
      "invalid",
    );
    const candidate = {
      ...captured.candidate,
      facts: [
        {
          ...captured.candidate.facts[0]!,
          queryIds: [f.ids.next()],
          contextRefs: [{ contextId: f.ids.next(), version: 1 }],
        },
      ],
    };
    const invalid = take(await f.propose(candidate));
    assert.equal(invalid.validation, "invalid");
    assert.ok(invalid.validationIssues.length >= 3);
    take(
      await f.db.write(system(), (tx) => {
        tx.run(
          "UPDATE evidence_projections SET state='released',availability='expired' WHERE run_id=?",
          [f.run.id],
        );
        return ok(undefined);
      }),
    );
    assert.equal(
      take(await f.propose(captured.candidate)).validation,
      "invalid",
    );
  } finally {
    await f.dispose();
  }
});
test("forged trusted snapshots, malformed candidates and wrong actors never save a report", async () => {
  const f = await setup();
  try {
    const { candidate } = await f.capture();
    error(
      await f.db.write(system(), (tx) => {
        const view = take(f.cases.atomic.inspectRunInTx(tx, system(), f.run));
        view.projections = [];
        return f.service.proposeInTx(tx, system(), {
          candidate,
          validationInput: { view, contexts: [] },
        });
      }),
      "REVISION_CONFLICT",
    );
    error(
      await f.propose({ ...candidate, question: "替换调查问题" }),
      "VALIDATION_FAILED",
    );
    error(
      await f.propose({
        ...candidate,
        password: "not allowed",
      } as ReportCandidate),
      "INVALID_INPUT",
    );
    error(
      await f.db.write(context(), (tx) =>
        f.service.proposeInTx(tx, context(), {
          candidate,
          validationInput: {
            view: take(f.cases.atomic.inspectRunInTx(tx, context(), f.run)),
            contexts: [],
          },
        }),
      ),
      "FORBIDDEN",
    );
    const stranger = {
      ...context(),
      actor: { ...context().actor, principalId: f.ids.next() },
    };
    error(await f.service.list(stranger, CASE), "FORBIDDEN");
    assert.equal(await f.count("report_drafts"), 0);
  } finally {
    await f.dispose();
  }
});
test("partial explanation and unverified background require review without pretending to prove semantics", async () => {
  const f = await setup(true);
  try {
    const { candidate } = await f.capture({
      coverage: {
        queryCompleteness: "partial",
        collectionCoverage: "unknown",
        reasons: ["source gap"],
      },
    });
    candidate.facts[0]!.queryIds = [];
    candidate.facts[0]!.contextRefs = [
      {
        contextId: f.initialInput.contexts[0]!.id,
        version: f.initialInput.contexts[0]!.version,
      },
    ];
    const report = take(await f.propose(candidate));
    assert.equal(report.validation, "needs_review");
    assert.equal(report.review, "unreviewed");
    assert.ok(report.validationIssues.length >= 2);
  } finally {
    await f.dispose();
  }
});
test("assessment and explicit completion are atomic, immutable and survive a database reopen", async () => {
  const f = await setup();
  let reopened: Awaited<ReturnType<typeof createStorage>> | undefined;
  try {
    const { candidate } = await f.capture();
    candidate.followups = [
      { question: "核实操作者", suggestedAction: "联系负责人" },
    ];
    take(await f.propose(candidate));
    const sealed = await f.seal();
    const complete = () =>
      f.db.write(system(), (tx) => {
        const assessment = take(f.service.assessInTx(tx, system(), f.run.id));
        return f.service.finalizeInTx(tx, system(), {
          run: f.run,
          context: f.resultContext,
          decision: { terminalState: "succeeded", reason: "已完成有限调查" },
          manifestHash: sealed.manifestHash,
          assessment,
        });
      });
    const first = take(await complete()),
      second = take(await complete());
    assert.deepEqual(first, second);
    assert.equal(first.review, "unreviewed");
    assert.equal(first.mainEvidence.length, 1);
    assert.equal(await f.count("followups"), 1);
    error(
      await f.db.write(system(), (tx) =>
        f.service.finalizeInTx(tx, system(), {
          run: f.run,
          context: f.resultContext,
          decision: { terminalState: "cancelled", reason: "不同完成内容" },
          manifestHash: sealed.manifestHash,
          assessment: take(f.service.assessInTx(tx, system(), f.run.id)),
        }),
      ),
      "CONFLICT",
    );
    await f.close();
    reopened = await createStorage(f.storeDeps);
    const storage = take(reopened),
      reader = createResultPackageReader({ anchors: createReportAnchors() });
    assert.deepEqual(
      take(
        take(
          await storage.db.read(system(), (tx) =>
            reader.getInTx(tx, system(), { requestId: f.requestId }),
          ),
        ),
      ),
      first,
    );
  } finally {
    if (reopened?.ok) await reopened.value.close();
    await f.dispose();
  }
});
test("invalid success rolls back; cancellation comes only from CompletionDecision and does not change jobs", async () => {
  const f = await setup();
  try {
    const { candidate } = await f.capture({ released: false });
    take(await f.propose(candidate));
    const sealed = await f.seal();
    const assessment = take(
      await f.db.write(system(), (tx) =>
        f.service.assessInTx(tx, system(), f.run.id),
      ),
    );
    error(
      await f.db.write(system(), (tx) =>
        f.service.finalizeInTx(tx, system(), {
          run: f.run,
          context: f.resultContext,
          decision: { terminalState: "succeeded", reason: "不能成功" },
          manifestHash: sealed.manifestHash,
          assessment,
        }),
      ),
      "VALIDATION_FAILED",
    );
    assert.equal(await f.count("result_packages"), 0);
    const cancelled = take(
      await f.db.write(system(), (tx) =>
        f.service.finalizeInTx(tx, system(), {
          run: f.run,
          context: f.resultContext,
          decision: { terminalState: "cancelled", reason: "协调者核实取消" },
          manifestHash: sealed.manifestHash,
          assessment,
        }),
      ),
    );
    assert.equal(cancelled.terminalState, "cancelled");
    assert.deepEqual(cancelled.mainEvidence, []);
    assert.equal(
      take(
        await f.db.read(context(), (tx) =>
          tx.get<{ state: string }>("SELECT state FROM jobs WHERE id=?", [
            f.run.jobId,
          ])!,
        ),
      ).state,
      "running",
    );
  } finally {
    await f.dispose();
  }
});
test("outer transaction failure rolls back report, events, result and generated followups", async () => {
  const f = await setup();
  try {
    const { candidate } = await f.capture();
    candidate.followups = [{ question: "核查", suggestedAction: "确认" }];
    const before = await f.count("domain_events");
    error(
      await f.db.write(system(), (tx) => {
        const view = take(f.cases.atomic.inspectRunInTx(tx, system(), f.run));
        take(
          f.service.proposeInTx(tx, system(), {
            candidate,
            validationInput: { view, contexts: [] },
          }),
        );
        const sealed = take(
          f.cases.atomic.sealInTx(tx, system(), {
            runId: f.run.id,
            metadata: {
              initialInput: f.initialInput,
              profileVersion: f.run.profileVersion,
              mappingVersion: "synthetic",
              steps: [],
            },
          }),
        );
        take(
          f.service.finalizeInTx(tx, system(), {
            run: f.run,
            context: f.resultContext,
            decision: { terminalState: "succeeded", reason: "有限回答" },
            manifestHash: sealed.manifestHash,
            assessment: take(f.service.assessInTx(tx, system(), f.run.id)),
          }),
        );
        return fail("CONFLICT", "合成外层失败");
      }),
      "CONFLICT",
    );
    for (const table of [
      "report_drafts",
      "result_packages",
      "followups",
      "case_run_manifests",
    ])
      assert.equal(await f.count(table), 0);
    assert.equal(await f.count("domain_events"), before);
  } finally {
    await f.dispose();
  }
});
test("human revision preserves old text, uses CAS and saves review without publishing", async () => {
  const f = await setup();
  try {
    const { candidate } = await f.capture(),
      original = take(await f.propose(candidate)),
      revision = await f.caseRevision();
    const revisedCandidate = {
      ...candidate,
      facts: [{ ...candidate.facts[0]!, text: "人工修订后的事实描述" }],
    };
    const revised = take(
      await f.service.review(context(), {
        reportId: original.id,
        expectedCaseRevision: revision,
        disposition: "revised",
        humanConclusion: "unknown",
        note: "人工仍需核实",
        revisedCandidate,
      }),
    );
    assert.notEqual(revised.id, original.id);
    assert.equal(revised.version, 2);
    assert.equal(revised.review, "revised");
    const records = take(await f.service.list(context(), CASE));
    assert.equal(records[0]!.candidate.facts[0]!.text, "观察到事件");
    assert.equal(await f.count("result_packages"), 0);
    assert.equal(await f.count("result_deliveries"), 0);
    error(
      await f.service.review(context(), {
        reportId: original.id,
        expectedCaseRevision: revision,
        disposition: "accepted",
        humanConclusion: "unknown",
        note: "旧版本",
      }),
      "REVISION_CONFLICT",
    );
    const actor = take(
      await f.db.read(context(), (tx) =>
        tx.get<{ author_id: string }>("SELECT author_id FROM reviews")!,
      ),
    );
    assert.equal(actor.author_id, PRINCIPAL);
  } finally {
    await f.dispose();
  }
});
test("explicit review publication preserves original terminal state and is version-idempotent", async () => {
  const f = await setup();
  try {
    const { candidate } = await f.capture(),
      report = take(await f.propose(candidate)),
      sealed = await f.seal();
    take(
      await f.db.write(system(), (tx) =>
        f.service.finalizeInTx(tx, system(), {
          run: f.run,
          context: f.resultContext,
          decision: { terminalState: "cancelled", reason: "由协调者取消" },
          manifestHash: sealed.manifestHash,
          assessment: take(f.service.assessInTx(tx, system(), f.run.id)),
        }),
      ),
    );
    take(
      await f.service.review(context(), {
        reportId: report.id,
        expectedCaseRevision: await f.caseRevision(),
        disposition: "accepted",
        humanConclusion: "confirmed_benign",
        note: "负责人确认维护活动",
      }),
    );
    const revision = await f.caseRevision();
    const publish = () =>
      f.db.write(system(), (tx) =>
        f.service.publishReviewedInTx(tx, system(), {
          context: f.resultContext,
          reportId: report.id,
          expectedCaseRevision: revision,
          expectedResultVersion: 1,
        }),
      );
    const first = take(await publish());
    assert.equal(first.terminalState, "cancelled");
    assert.equal(first.resultVersion, 2);
    assert.deepEqual(take(await publish()), first);
    assert.equal(await f.count("result_packages"), 2);
    assert.equal(await f.count("result_deliveries"), 0);
  } finally {
    await f.dispose();
  }
});
test("human followups use revision CAS; evidence associations never become observed notes", async () => {
  const f = await setup();
  try {
    const captured = await f.capture();
    await f.attach(captured.refs);
    const item = {
      id: f.ids.next(),
      caseId: CASE,
      revision: 1,
      state: "completed" as const,
      question: "核查维护",
      suggestedAction: "联系负责人",
      note: "负责人说已处理",
      evidenceRefs: captured.refs,
    };
    const saved = take(
      await f.service.putFollowup(context(), { item, expectedRevision: 0 }),
    );
    const note = take(
      await f.db.read(context(), (tx) =>
        tx.get<{ source: string; author_id: string }>(
          "SELECT source,author_id FROM response_notes",
        )!,
      ),
    );
    assert.equal(note.source, "human_statement");
    assert.equal(note.author_id, PRINCIPAL);
    error(
      await f.service.putFollowup(context(), {
        item: { ...saved, note: "旧版本" },
        expectedRevision: 0,
      }),
      "REVISION_CONFLICT",
    );
    const stranger = {
      ...item,
      id: f.ids.next(),
      evidenceRefs: [{ evidenceId: f.ids.next(), version: 1 }],
    };
    error(
      await f.service.putFollowup(context(), {
        item: stranger,
        expectedRevision: 0,
      }),
      "FORBIDDEN",
    );
  } finally {
    await f.dispose();
  }
});
test("followup pagination sorts null deadlines last and binds filters and identity", async () => {
  const f = await setup();
  try {
    for (let i = 0; i < 4; i++)
      take(
        await f.service.putFollowup(context(), {
          expectedRevision: 0,
          item: {
            id: f.ids.next(),
            caseId: CASE,
            revision: 1,
            state: "open",
            question: "核查" + i,
            suggestedAction: "确认",
            evidenceRefs: [],
            ...(i < 3 ? { dueAt: `2026-10-24T0${i}:00:00.000Z` } : {}),
          },
        }),
      );
    const first = take(
      await f.service.searchFollowups(context(), {
        state: "open",
        page: { limit: 2 },
      }),
    );
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor);
    const next = take(
      await f.service.searchFollowups(context(), {
        state: "open",
        page: { limit: 2, cursor: first.nextCursor },
      }),
    );
    assert.equal(next.items.length, 2);
    assert.equal(next.items[1]!.dueAt, undefined);
    error(
      await f.service.searchFollowups(context(), {
        state: "waiting",
        page: { limit: 2, cursor: first.nextCursor },
      }),
      "CURSOR_INVALID",
    );
  } finally {
    await f.dispose();
  }
});
test("exports page all evidence, preserve review state, redact structured secrets and escape Markdown fences", async () => {
  const f = await setup();
  try {
    const a = await f.capture({
        count: 50,
        fields: {
          api_token: "synthetic-secret",
          text: "~~~\n![remote](https://example.invalid/x)",
        },
      }),
      b = await f.capture({ count: 5 });
    await f.attach([...a.refs, ...b.refs]);
    const revision = await f.caseRevision();
    const json = take(
        await f.service.export(context(), {
          caseId: CASE,
          caseRevision: revision,
          format: "json",
        }),
      ),
      payload = JSON.parse(json.text);
    assert.equal(payload.evidence.length, 55);
    assert.ok(payload.redactedPaths.length >= 50);
    assert.ok(!json.text.includes("synthetic-secret"));
    const markdown = take(
      await f.service.export(context(), {
        caseId: CASE,
        caseRevision: revision,
        format: "markdown",
      }),
    );
    assert.ok(markdown.text.includes("~~~~json"));
    assert.ok(!markdown.filename.includes("/"));
    const encoded = markdown.text.slice(
      markdown.text.indexOf("\n", markdown.text.indexOf("~~~~json")) + 1,
      markdown.text.lastIndexOf("~~~~"),
    );
    assert.deepEqual(JSON.parse(encoded), payload);
    error(
      await f.service.export(context(), {
        caseId: CASE,
        caseRevision: revision - 1,
        format: "json",
      }),
      "REVISION_CONFLICT",
    );
  } finally {
    await f.dispose();
  }
});
test("no-run terminal results remain explicit and deny forged associations or success", async () => {
  const f = await setup();
  try {
    const { runId: _runId, ...ctx } = f.resultContext;
    error(
      await f.db.write(system(), (tx) =>
        f.service.terminalWithoutRunInTx(tx, system(), {
          context: ctx,
          decision: { terminalState: "succeeded", reason: "不能伪造调查" },
        }),
      ),
      "INVALID_INPUT",
    );
    error(
      await f.db.write(system(), (tx) =>
        f.service.terminalWithoutRunInTx(tx, system(), {
          context: ctx,
          decision: {
            terminalState: "cancelled",
            reason: "不能隐藏已创建的轮次",
          },
        }),
      ),
      "FORBIDDEN",
    );
    // Synthetic queued request with no run; the identity rows remain owned by the coordinator fixture.
    const requestId = f.ids.next(),
      jobId = f.ids.next();
    take(
      await f.db.write(system(), (tx) => {
        tx.run(
          `INSERT INTO investigation_requests(id,origin,state,principal_id,connection_id,question,seed_refs_json,case_id,job_id,missing_fields_json,created_at,expires_at)
      SELECT ?,origin,state,principal_id,connection_id,question,seed_refs_json,case_id,?,missing_fields_json,created_at,expires_at FROM investigation_requests WHERE id=?`,
          [requestId, jobId, f.requestId],
        );
        tx.run(
          "INSERT INTO jobs(id,request_id,case_id,origin,state,revision,expires_at,created_at,updated_at) VALUES(?,?,?,'client_user','queued',1,?,?,?)",
          [
            jobId,
            requestId,
            CASE,
            f.run.expiresAt,
            f.clock.now(),
            f.clock.now(),
          ],
        );
        return ok(undefined);
      }),
    );
    const input = {
      context: { ...ctx, requestId, jobId },
      decision: { terminalState: "cancelled" as const, reason: "排队时取消" },
    };
    const value = take(
      await f.db.write(system(), (tx) =>
        f.service.terminalWithoutRunInTx(tx, system(), input),
      ),
    );
    assert.equal(value.runId, undefined);
    assert.deepEqual(
      take(
        await f.db.write(system(), (tx) =>
          f.service.terminalWithoutRunInTx(tx, system(), input),
        ),
      ),
      value,
    );
    error(
      await f.db.write(system(), (tx) =>
        f.service.terminalWithoutRunInTx(tx, system(), {
          ...input,
          context: { ...input.context, jobId: f.ids.next() },
        }),
      ),
      "FORBIDDEN",
    );
  } finally {
    await f.dispose();
  }
});

test("zero-result queries are valid references without inventing evidence", async () => {
  const f = await setup();
  try {
    const captured = await f.capture({ count: 0 });
    const candidate: ReportCandidate = {
      ...captured.candidate,
      classification: "insufficient_evidence",
      gaps: ["本次查询无匹配，不证明全部活动不存在"],
      facts: [
        {
          text: "所列查询在指定范围内无匹配",
          evidenceRefs: [],
          queryIds: [captured.queryId],
          contextRefs: [],
        },
      ],
    };
    const report = take(await f.propose(candidate));
    assert.equal(report.validation, "valid");
    assert.equal(await f.count("evidence_versions"), 0);
  } finally {
    await f.dispose();
  }
});
test("missing proposals stay missing and stale assessments cannot complete a newer candidate", async () => {
  const f = await setup();
  try {
    assert.deepEqual(
      take(
        await f.db.write(system(), (tx) =>
          f.service.assessInTx(tx, system(), f.run.id),
        ),
      ),
      { validation: "missing" },
    );
    const { candidate } = await f.capture();
    take(await f.propose(candidate));
    const old = take(
      await f.db.write(system(), (tx) =>
        f.service.assessInTx(tx, system(), f.run.id),
      ),
    );
    take(await f.propose({ ...candidate, gaps: ["新增核查事项"] }));
    const sealed = await f.seal();
    error(
      await f.db.write(system(), (tx) =>
        f.service.finalizeInTx(tx, system(), {
          run: f.run,
          context: f.resultContext,
          decision: { terminalState: "succeeded", reason: "有限回答" },
          manifestHash: sealed.manifestHash,
          assessment: old,
        }),
      ),
      "REVISION_CONFLICT",
    );
    assert.equal(await f.count("result_packages"), 0);
  } finally {
    await f.dispose();
  }
});
