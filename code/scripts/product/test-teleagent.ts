/** Real pinned Go backend; scripted local model/review and synthetic upstream only. */
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
const { composeRuntime } = (await import(
  new URL("../../dist/apps/desktop/runtime/compose.js", import.meta.url).href
)) as typeof import("../../apps/desktop/runtime/compose.js");
import {
  ok,
  fail,
  type CallContext,
  type EvidenceToolEnvelope,
  type Result,
  type ReportCandidate,
} from "@campussec/contracts";
import { TELEAGENT_270 } from "@campussec/teleagent-bridge/execution/teleagent";

function take<T>(value: Result<T>): T {
  assert.ok(
    value.ok,
    value.ok ? "" : value.error.code + ": " + value.error.message,
  );
  return value.value;
}
type Obj = Record<string, any>;
function objects(value: unknown, depth = 0): Obj[] {
  if (depth > 8 || value === null) return [];
  if (typeof value === "string") {
    try {
      return objects(JSON.parse(value), depth + 1);
    } catch {
      return [];
    }
  }
  if (Array.isArray(value))
    return value.flatMap((item) => objects(item, depth + 1));
  if (typeof value !== "object") return [];
  const obj = value as Obj;
  return [
    obj,
    ...Object.values(obj).flatMap((item) => objects(item, depth + 1)),
  ];
}
const binaryPath = process.argv
  .find((a) => a.startsWith("--binary="))
  ?.slice(9);
if (!binaryPath)
  throw Error(
    "Supply --binary=<absolute path to the pinned TeleAgent 2.7.0 Go backend>",
  );
await mkdir(".local/teleagent-acceptance", { recursive: true });
const root = await mkdtemp(resolve(".local/teleagent-acceptance/run-"));
const checks: Record<string, boolean> = {};
const modelTools = new Set<string>();
const modelRounds: number[] = [];
let runtime:
  | Extract<Awaited<ReturnType<typeof composeRuntime>>, { ok: true }>["value"]
  | undefined;
let system: CallContext;
let modelCalls = 0,
  queryCalls = 0,
  cancellationModelEntered = false;
