import assert from "node:assert/strict";
import {
  canonicalJson,
  ok,
  type AnalysisRun,
  type CallContext,
  type Coverage,
  type FrozenRunInput,
  type JsonObject,
  type ReportCandidate,
  type Result,
  type ResultContext,
} from "@campussec/contracts";
import {
  CASE,
  CONNECTION,
  PRINCIPAL,
  SPACE,
  context,
  scope,
} from "@campussec/testkit";
import { createCaseService } from "@campussec/core/cases";
import {
  createReportService,
  createResultPackageReader,
} from "@campussec/core/reports";
import { PROFILE_MANIFEST } from "@campussec/investigation-profile";
import { seedCase, storageFixture } from "../../../../tests/support/storage.js";
export function system(): CallContext {
  const ctx = context();
  return { ...ctx, actor: { ...ctx.actor, role: "system" } };
}
export function take<T>(r: Result<T>): T {
  assert.ok(r.ok, r.ok ? "" : r.error.code);
  return r.value;
}
export function error(r: Result<unknown>, code?: string) {
  assert.ok(!r.ok, "unexpected success");
  if (code) assert.equal(r.error.code, code);
}

export async function setup(withContext = false) {
  const f = await storageFixture(),
    cases = createCaseService(f);
  take(
    await f.db.write(context(), (tx) => {
      seedCase(tx);
      return ok(undefined);
    }),
  );
  if (withContext)
    take(
      await cases.service.putContext(context(), {
        caseId: CASE,
        expectedRevision: 1,
        context: {
          caseId: CASE,
          connectionId: CONNECTION,
          agentIds: ["001"],
          text: "维护说明，尚未核实",
          from: scope.from,
          to: scope.to,
          sourceLabel: "人工录入",
          verification: "unverified",
        },
      }),
    );
  const before = take(
    await f.db.read(context(), (tx) =>
      cases.atomic.getInTx(tx, context(), CASE),
    ),
  );
  const current = take(before);
  const run: AnalysisRun = {
    id: f.ids.next(),
    jobId: f.ids.next(),
    caseId: CASE,
    baseRevision: current.revision + 1,
    scope,
    connectionGeneration: 1,
    identityEpoch: 1,
    profileVersion: PROFILE_MANIFEST.version,
    toolEpoch: 1,
    expiresAt: "2026-10-23T01:05:00.000Z",
  };
  const requestId = f.ids.next();
  let initialInput!: FrozenRunInput;
  take(
    await f.db.write(system(), (tx) => {
      const changed = cases.atomic.setStatusInTx(tx, system(), {
        caseId: CASE,
        expectedRevision: current.revision,
        status: "investigating",
        reason: "合成调查",
      });
      if (!changed.ok) return changed;
      tx.run(
        `INSERT INTO investigation_requests(id,origin,state,principal_id,connection_id,question,requested_scope_json,
      effective_scope_json,seed_refs_json,case_id,job_id,missing_fields_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          requestId,
          "client_user",
          "accepted",
          PRINCIPAL,
          CONNECTION,
          "调查问题",
          canonicalJson(scope),
          canonicalJson(scope),
          "[]",
          CASE,
          run.jobId,
          "[]",
          f.clock.now(),
          run.expiresAt,
        ],
      );
      tx.run(
        "INSERT INTO jobs(id,request_id,case_id,run_id,origin,state,revision,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [
          run.jobId,
          requestId,
          CASE,
          run.id,
          "client_user",
          "running",
          1,
          run.expiresAt,
          f.clock.now(),
          f.clock.now(),
        ],
      );
      tx.run(
        `INSERT INTO analysis_runs(id,job_id,case_id,base_revision,scope_json,connection_generation,identity_epoch,
      profile_version,tool_epoch,expires_at,initial_input_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [
          run.id,
          run.jobId,
          CASE,
          run.baseRevision,
          canonicalJson(scope),
          1,
          1,
          run.profileVersion,
          1,
          run.expiresAt,
          "{}",
        ],
      );
      const initialized = cases.atomic.initializeRunInTx(tx, system(), {
        run,
        seedRefs: [],
        question: "调查问题",
        capabilities: [],
      });
      if (!initialized.ok) return initialized;
      initialInput = initialized.value;
      tx.run("UPDATE analysis_runs SET initial_input_json=? WHERE id=?", [
        canonicalJson(initialInput),
        run.id,
      ]);
      return ok(undefined);
    }),
  );
  const deps = { ...f, cases: cases.service, casesAtomic: cases.atomic },
    service = createReportService(deps),
    reader = createResultPackageReader(f);
  const resultContext: ResultContext = {
    requestId,
    jobId: run.jobId,
    caseId: CASE,
    runId: run.id,
    scope,
  };
  async function capture(
    options: {
      released?: boolean;
      count?: number;
      coverage?: Partial<Coverage>;
      fields?: JsonObject;
    } = {},
  ) {
    const queryId = f.ids.next(),
      count = options.count ?? 1;
    const refs = take(
      await f.db.write(system(), (tx) =>
        cases.atomic.captureInTx(tx, system(), {
          runId: run.id,
          connectionId: CONNECTION,
          query: {
            kind: "alerts",
            scope,
            fixedUpper: scope.to,
            filter: {},
            page: { limit: 50 },
          },
          page: {
            status:
              options.coverage?.queryCompleteness === "partial"
                ? "partial"
                : "ok",
            queryId,
            pageId: f.ids.next(),
            pageOrdinal: 0,
            platformAttempts: 1,
            warnings: [],
            records: Array.from({ length: count }, () => ({
              source: {
                platformInstanceId: SPACE,
                kind: "index_document",
                index: "synthetic-alerts",
                documentId: f.ids.next(),
              },
              kind: "alert",
              agentId: "001",
              observedAt: "2026-10-23T00:45:00.000Z",
              timeQuality: "source",
              retrievedAt: f.clock.now(),
              fields: {
                "agent.id": "001",
                "rule.id": "100",
                text: "合成证据",
                ...options.fields,
              },
            })),
            coverage: {
              requestedScope: scope,
              effectiveScope: scope,
              queryCompleteness: "complete",
              collectionCoverage: "known",
              sourceTypes: ["synthetic"],
              reasons: [],
              retrievedAt: f.clock.now(),
              returned: count,
              ...options.coverage,
            },
          },
        }),
      ),
    );
    const projections = take(
      await f.db.write(system(), (tx) =>
        cases.atomic.projectInTx(tx, system(), {
          runId: run.id,
          refs,
          fieldNames: ["agent.id", "rule.id", "text"],
        }),
      ),
    );
    if (options.released !== false)
      take(
        await f.db.write(system(), (tx) =>
          cases.atomic.releaseInTx(tx, system(), {
            runId: run.id,
            projectionIds: projections.map((p) => p.id),
            outcome: "released",
          }),
        ),
      );
    const candidate: ReportCandidate = {
      caseId: CASE,
      runId: run.id,
      question: "调查问题",
      facts: projections
        .slice(0, 1)
        .map((p) => ({
          text: "观察到事件",
          evidenceRefs: [{ ...p.ref, projectionId: p.id }],
          queryIds: [queryId],
          contextRefs: [],
        })),
      analysis: [],
      conflicts: [],
      gaps: [],
      classification: "explained",
      stopReason: "answered_with_limits",
      followups: [],
    };
    return { queryId, refs, projections, candidate };
  }
  async function propose(candidate: ReportCandidate) {
    return f.db.write(system(), (tx) => {
      const view = cases.atomic.inspectRunInTx(tx, system(), run);
      if (!view.ok) return view;
      return service.proposeInTx(tx, system(), {
        candidate,
        validationInput: {
          view: view.value,
          contexts: initialInput.contexts.map((context) => ({
            ref: { contextId: context.id, version: context.version },
            context,
          })),
        },
      });
    });
  }
  async function seal() {
    return take(
      await f.db.write(system(), (tx) =>
        cases.atomic.sealInTx(tx, system(), {
          runId: run.id,
          metadata: {
            initialInput,
            profileVersion: run.profileVersion,
            mappingVersion: "synthetic",
            steps: [],
          },
        }),
      ),
    );
  }
  async function caseRevision() {
    return take(
      take(
        await f.db.read(context(), (tx) =>
          cases.atomic.getInTx(tx, context(), CASE),
        ),
      ),
    ).revision;
  }
  async function attach(refs: Awaited<ReturnType<typeof capture>>["refs"]) {
    return take(
      await f.db.write(system(), (tx) => {
        const found = cases.atomic.getInTx(tx, system(), CASE);
        if (!found.ok) return found;
        return cases.atomic.attachInTx(tx, system(), {
          caseId: CASE,
          refs,
          expectedRevision: found.value.revision,
          reason: "附入合成材料",
        });
      }),
    );
  }
  return {
    ...f,
    storeDeps: f.deps,
    cases,
    service,
    reader,
    run,
    initialInput,
    resultContext,
    requestId,
    capture,
    propose,
    seal,
    caseRevision,
    attach,
    async count(table: string) {
      return take(
        await f.db.read(
          context(),
          (tx) => tx.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!,
        ),
      ).n;
    },
  };
}
