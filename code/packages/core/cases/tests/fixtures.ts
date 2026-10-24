import assert from "node:assert/strict";
import {
  canonicalJson,
  ok,
  type AnalysisRun,
  type PlatformPage,
  type PlatformQuery,
  type Result,
  type SourceRecord,
} from "@campussec/contracts";
import {
  context,
  CONNECTION,
  SPACE,
  scope,
  PRINCIPAL,
} from "@campussec/testkit";
import { storageFixture } from "../../../../tests/support/storage.js";
import { createCaseService } from "../index.js";
export function take<T>(result: Result<T>): T {
  assert.ok(result.ok, result.ok ? "" : result.error.code);
  return result.value;
}
export async function fixture() {
  const f = await storageFixture();
  take(
    await f.db.write(context(), (tx) => {
      tx.run(
        "INSERT INTO connections(id,platform_instance_id,display_name,generation,alerts_pattern,mapping_version,principal_fingerprint,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        [
          CONNECTION,
          SPACE,
          "合成连接",
          1,
          "wazuh-alerts-*",
          "wazuh-alerts-v1",
          "synthetic",
          f.clock.now(),
        ],
      );
      return ok(undefined);
    }),
  );
  const cases = createCaseService(f);
  const create = (title = "案件") =>
    cases.service.create(context(), { title, scope, seedRefs: [] }).then(take);
  return { ...f, ...cases, create };
}
export function captureInput(
  f: {
    ids: {
      next(): string;
    };
    clock: {
      now(): string;
    };
  },
  caseId?: string,
  custom: Partial<PlatformPage> = {},
  records?: SourceRecord[],
) {
  const query: PlatformQuery = {
    kind: "alerts",
    scope,
    filter: {},
    fixedUpper: scope.to,
    page: { limit: 50 },
  };
  const rows = records ?? [
    {
      source: {
        platformInstanceId: SPACE,
        kind: "index_document",
        index: "wazuh-alerts-synthetic",
        documentId: "event-1",
      },
      kind: "alert",
      agentId: "001",
      observedAt: "2026-10-23T00:45:00.000Z",
      timeQuality: "source",
      retrievedAt: f.clock.now(),
      fields: {
        "agent.id": "001",
        "rule.id": "100",
        "rule.level": 5,
        text: "合成材料",
      },
    },
  ];
  const page: PlatformPage = {
    status: "ok",
    queryId: f.ids.next(),
    pageId: f.ids.next(),
    pageOrdinal: 0,
    records: rows,
    coverage: {
      requestedScope: scope,
      effectiveScope: scope,
      queryCompleteness: "complete",
      collectionCoverage: "unknown",
      sourceTypes: ["wazuh"],
      reasons: [],
      retrievedAt: f.clock.now(),
      returned: custom.records?.length ?? rows.length,
    },
    warnings: [],
    platformAttempts: 1,
    ...custom,
  };
  return {
    ...(caseId ? { caseId } : {}),
    connectionId: CONNECTION,
    query,
    page,
  };
}
export async function runFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  caseId: string,
): Promise<AnalysisRun> {
  return take(
    await f.db.write(context(), (tx) => {
      const before = take(f.atomic.getInTx(tx, context(), caseId));
      const c = take(
        f.atomic.setStatusInTx(tx, context(), {
          caseId,
          expectedRevision: before.revision,
          status: "investigating",
          reason: "合成调查启动",
        }),
      );
      const requestId = f.ids.next(),
        jobId = f.ids.next(),
        id = f.ids.next();
      tx.run(
        "INSERT INTO investigation_requests(id,origin,state,principal_id,connection_id,question,seed_refs_json,missing_fields_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [
          requestId,
          "client_user",
          "accepted",
          PRINCIPAL,
          CONNECTION,
          "问题",
          "[]",
          "[]",
          f.clock.now(),
          "2026-10-24T00:00:00.000Z",
        ],
      );
      tx.run(
        "INSERT INTO jobs(id,request_id,case_id,run_id,origin,state,revision,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [
          jobId,
          requestId,
          caseId,
          id,
          "client_user",
          "running",
          1,
          "2026-10-24T00:00:00.000Z",
          f.clock.now(),
          f.clock.now(),
        ],
      );
      const run: AnalysisRun = {
        id,
        jobId,
        caseId,
        baseRevision: c.revision,
        scope,
        connectionGeneration: 1,
        identityEpoch: 1,
        profileVersion: "v1",
        toolEpoch: 1,
        expiresAt: "2026-10-24T00:00:00.000Z",
      };
      tx.run(
        "INSERT INTO analysis_runs(id,job_id,case_id,base_revision,scope_json,connection_generation,identity_epoch,profile_version,tool_epoch,expires_at,initial_input_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        [
          id,
          jobId,
          caseId,
          c.revision,
          canonicalJson(scope),
          1,
          1,
          "v1",
          1,
          run.expiresAt,
          "{}",
        ],
      );
      return ok(run);
    }),
  );
}