let handlerFailure: string | undefined;
const from = new Date(Date.now() - 1200000).toISOString();
const to = new Date(Date.now() - 600000).toISOString();
const timestamp = new Date(Date.parse(from) + 60000).toISOString();
const question = "合成后端工具链验证";
const report: Record<string, unknown> = {
  backendVersion: TELEAGENT_270.version,
  backendSha256: TELEAGENT_270.backendSha256,
  evidenceLevel: "real_teleagent_backend_scripted_model_synthetic_upstream",
  realModel: false,
  realWazuh: false,
  originalConversationDelivery: false,
  checks,
};
function stream(res: ServerResponse, delta: Obj, finish: string) {
  if (res.destroyed) return;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  for (const [part, reason] of [
    [delta, null],
    [{}, finish],
  ]) {
    res.write(
      "data: " +
        JSON.stringify({
          id: "chatcmpl-campussec-synthetic",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "synthetic-model",
          choices: [{ index: 0, delta: part, finish_reason: reason }],
          ...(reason
            ? {
                usage: {
                  prompt_tokens: 100,
                  completion_tokens: 30,
                  total_tokens: 130,
                },
              }
            : {}),
        }) +
        "\n\n",
    );
  }
  res.end("data: [DONE]\n\n");
}
const lab = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      assert.ok(size <= 1048576);
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Obj;
    if (req.url?.startsWith("/review/")) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          code: 0,
          data: { result: 1, reason: "synthetic acceptance review" },
        }),
      );
      return;
    }
    assert.ok(
      req.url?.endsWith("/chat/completions"),
      "Unexpected local endpoint",
    );
    modelCalls++;
    assert.ok(modelCalls <= 8, "Scripted model loop exceeded bound");
    const names: string[] = (body.tools ?? []).map(
      (t: Obj) => t.function?.name,
    );
    names.forEach((name) => modelTools.add(name));
    assert.ok(
      names.length > 0 && names.every((name) => /^campussec[_-]/.test(name)),
      "Native or foreign tools entered the dedicated model request",
    );
    const messages: Obj[] = body.messages;
    if (
      messages.some(
        (m) =>
          m.role === "user" &&
          JSON.stringify(m.content).includes("synthetic-cancel"),
      )
    ) {
      cancellationModelEntered = true;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const timer = setTimeout(() => res.end("data: [DONE]\n\n"), 15000);
      res.once("close", () => clearTimeout(timer));
      return;
    }
    const history = messages.filter((m) => m.role === "tool");
    modelRounds.push(history.length);
    const returned = history
      .flatMap((m) => objects(m.content))
      .filter(
        (v) => v.schemaVersion === "0.1.0" && Array.isArray(v.records),
      ) as EvidenceToolEnvelope[];
    const queries = returned.filter((v) => v.queryId && v.records.length);
    const findTool = (suffix: string) => {
      const matches = names.filter((name) => name.endsWith("_" + suffix));
      assert.equal(
        matches.length,
        1,
        "Required tool missing from actual TeleAgent model request",
      );
      return matches[0]!;
    };
    let name: string, args: Obj;
    if (history.length === 0) {
      name = findTool("get_case_context");
      args = {};
    } else if (queries.length === 0) {
      assert.ok(
        returned.some((v) => v.context?.question === question),
        "Actual case context did not return through TeleAgent",
      );
      name = findTool("search_related_alerts");
      args = { agentIds: ["001"], purpose: "根据实际上下文查询合成线索" };
    } else if (queries.length === 1) {
      name = findTool("search_related_alerts");
      args = {
        agentIds: ["001"],
        purpose: "依据首次实际返回的规则进一步核对",
        filter: {
          ruleIds: [String(queries[0]!.records[0]!.content["rule.id"])],
        },
      };
    } else if (history.length === 3) {
      assert.equal(queries.length, 2);
      const run = take(
        await runtime!.storage.db.read(system, (tx) =>
          tx.get<{ id: string; case_id: string }>(
            "SELECT id,case_id FROM analysis_runs ORDER BY rowid DESC LIMIT 1",
          ),
        ),
      )!;
      const candidate: ReportCandidate = {
        caseId: run.case_id,
        runId: run.id,
        question,
        facts: [
          {
            text: "两次受控查询实际交付了本轮合成材料",
            evidenceRefs: queries.map((v) => v.records[0]!.ref),
            queryIds: queries.map((v) => v.queryId!),
            contextRefs: [],
          },
        ],
        analysis: [],
        conflicts: [],
        gaps: ["仅为合成上游，不代表真实平台覆盖"],
        classification: "needs_investigation",
        stopReason: "answered_with_limits",
        followups: [
          { question: "人工核对", suggestedAction: "使用获授权的真实样本复核" },
        ],
      };
      name = findTool("propose_report");
      args = candidate;
    } else {
      assert.equal(history.length, 4);
      assert.ok(
        history.some((m) => objects(m.content).some((v) => v.status === "ok")),
      );
      stream(
        res,
        {
          role: "assistant",
          content: "合成后端验证完成，调查草案已经由实际工具提交。",
        },
        "stop",
      );
      return;
    }
    stream(
      res,
      {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_synthetic_" + modelCalls,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      "tool_calls",
    );
  } catch (error) {
    handlerFailure =
      error instanceof Error ? error.message : "Scripted model failure";
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
await new Promise<void>((resolve) => lab.listen(0, "127.0.0.1", resolve));
const address = lab.address();
assert.ok(address && typeof address !== "string");
const origin = "http://127.0.0.1:" + address.port;
try {
  runtime = take(
    await composeRuntime({
      dataDir: join(root, "product"),
      spaceId: randomUUID(),
      principalId: randomUUID(),
      identityEpoch: 1,
      protection: {
        available: () => true,
        encrypt: (text) => Buffer.from(text),
        decrypt: (bytes) => Buffer.from(bytes).toString("utf8"),
      }, // Explicit synthetic secret wrapping.
      backgroundEnabled: false,
      teleagent: {
        binaryPath,
        model: {
          baseUrl: origin + "/v1",
          modelId: "synthetic-model",
          apiKey: "synthetic-only",
        },
        review: {
          baseUrl: origin + "/review",
          accessKey: "synthetic-ak",
          secretKey: "synthetic-sk",
        },
      },
      http: {
        async request(req) {
          assert.ok(req.url.startsWith("https://synthetic-indexer.invalid/"));
          const input = JSON.parse(req.bodyText ?? "{}");
          const hits: unknown[] =
            input.size === 0
              ? []
              : [
                  {
                    _index: "wazuh-alerts-synthetic",
                    _id: "event-" + ++queryCalls,
                    _source: {
                      timestamp,
                      agent: { id: "001", name: "synthetic" },
                      rule: { id: "100", level: 7, description: "合成告警" },
                    },
                  },
                ];
          if (queryCalls === 2)
            assert.ok(JSON.stringify(input).includes("100"));
          return ok({
            status: 200,
            headers: {},
            bodyText: JSON.stringify({
              timed_out: false,
              _shards: { failed: 0 },
              hits: { total: { value: hits.length, relation: "eq" }, hits },
            }),
          });
        },
      },
    }),
  );
  const ui = runtime.context();
  system = { ...ui, actor: { ...ui.actor, role: "system" } };
  const invoke = async (method: string, payload: unknown) =>
    take(
      (
        await runtime!.facade.invoke(ui, {
          protocolVersion: "0.1.0",
          requestId: randomUUID(),
          method,
          payload,
        } as never)
      ).result,
    );
  const connection = (await invoke("connections.configure", {
    displayName: "合成平台",
    platformInstanceId: randomUUID(),
    alertsPattern: "wazuh-alerts-*",
    mappingVersion: "wazuh-alerts-v1",
    indexerBaseUrl: "https://synthetic-indexer.invalid/",
  })) as { id: string; generation: number };
  await invoke("connections.setCredential", {
    connectionId: connection.id,
    endpoint: "indexer",
    username: "synthetic",
    password: "synthetic",
    persist: false,
    expectedGeneration: connection.generation,
  });
  await invoke("connections.capabilities", {
    connectionId: connection.id,
    refresh: true,
  });
  const input = {
    origin: "client_user" as const,
    connectionId: connection.id,
    question,
    requestedScope: {
      connectionId: connection.id,
      agentIds: ["001"],
      from,
      to,
      timeZone: "UTC",
    },
    seedRefs: [],
    idempotencyKey: randomUUID(),
  };
  const accepted = take(await runtime.services.requests.create(ui, input));
  take(await runtime.services.requests.tick(system));
  const waitTerminal = async (requestId: string) => {
    for (let i = 0; i < 80; i++) {
      assert.equal(handlerFailure, undefined, handlerFailure);
      const status = take(
        await runtime!.services.requests.status(ui, requestId),
      );
      if (
        ["succeeded", "failed", "cancelled", "needs_review"].includes(
          status.job?.state ?? "",
        )
      )
        return status;
      await delay(150);
      take(await runtime!.services.requests.tick(system));
    }
    throw Error("Real backend did not reach a verified terminal state");
  };
  const completed = await waitTerminal(accepted.request.id);
  assert.equal(completed.job?.state, "succeeded");
  const result = take(
    await runtime.services.delivery.getResult(ui, {
      requestId: accepted.request.id,
    }),
  );
  assert.ok(result.reportId);
  assert.equal(queryCalls, 2);
  checks.actualSchedulerMcpEvidenceReportCompletion = true;
  checks.secondQueryDependsOnFirstReturnedRule = true;
  checks.onlyDedicatedMcpToolsVisible = true;
  checks.verifiedTerminalAndLocalResult = true;
  const cancel = take(
    await runtime.services.requests.create(ui, {
      ...input,
      question: "synthetic-cancel",
      idempotencyKey: randomUUID(),
    }),
  );
  take(await runtime.services.requests.tick(system));
  for (let i = 0; i < 30 && !cancellationModelEntered; i++) await delay(100);
  assert.equal(cancellationModelEntered, true);
  take(
    await runtime.services.requests.cancel(ui, {
      requestId: cancel.request.id,
      reason: "合成取消验证",
    }),
  );
  const cancelled = await waitTerminal(cancel.request.id);
  assert.equal(cancelled.job?.state, "cancelled");
  checks.abortObservedInCorrelatedAssistant = true;
  const counts = take(
    await runtime.storage.db.read(system, (tx) => ({
      submissions: tx.get<{ n: number }>(
        "SELECT COUNT(*) n FROM execution_attempts WHERE operation='start'",
      )!.n,
      activeGrants: tx.get<{ n: number }>(
        "SELECT COUNT(*) n FROM mcp_grants WHERE state='active'",
      )!.n,
    })),
  );
  assert.equal(counts.submissions, 2);
  assert.equal(counts.activeGrants, 0);
  checks.noDuplicateSubmissionsAndRevokedGrants = true;
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = error instanceof Error ? error.message : "Acceptance failed";
  if (runtime && system!) {
    const state = await runtime.storage.db.read(system, (tx) => ({
      jobs: tx.all("SELECT state,error_json FROM jobs"),
      executions: tx.all("SELECT snapshot_json FROM execution_attempts"),
    }));
    if (state.ok) report.sanitizedExecutionDiagnostics = state.value;
  }
  process.exitCode = 1;
} finally {
  await runtime?.close();
  await new Promise<void>((resolve) => {
    lab.close(() => resolve());
    lab.closeAllConnections();
  });
  Object.assign(report, {
    modelCalls,
    queryCalls,
    modelTools: [...modelTools],
    modelRounds,
  });
  await writeFile(
    join(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({ ...report, reportPath: join(root, "report.json") }),
  );
}
