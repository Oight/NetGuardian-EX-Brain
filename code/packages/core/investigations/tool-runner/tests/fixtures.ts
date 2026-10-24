import assert from "node:assert/strict";
import {
  canonicalJson,
  ok,
  type CallContext,
  type CapabilityName,
  type EvidenceToolEnvelope,
  type JsonObject,
  type PlatformPage,
  type PlatformQuery,
  type ReportCandidate,
  type Result,
  type ToolReply,
  type WriteTx,
} from "@campussec/contracts";
import {
  context,
  createScriptedPlatformQuery,
  SPACE,
} from "@campussec/testkit";
import { createRunBudget } from "@campussec/core/requests/budgets";
import { createInvestigationTools } from "@campussec/core/investigations/tools";
import {
  setup as reportFixture,
  system,
  take,
  error,
} from "../../../reports/tests/fixtures.js";
export { take, error, system };
const names: CapabilityName[] = [
  "alerts",
  "authentication_events",
  "inventory_os",
  "inventory_hardware",
  "inventory_packages",
  "inventory_processes",
  "inventory_ports",
  "fim_events",
  "sca",
  "vulnerabilities",
  "stable_alert_pagination",
];
export async function setup() {
  const f = await reportFixture(true);
  const initial = {
    ...f.initialInput,
    capabilities: names.map((name) => ({
      name,
      state: "available" as const,
      checkedAt: f.clock.now(),
      evidence: "显式合成能力",
      endpointKind: "indexer" as const,
    })),
  };
  const profile = take(
    await f.service.prepare(system(), {
      run: f.run,
      initialInput: initial,
      seedProjections: [],
    }),
  );
  take(
    await f.db.write(system(), (tx) => {
      tx.run(
        "UPDATE analysis_runs SET initial_input_json=?,prepared_profile_json=? WHERE id=?",
        [canonicalJson(initial), canonicalJson(profile), f.run.id],
      );
      return ok(undefined);
    }),
  );
  const platform = createScriptedPlatformQuery(),
    budget = createRunBudget(f);
  const deps = {
    ...f,
    budget: budget.budget,
    budgetAtomic: budget.atomic,
    query: platform.port,
    casesAtomic: f.cases.atomic,
    proposals: f.service,
  };
  const ctx: CallContext = {
      ...context(),
      actor: { ...context().actor, role: "evidence", runId: f.run.id },
    },
    binding = f.ids.next();
  const tools = createInvestigationTools(deps);
  const input = (
    callId: string,
    toolName = "search_related_alerts",
    args: JsonObject = { agentIds: ["001"] },
  ) => ({ transportBindingId: binding, callId, toolName, arguments: args });
  const invoke = (callId: string, toolName?: string, args?: JsonObject) =>
    tools.invoke(ctx, input(callId, toolName, args));
  async function write(work: (tx: WriteTx) => void) {
    take(
      await f.db.write(system(), (tx) => {
        work(tx);
        return ok(undefined);
      }),
    );
  }
  const view = async () =>
    take(
      take(
        await f.db.read(ctx, (tx) =>
          f.cases.atomic.inspectRunInTx(tx, ctx, f.run),
        ),
      ),
    );
  const ack = (
    callId: string,
    outcome: "released" | "uncertain" = "released",
  ) =>
    tools.acknowledgeReply(ctx, {
      transportBindingId: binding,
      callId,
      outcome,
    });
  function page(
    query: PlatformQuery,
    options: {
      count?: number;
      fields?: JsonObject;
      attempts?: number;
      documentId?: string;
    } = {},
  ): PlatformPage {
    const count = options.count ?? 1;
    return {
      status: "ok",
      queryId: f.ids.next(),
      pageId: f.ids.next(),
      pageOrdinal: 0,
      platformAttempts: options.attempts ?? 1,
      warnings: [],
      records: Array.from({ length: count }, () => ({
        source: {
          platformInstanceId: SPACE,
          kind: "index_document" as const,
          index: "synthetic",
          documentId: options.documentId ?? f.ids.next(),
        },
        kind: (
          {
            alerts: "alert",
            authentication: "authentication",
            inventory: "inventory",
            file_changes: "fim",
            findings: "finding",
          } as const
        )[query.kind],
        agentId: "001",
        observedAt: "2026-10-23T00:45:00.000Z",
        timeQuality: "source" as const,
        retrievedAt: f.clock.now(),
        fields: {
          "agent.id": "001",
          "rule.id": "100",
          text: "合成事件",
          ...options.fields,
        },
      })),
      coverage: {
        requestedScope: query.scope,
        effectiveScope: query.scope,
        queryCompleteness: "complete",
        collectionCoverage: "known",
        sourceTypes: ["synthetic"],
        reasons: [],
        retrievedAt: f.clock.now(),
        returned: count,
      },
    };
  }
  function queue(options: Parameters<typeof page>[1] = {}) {
    platform.query.push(async ({ input, call }) => {
      const reserved = await call.beforeAttempt();
      if (!reserved.ok) return reserved;
      return ok(page(input, options));
    });
  }
  function candidate(reply?: EvidenceToolEnvelope): ReportCandidate {
    return {
      caseId: f.run.caseId,
      runId: f.run.id,
      question: initial.question,
      facts: reply?.records.length
        ? [
            {
              text: "观察到事件",
              evidenceRefs: reply.records.map((r) => r.ref),
              queryIds: reply.queryId ? [reply.queryId] : [],
              contextRefs: [],
            },
          ]
        : [],
      analysis: [],
      conflicts: [],
      gaps: ["仅合成材料"],
      classification: reply?.records.length
        ? "explained"
        : "insufficient_evidence",
      stopReason: "answered_with_limits",
      followups: [],
    };
  }
  return {
    ...f,
    initial,
    profile,
    ctx,
    binding,
    tools,
    deps,
    platform,
    budget,
    input,
    invoke,
    write,
    view,
    ack,
    page,
    queue,
    candidate,
  };
}
export function body(result: Result<ToolReply>): EvidenceToolEnvelope {
  const reply = take(result);
  assert.deepEqual(JSON.parse(reply.text), reply.structured);
  assert.ok(Buffer.byteLength(reply.text) <= 16384);
  return JSON.parse(reply.text);
}
export const json = (value: unknown): JsonObject =>
  JSON.parse(canonicalJson(value));
