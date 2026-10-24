import { createHash } from "node:crypto";
import {
  DEFAULT_LIMITS,
  canonicalJson,
  normalizedRequest,
  fail,
  ok,
  parseCreateRequest,
  parseDesktopInput,
  parseDto,
  type AnalysisRun,
  type AutoCandidate,
  type CallContext,
  type CaseAtomicPort,
  type ClockPort,
  type ConnectionReadPort,
  type CreateRequest,
  type DatabasePort,
  type DeliveryService,
  type EventPort,
  type EvidenceChannelControlPort,
  type ExecutionPort,
  type ExecutionSnapshot,
  type IdPort,
  type InvestigationProfilePort,
  type InvestigationRequest,
  type JobRecord,
  type JobState,
  type ReadTx,
  type ReportCompletionPort,
  type RequestAtomicPort,
  type RequestService,
  type RequestStatus,
  type Result,
  type RunBudgetAtomicPort,
  type Scope,
  type SubscriptionAtomicPort,
  type WriteTx,
} from "@campussec/contracts";
export interface RequestDependencies {
  db: DatabasePort;
  events: EventPort;
  clock: ClockPort;
  ids: IdPort;
  cases: CaseAtomicPort;
  connections: ConnectionReadPort;
  execution: ExecutionPort;
  channels: EvidenceChannelControlPort;
  profiles: InvestigationProfilePort;
  reports: ReportCompletionPort;
  delivery: DeliveryService;
  subscriptions: SubscriptionAtomicPort;
  budget: RunBudgetAtomicPort;
  profileVersion: string;
}
type RequestRow = {
  id: string;
  principal_id: string;
  origin: InvestigationRequest["origin"];
  state: InvestigationRequest["state"];
  connection_id: string;
  question: string;
  requested_scope_json: string | null;
  effective_scope_json: string | null;
  seed_refs_json: string;
  case_id: string | null;
  job_id: string | null;
  origin_binding_id: string | null;
  auto_candidate_id: string | null;
  missing_fields_json: string;
  created_at: string;
  expires_at: string;
};
type JobRow = {
  id: string;
  request_id: string;
  case_id: string;
  run_id: string | null;
  origin: JobRecord["origin"];
  state: JobState;
  revision: number;
  recovery_hold: number;
  policy_id: string | null;
  policy_epoch: number | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
  error_json: string | null;
};
const terminal = new Set(["succeeded", "needs_review", "failed", "cancelled"]);
const active =
  "'preparing','submitting','running','verifying','cancel_requested','uncertain'";
const sys = (ctx: CallContext): CallContext => ({
  traceId: ctx.traceId,
  actor: {
    spaceId: ctx.actor.spaceId,
    principalId: ctx.actor.principalId,
    identityEpoch: ctx.actor.identityEpoch,
    role: "system",
  },
});
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
export function createRequestService(d: RequestDependencies): {
  service: RequestService;
  atomic: RequestAtomicPort;
  recover(ctx: CallContext): Promise<Result<void>>;
} {
  let ticking:
    | Promise<
        Result<{
          startedJobId?: string;
        }>
      >
    | undefined;
  function auth(tx: ReadTx, ctx: CallContext): Result<void> {
    const parsed = parseDto("CallContext", ctx);
    if (!parsed.ok || !["ui", "system", "delegation"].includes(ctx.actor.role))
      return fail("FORBIDDEN", "请求入口未授权");
    const m = tx.get<{
      space_id: string;
      principal_id: string;
      identity_epoch: number;
    }>("SELECT * FROM space_metadata");
    return m?.space_id === ctx.actor.spaceId &&
      m.principal_id === ctx.actor.principalId &&
      m.identity_epoch === ctx.actor.identityEpoch
      ? ok(undefined)
      : fail("IDENTITY_CHANGED", "请求主体已改变");
  }
  function row(tx: ReadTx, ctx: CallContext, id: string): Result<RequestRow> {
    const a = auth(tx, ctx);
    if (!a.ok) return a;
    const found = tx.get<RequestRow>(
      "SELECT * FROM investigation_requests WHERE id=?",
      [id],
    );
    if (!found || found.principal_id !== ctx.actor.principalId)
      return fail("NOT_FOUND", "请求不存在");
    if (ctx.actor.role === "delegation") {
      const subs = d.subscriptions.listInTx(tx, ctx, id);
      if (
        !subs.ok ||
        !subs.value.some(
          (s) =>
            s.bindingId === ctx.actor.originBindingId && s.state === "active",
        )
      )
        return fail("FORBIDDEN", "来源没有有效订阅");
    }
    return ok(found);
  }
  function request(r: RequestRow): InvestigationRequest {
    return {
      id: r.id,
      origin: r.origin,
      state: r.state,
      connectionId: r.connection_id,
      question: r.question,
      seedRefs: JSON.parse(r.seed_refs_json),
      missingFields: JSON.parse(r.missing_fields_json),
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      ...(r.requested_scope_json
        ? { requestedScope: JSON.parse(r.requested_scope_json) }
        : {}),
      ...(r.effective_scope_json
        ? { effectiveScope: JSON.parse(r.effective_scope_json) }
        : {}),
      ...(r.case_id ? { caseId: r.case_id } : {}),
      ...(r.job_id ? { jobId: r.job_id } : {}),
      ...(r.origin_binding_id ? { originBindingId: r.origin_binding_id } : {}),
      ...(r.auto_candidate_id ? { autoCandidateId: r.auto_candidate_id } : {}),
    };
  }
  function job(r: JobRow): JobRecord {
    return {
      id: r.id,
      requestId: r.request_id,
      caseId: r.case_id,
      origin: r.origin,
      state: r.state,
      revision: r.revision,
      recoveryHold: !!r.recovery_hold,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      expiresAt: r.expires_at,
      ...(r.run_id ? { runId: r.run_id } : {}),
      ...(r.policy_id ? { policyId: r.policy_id } : {}),
      ...(r.policy_epoch !== null ? { policyEpoch: r.policy_epoch } : {}),
      ...(r.error_json ? { error: JSON.parse(r.error_json) } : {}),
    };
  }
  function run(tx: ReadTx, id: string): Result<AnalysisRun> {
    const r = tx.get<Record<string, unknown>>(
      "SELECT * FROM analysis_runs WHERE id=?",
      [id],
    );
    if (!r) return fail("NOT_FOUND", "轮次不存在");
    try {
      return parseDto("AnalysisRun", {
        id: r.id,
        jobId: r.job_id,
        caseId: r.case_id,
        baseRevision: r.base_revision,
        scope: JSON.parse(r.scope_json as string),
        connectionGeneration: r.connection_generation,
        identityEpoch: r.identity_epoch,
        profileVersion: r.profile_version,
        toolEpoch: r.tool_epoch,
        expiresAt: r.expires_at,
        ...(r.manifest_hash ? { manifestHash: r.manifest_hash } : {}),
      });
    } catch {
      return fail("VALIDATION_FAILED", "轮次记录损坏");
    }
  }
  function status(
    tx: ReadTx,
    ctx: CallContext,
    id: string,
  ): Result<RequestStatus> {
    const found = row(tx, ctx, id);
    if (!found.ok) return found;
    const r = found.value,
      j = r.job_id
        ? tx.get<JobRow>("SELECT * FROM jobs WHERE id=?", [r.job_id])
        : undefined;
    const result: RequestStatus = {
      request: request(r),
      ...(j ? { job: job(j) } : {}),
    };
    if (j?.run_id) {
      const current = run(tx, j.run_id);
      if (!current.ok) return current;
      const tools = tx.get<{
        n: number;
        reads: number;
      }>(
        "SELECT COUNT(*) AS n,COALESCE(SUM(is_read),0) AS reads FROM tool_reservations WHERE run_id=?",
        [j.run_id],
      )!;
      result.budget = {
        runId: j.run_id,
        toolsUsed: tools.n,
        readsUsed: tools.reads,
        platformAttempts: tx.get<{
          n: number;
        }>("SELECT COUNT(*) AS n FROM platform_attempts WHERE run_id=?", [
          j.run_id,
        ])!.n,
        distinctEvents: tx.get<{
          n: number;
        }>("SELECT COUNT(*) AS n FROM run_event_keys WHERE run_id=?", [
          j.run_id,
        ])!.n,
        deadline: current.value.expiresAt,
        closed: !["preparing", "submitting", "running"].includes(j.state),
      };
    }
    return parseDto("RequestStatus", result);
  }
  function transition(
    tx: WriteTx,
    ctx: CallContext,
    j: JobRow,
    state: JobState,
    error?: RequestStatus["job"] extends infer V
      ? import("@campussec/contracts").AppError
      : never,
  ) {
    tx.run(
      "UPDATE jobs SET state=?,revision=revision+1,updated_at=?,error_json=? WHERE id=?",
      [state, d.clock.now(), error ? canonicalJson(error) : null, j.id],
    );
    d.events.appendInTx(tx, ctx, {
      type: "job.changed",
      aggregateId: j.id,
      revision: j.revision + 1,
      payload: {
        jobId: j.id,
        ...(j.run_id ? { runId: j.run_id } : {}),
        state,
        revision: j.revision + 1,
      },
    });
  }
  function createTx(
    tx: WriteTx,
    ctx: CallContext,
    input: CreateRequest,
    policy?: AutoCandidate,
  ): Result<RequestStatus> {
    const a = auth(tx, ctx);
    if (!a.ok) return a;
    if (
      (input.origin === "client_user" &&
        !["ui", "system"].includes(ctx.actor.role)) ||
      (input.origin === "teleagent_user" &&
        (ctx.actor.role !== "delegation" ||
          input.originBindingId !== ctx.actor.originBindingId)) ||
      (input.origin === "alert_auto" &&
        (!policy || ctx.actor.role !== "system"))
    )
      return fail("FORBIDDEN", "请求来源不可伪造");
    const key = input.origin + ":" + (input.originBindingId ?? "local"),
      hash = digest(normalizedRequest(input));
    const old = tx.get<{
      request_id: string;
      request_hash: string;
    }>(
      "SELECT * FROM request_keys WHERE principal_id=? AND origin_key=? AND idempotency_key=?",
      [ctx.actor.principalId, key, input.idempotencyKey],
    );
    if (old)
      return old.request_hash === hash
        ? status(tx, ctx, old.request_id)
        : fail("CONFLICT", "幂等键对应其他请求");
    if (!tx.get("SELECT id FROM connections WHERE id=?", [input.connectionId]))
      return fail("NOT_FOUND", "请先配置连接");
    if (
      input.requestedScope?.connectionId !== undefined &&
      input.requestedScope.connectionId !== input.connectionId
    )
      return fail("SCOPE_EXCEEDED", "请求与作用域连接不一致");
    if (
      input.requestedScope &&
      tx.get<{
        n: number;
      }>(
        "SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','coalescing')",
      )!.n >= DEFAULT_LIMITS.queueCapacity
    )
      return fail("QUEUE_FULL", "调查队列已满");
    let caseId = input.caseId;
    if (input.requestedScope) {
      if (caseId) {
        const found = d.cases.getInTx(tx, sys(ctx), caseId);
        if (!found.ok) return found;
        const outer = found.value.scope;
        if (
          outer.connectionId !== input.connectionId ||
          input.requestedScope.agentIds.some(
            (id) => !outer.agentIds.includes(id),
          ) ||
          input.requestedScope.from < outer.from ||
          input.requestedScope.to > outer.to
        )
          return fail("SCOPE_EXCEEDED", "请求范围超出案件");
        if (input.seedRefs.length) {
          const attached = d.cases.attachInTx(tx, sys(ctx), {
            caseId,
            refs: input.seedRefs,
            expectedRevision: found.value.revision,
            reason: "主动调查种子",
          });
          if (!attached.ok) return attached;
        }
      } else {
        const made = d.cases.createInTx(tx, sys(ctx), {
          title: Array.from(input.question).slice(0, 200).join(""),
          scope: input.requestedScope,
          seedRefs: input.seedRefs,
        });
        if (!made.ok) return made;
        caseId = made.value.id;
      }
    }
    const id = d.ids.next(),
      jobId = input.requestedScope ? d.ids.next() : undefined,
      now = d.clock.now(),
      expires =
        policy?.expiresAt ??
        new Date(Date.parse(now) + DEFAULT_LIMITS.requestTtlMs).toISOString();
    tx.run(
      "INSERT INTO investigation_requests(id,origin,state,principal_id,connection_id,question,requested_scope_json,effective_scope_json,seed_refs_json,case_id,job_id,origin_binding_id,auto_candidate_id,missing_fields_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        id,
        input.origin,
        input.requestedScope ? "accepted" : "awaiting_scope",
        ctx.actor.principalId,
        input.connectionId,
        input.question,
        input.requestedScope ? canonicalJson(input.requestedScope) : null,
        input.requestedScope ? canonicalJson(input.requestedScope) : null,
        canonicalJson(input.seedRefs),
        caseId ?? null,
        jobId ?? null,
        input.originBindingId ?? null,
        input.autoCandidateId ?? null,
        input.requestedScope ? "[]" : '["scope"]',
        now,
        expires,
      ],
    );
    if (jobId)
      tx.run(
        "INSERT INTO jobs(id,request_id,case_id,origin,state,revision,policy_id,policy_epoch,expires_at,created_at,updated_at) VALUES(?,?,?,?,'queued',1,?,?,?,?,?)",
        [
          jobId,
          id,
          caseId!,
          input.origin,
          policy?.policyId ?? null,
          policy?.policyEpoch ?? null,
          expires,
          now,
          now,
        ],
      );
    tx.run(
      "INSERT INTO request_keys(principal_id,origin_key,idempotency_key,request_hash,request_id) VALUES(?,?,?,?,?)",
      [ctx.actor.principalId, key, input.idempotencyKey, hash, id],
    );
    if (input.originBindingId) {
      const subscribed = d.subscriptions.subscribeInTx(tx, sys(ctx), {
        requestId: id,
        bindingId: input.originBindingId,
        canCancel: true,
      });
      if (!subscribed.ok) return subscribed;
    }
    d.events.appendInTx(tx, sys(ctx), {
      type: "request.changed",
      aggregateId: id,
      revision: 1,
      payload: {
        requestId: id,
        state: input.requestedScope ? "accepted" : "awaiting_scope",
      },
    });
    return status(tx, ctx, id);
  }
  function reserveDaily(
    tx: WriteTx,
    ctx: CallContext,
    j: JobRow,
    connectionId: string,
    runId: string,
  ): Result<void> {
    const settingsRow = tx.get<{
      value_json: string;
    }>("SELECT value_json FROM runtime_settings WHERE key='runtime'");
    const settings = settingsRow
      ? JSON.parse(settingsRow.value_json)
      : { budgetTimeZone: "Asia/Shanghai" };
    const policyRow = j.policy_id
      ? tx.get<{
          policy_json: string;
          enabled: number;
          epoch: number;
        }>("SELECT * FROM trigger_policies WHERE id=?", [j.policy_id])
      : undefined;
    const policy = policyRow
      ? (JSON.parse(
          policyRow.policy_json,
        ) as import("@campussec/contracts").TriggerPolicy)
      : undefined;
    if (
      j.origin === "alert_auto" &&
      (!policyRow?.enabled || policyRow.epoch !== j.policy_epoch)
    )
      return fail("EXPIRED", "自动策略代次已失效");
    const zone = policy?.timeZone ?? settings.budgetTimeZone;
    const localDate = (time: string, timeZone: string) => {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date(time));
      return ["year", "month", "day"]
        .map((key) => parts.find((p) => p.type === key)!.value)
        .join("-");
    };
    const date = localDate(d.clock.now(), zone);
    type Entry = {
      job_id: string;
      kind: string;
      amount: number;
      usage_json: string | null;
      created_at: string;
    };
    const entries = tx.all<Entry>(
      "SELECT * FROM quota_ledger WHERE local_date=? AND time_zone=?",
      [date, zone],
    );
    const own = entries.filter((e) => e.kind === "automatic_attempt");
    if (
      j.origin === "alert_auto" &&
      own.length >=
        (policy?.dailyAttemptLimit ?? DEFAULT_LIMITS.autoDailyAttempts)
    )
      return fail("BUDGET_EXHAUSTED", "自动调查当日预占次数已达上限");
    const checkTokens = (limit: number, attempts: Entry[]): Result<void> => {
      const usage = attempts.map((a) =>
        tx.get<Entry>(
          "SELECT * FROM quota_ledger WHERE job_id=? AND kind='token_usage'",
          [a.job_id],
        ),
      );
      if (
        usage.some(
          (u) => !u?.usage_json || JSON.parse(u.usage_json).known !== true,
        )
      )
        return fail(
          "BUDGET_EXHAUSTED",
          "当日存在未知用量，启用 token 限额后暂停新调查",
        );
      return usage.reduce((n, e) => n + e!.amount, 0) >= limit
        ? fail("BUDGET_EXHAUSTED", "当日 token 用量已达停派阈值")
        : ok(undefined);
    };
    if (policy?.dailyTokenLimit !== undefined) {
      const checked = checkTokens(
        policy.dailyTokenLimit,
        entries.filter((e) => e.kind === "model_attempt"),
      );
      if (!checked.ok) return checked;
    }
    if (settings.dailyTotalTokenLimit !== undefined) {
      const globalDate = localDate(d.clock.now(), settings.budgetTimeZone);
      const recent = tx
        .all<Entry>(
          "SELECT * FROM quota_ledger WHERE kind='model_attempt' AND created_at>=?",
          [new Date(Date.parse(d.clock.now()) - 172800000).toISOString()],
        )
        .filter(
          (e) =>
            localDate(e.created_at, settings.budgetTimeZone) === globalDate,
        );
      const checked = checkTokens(settings.dailyTotalTokenLimit, recent);
      if (!checked.ok) return checked;
    }
    for (const kind of j.origin === "alert_auto"
      ? ["model_attempt", "automatic_attempt"]
      : ["model_attempt"])
      tx.run(
        "INSERT INTO quota_ledger(id,job_id,run_id,connection_id,origin,local_date,time_zone,attempt,kind,amount,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        [
          d.ids.next(),
          j.id,
          runId,
          connectionId,
          j.origin,
          date,
          zone,
          1,
          kind,
          1,
          d.clock.now(),
        ],
      );
    return ok(undefined);
  }
  function recordUsage(
    tx: WriteTx,
    j: JobRow,
    snapshot: ExecutionSnapshot | undefined,
  ): void {
    const entry = tx.get<{
      connection_id: string;
      local_date: string;
      time_zone: string;
    }>("SELECT * FROM quota_ledger WHERE job_id=? AND kind='model_attempt'", [
      j.id,
    ]);
    if (!entry) return;
    const u = snapshot?.usage,
      known =
        u?.inputTokens !== undefined &&
        u.outputTokens !== undefined &&
        !u.estimated;
    const amount = known ? u!.inputTokens! + u!.outputTokens! : 0;
    tx.run(
      "INSERT OR IGNORE INTO quota_ledger(id,job_id,run_id,connection_id,origin,local_date,time_zone,attempt,kind,amount,usage_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        d.ids.next(),
        j.id,
        j.run_id,
        entry.connection_id,
        j.origin,
        entry.local_date,
        entry.time_zone,
        1,
        "token_usage",
        amount,
        canonicalJson({ known, ...(u ? { usage: u } : {}) }),
        d.clock.now(),
      ],
    );
  }
  function finish(
    tx: WriteTx,
    ctx: CallContext,
    j: JobRow,
    decision: import("@campussec/contracts").CompletionDecision,
  ): Result<void> {
    const r = tx.get<RequestRow>(
      "SELECT * FROM investigation_requests WHERE id=?",
      [j.request_id],
    )!;
    const scope = JSON.parse(r.effective_scope_json!);
    let result: Result<import("@campussec/contracts").ResultPackage>;
    if (j.run_id) {
      const saved = run(tx, j.run_id);
      if (!saved.ok) return saved;
      const metadata = tx.get<{
        initial_input_json: string;
        mapping_version: string;
      }>(
        "SELECT initial_input_json,mapping_version FROM analysis_runs WHERE id=?",
        [j.run_id],
      )!;
      const steps = tx.all<{
        id: string;
        phase: string;
        summary: string;
        purpose: string | null;
        evidence_refs_json: string;
      }>(
        "SELECT * FROM investigation_steps WHERE run_id=? ORDER BY created_at,id",
        [j.run_id],
      );
      const sealed = d.cases.sealInTx(tx, ctx, {
        runId: j.run_id,
        metadata: {
          initialInput: JSON.parse(metadata.initial_input_json),
          profileVersion: saved.value.profileVersion,
          mappingVersion: metadata.mapping_version,
          steps: steps.map((s) => ({
            id: s.id,
            input: {
              phase: s.phase as "orientation",
              summary: s.summary,
              ...(s.purpose ? { purpose: s.purpose } : {}),
              evidenceRefs: JSON.parse(s.evidence_refs_json),
            },
          })),
        },
      });
      if (!sealed.ok) return sealed;
      tx.run(
        "UPDATE analysis_runs SET manifest_hash=?,sealed_at=?,completion_decision_json=?,tool_epoch=tool_epoch+1 WHERE id=?",
        [
          sealed.value.manifestHash,
          d.clock.now(),
          canonicalJson(decision),
          j.run_id,
        ],
      );
      const assessment = d.reports.assessInTx(tx, ctx, j.run_id);
      if (!assessment.ok) return assessment;
      result = d.reports.finalizeInTx(tx, ctx, {
        run: saved.value,
        context: {
          requestId: r.id,
          jobId: j.id,
          caseId: j.case_id,
          runId: j.run_id,
          scope,
        },
        decision,
        manifestHash: sealed.value.manifestHash,
        assessment: assessment.value,
      });
      if (!result.ok) return result;
      if (assessment.value.reportId) {
        const applied = d.cases.applyRunInTx(tx, ctx, {
          run: saved.value,
          reportId: assessment.value.reportId,
        });
        if (!applied.ok) return applied;
      }
    } else
      result = d.reports.terminalWithoutRunInTx(tx, ctx, {
        context: { requestId: r.id, jobId: j.id, caseId: j.case_id, scope },
        decision,
      });
    if (!result.ok) return result;
    const subscriptions = d.subscriptions.listInTx(tx, ctx, r.id);
    if (!subscriptions.ok) return subscriptions;
    for (const s of subscriptions.value.filter((s) => s.state === "active")) {
      const queued = d.delivery.enqueueInTx(tx, ctx, {
        bindingId: s.bindingId,
        result: result.value,
      });
      if (!queued.ok) return queued;
    }
    transition(tx, ctx, j, decision.terminalState, decision.error);
    return ok(undefined);
  }
  function reconciliation(j: JobRow): number {
    try {
      const count = JSON.parse(j.error_json ?? "{}").details
        ?.automaticReconciliations;
      return Number.isInteger(count) && count >= 0 ? count : 0;
    } catch {
      return 0;
    }
  }
  function uncertainError(j: JobRow): import("@campussec/contracts").AppError {
    const count = reconciliation(j);
    return {
      code: "UNCERTAIN",
      message: "远端执行仍待核实，禁止重复提交",
      retryable: false,
      details: {
        automaticReconciliations: count,
        ...(count < 3
          ? {
              nextReconcileAt: new Date(
                Date.parse(d.clock.now()) + [5000, 15000, 60000][count]!,
              ).toISOString(),
            }
          : {}),
      },
    };
  }
  async function observe(
    ctx: CallContext,
    id: string,
    snapshot: Result<ExecutionSnapshot>,
    abandonReason?: string,
  ): Promise<Result<RequestStatus>> {
    const read = await d.db.read(ctx, (tx) =>
      tx.get<JobRow>("SELECT * FROM jobs WHERE request_id=?", [id]),
    );
    if (!read.ok) return read;
    if (!read.value) return fail("NOT_FOUND", "调查任务不存在");
    const j = read.value;
    if (terminal.has(j.state)) return service.status(ctx, id);
    const known = snapshot.ok ? snapshot.value : undefined;
    const definitive =
      known?.verification === "verified" &&
      ["completed", "failed", "cancelled", "not_submitted"].includes(
        known.phase,
      );
    if ((definitive || abandonReason) && j.run_id) {
      const closing = await d.db.write(ctx, (tx) => {
        const current = tx.get<JobRow>("SELECT * FROM jobs WHERE id=?", [
          j.id,
        ])!;
        if (terminal.has(current.state)) return ok(undefined);
        tx.run("UPDATE analysis_runs SET tool_epoch=tool_epoch+1 WHERE id=?", [
          j.run_id!,
        ]);
        if (current.state !== "cancel_requested")
          transition(tx, ctx, current, "verifying");
        return ok(undefined);
      });
      if (!closing.ok) return closing;
      const revoked = await d.channels.revoke(ctx, j.run_id);
      if (!revoked.ok) return revoked;
    }
    return d.db.write(ctx, (tx) => {
      const current = tx.get<JobRow>("SELECT * FROM jobs WHERE id=?", [j.id])!;
      if (terminal.has(current.state)) return status(tx, ctx, id);
      const cancellationIntent =
        current.state === "cancel_requested" ||
        !!(
          current.run_id &&
          tx.get(
            "SELECT id FROM execution_attempts WHERE run_id=? AND operation='abort' LIMIT 1",
            [current.run_id],
          )
        );
      if (!definitive && !abandonReason) {
        const next =
          !cancellationIntent &&
          known?.verification === "verified" &&
          (known.phase === "running" || known.phase === "submitted")
            ? "running"
            : "uncertain";
        transition(
          tx,
          ctx,
          current,
          next,
          next === "uncertain" ? uncertainError(current) : undefined,
        );
        return status(tx, ctx, id);
      }
      const assessment = current.run_id
        ? d.reports.assessInTx(tx, ctx, current.run_id)
        : ok({ validation: "missing" as const });
      if (!assessment.ok) return assessment;
      const anchor = current.run_id ? run(tx, current.run_id) : undefined;
      const generation = anchor?.ok
        ? tx.get<{
            generation: number;
          }>("SELECT generation FROM connections WHERE id=?", [
            anchor.value.scope.connectionId,
          ])?.generation
        : undefined;
      const changed =
        anchor?.ok && generation !== anchor.value.connectionGeneration;
      const cancelled = cancellationIntent;
      const terminalState = abandonReason
        ? "needs_review"
        : known!.phase === "cancelled"
          ? "cancelled"
          : known!.phase === "failed" || known!.phase === "not_submitted"
            ? "failed"
            : cancelled || changed || assessment.value.validation !== "valid"
              ? "needs_review"
              : "succeeded";
      recordUsage(tx, current, known);
      const completed = finish(tx, ctx, current, {
        terminalState,
        reason:
          abandonReason ??
          (changed
            ? "连接代次已变化，保留冻结材料供人工核查"
            : cancelled
              ? "取消请求与执行完成竞态，保留实际执行材料"
              : terminalState === "succeeded"
                ? "调查完成，报告仍待人工核查"
                : "调查停止或材料不完整，需人工核查"),
        ...(known?.error ? { error: known.error } : {}),
      });
      return completed.ok ? status(tx, ctx, id) : completed;
    });
  }
  async function advance(ctx: CallContext): Promise<
    Result<{
      startedJobId?: string;
    }>
  > {
    if (ctx.actor.role !== "system")
      return fail("FORBIDDEN", "调度仅允许系统调用");
    const picked = await d.db.write<
      | {
          live: JobRow;
        }
      | {
          next: JobRow;
        }
      | undefined
    >(ctx, (tx) => {
      const a = auth(tx, ctx);
      if (!a.ok) return a;
      const live = tx.get<JobRow>(
        `SELECT * FROM jobs WHERE state IN (${active}) LIMIT 1`,
      );
      if (live) return ok({ live });
      const next = tx.get<JobRow>(
        "SELECT * FROM jobs WHERE state='queued' AND recovery_hold=0 ORDER BY CASE origin WHEN 'alert_auto' THEN 1 ELSE 0 END,created_at,id LIMIT 1",
      );
      if (!next) return ok(undefined);
      if (next.expires_at <= d.clock.now()) {
        const ended = finish(tx, ctx, next, {
          terminalState: "failed",
          reason: "排队请求已过期",
          error: {
            code: "EXPIRED",
            message: "排队请求已过期",
            retryable: false,
          },
        });
        return ended.ok ? ok(undefined) : ended;
      }
      transition(tx, ctx, next, "preparing");
      return ok({ next });
    });
    if (!picked.ok) return picked;
    if (!picked.value) return ok({});
    if ("live" in picked.value) {
      const live = picked.value.live;
      if (!live.run_id)
        return fail("UNCERTAIN", "准备任务尚无轮次，须人工核查");
      const aborted = await d.db.read(
        ctx,
        (tx) =>
          !!tx.get(
            "SELECT id FROM execution_attempts WHERE run_id=? AND operation='abort' LIMIT 1",
            [live.run_id!],
          ),
      );
      if (!aborted.ok) return aborted;
      if (
        live.state === "cancel_requested" ||
        (live.expires_at <= d.clock.now() && !aborted.value)
      ) {
        if (live.state !== "cancel_requested") {
          const fenced = await d.db.write(ctx, (tx) => {
            const current = tx.get<JobRow>("SELECT * FROM jobs WHERE id=?", [
              live.id,
            ])!;
            if (terminal.has(current.state)) return ok(undefined);
            tx.run(
              "UPDATE analysis_runs SET tool_epoch=tool_epoch+1 WHERE id=?",
              [live.run_id!],
            );
            transition(tx, ctx, current, "cancel_requested");
            return ok(undefined);
          });
          if (!fenced.ok) return fenced;
        }
        const revoked = await d.channels.revoke(ctx, live.run_id);
        if (!revoked.ok) return revoked;
        const updated = await observe(
          ctx,
          live.request_id,
          await d.execution.abort(ctx, live.run_id),
        );
        return updated.ok ? ok({}) : updated;
      }
      if (live.state === "uncertain") {
        const due = await d.db.write(ctx, (tx) => {
          const current = tx.get<JobRow>("SELECT * FROM jobs WHERE id=?", [
            live.id,
          ])!;
          if (current.state !== "uncertain") return ok(false);
          const count = reconciliation(current);
          let nextAt: string | undefined;
          try {
            nextAt = JSON.parse(current.error_json ?? "{}").details
              ?.nextReconcileAt;
          } catch {
            /* Reconcile corrupt metadata only by explicit user action. */
          }
          if (count >= 3 || !nextAt || nextAt > d.clock.now()) return ok(false);
          transition(tx, ctx, current, "uncertain", {
            code: "UNCERTAIN",
            message: "正在核实原执行，不重复提交",
            retryable: false,
            details: {
              automaticReconciliations: count + 1,
              ...(count + 1 < 3
                ? {
                    nextReconcileAt: new Date(
                      Date.parse(d.clock.now()) +
                        [5000, 15000, 60000][count + 1]!,
                    ).toISOString(),
                  }
                : {}),
            },
          });
          return ok(true);
        });
        if (!due.ok) return due;
        if (!due.value) return ok({});
      }
      const updated = await observe(
        ctx,
        live.request_id,
        await d.execution.inspect(ctx, live.run_id),
      );
      return updated.ok ? ok({}) : updated;
    }
    const selected = picked.value.next;
    const connectionRow = await d.db.read(ctx, (tx) =>
      tx.get<RequestRow>("SELECT * FROM investigation_requests WHERE id=?", [
        selected.request_id,
      ]),
    );
    if (!connectionRow.ok || !connectionRow.value)
      return connectionRow.ok ? fail("NOT_FOUND", "请求不存在") : connectionRow;
    const capabilities = await d.connections.capabilities(
      ctx,
      connectionRow.value.connection_id,
      false,
    );
    if (!capabilities.ok) {
      await d.db.write(ctx, (tx) =>
        finish(
          tx,
          ctx,
          tx.get<JobRow>("SELECT * FROM jobs WHERE id=?", [selected.id])!,
          {
            terminalState: "failed",
            reason: "无法读取平台能力",
            error: capabilities.error,
          },
        ),
      );
      return capabilities;
    }
    const prepared = await d.db.write(ctx, (tx) => {
      const j = tx.get<JobRow>("SELECT * FROM jobs WHERE id=?", [selected.id])!;
      if (j.state !== "preparing")
        return fail("CONFLICT", "准备期间任务状态改变");
      const r = tx.get<RequestRow>(
        "SELECT * FROM investigation_requests WHERE id=?",
        [j.request_id],
      )!;
      const scope = JSON.parse(r.effective_scope_json!) as Scope;
      if (scope.to > d.clock.now()) scope.to = d.clock.now();
      if (scope.from >= scope.to)
        return fail("NEEDS_INPUT", "调查范围尚未开始");
      tx.run(
        "UPDATE investigation_requests SET effective_scope_json=? WHERE id=?",
        [canonicalJson(scope), r.id],
      );
      const connection = tx.get<{
        generation: number;
        mapping_version: string;
      }>("SELECT generation,mapping_version FROM connections WHERE id=?", [
        r.connection_id,
      ]);
      if (!connection) return fail("NOT_FOUND", "连接已移除");
      const found = d.cases.getInTx(tx, ctx, j.case_id);
      if (!found.ok) return found;
      // A follow-up round may use an already investigating case. Record its new
      // input revision through S06 instead of attempting an illegal self-transition.
      const investigating =
        found.value.status === "investigating"
          ? d.cases.recordChangeInTx(tx, ctx, {
              caseId: j.case_id,
              expectedRevision: found.value.revision,
              reason: "准备新一轮调查",
            })
          : d.cases.setStatusInTx(tx, ctx, {
              caseId: j.case_id,
              expectedRevision: found.value.revision,
              status: "investigating",
              reason: "准备调查",
            });
      if (!investigating.ok) return investigating;
      const runId = d.ids.next(),
        expiresAt = new Date(
          Date.parse(d.clock.now()) + DEFAULT_LIMITS.runTtlMs,
        ).toISOString();
      const run: AnalysisRun = {
        id: runId,
        jobId: j.id,
        caseId: j.case_id,
        baseRevision:
          typeof investigating.value === "number"
            ? investigating.value
            : investigating.value.revision,
        scope,
        connectionGeneration: connection.generation,
        identityEpoch: ctx.actor.identityEpoch,
        profileVersion: d.profileVersion,
        toolEpoch: 1,
        expiresAt,
      };
      tx.run(
        "INSERT INTO analysis_runs(id,job_id,case_id,base_revision,scope_json,connection_generation,identity_epoch,profile_version,tool_epoch,expires_at,initial_input_json,mapping_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          runId,
          j.id,
          j.case_id,
          run.baseRevision,
          canonicalJson(scope),
          connection.generation,
          run.identityEpoch,
          run.profileVersion,
          1,
          expiresAt,
          "{}",
          connection.mapping_version,
        ],
      );
      tx.run("UPDATE jobs SET run_id=?,expires_at=? WHERE id=?", [
        runId,
        expiresAt,
        j.id,
      ]);
      const quota = reserveDaily(tx, ctx, j, r.connection_id, runId);
      if (!quota.ok) return quota;
      const input = d.cases.initializeRunInTx(tx, ctx, {
        run,
        seedRefs: JSON.parse(r.seed_refs_json),
        question: r.question,
        capabilities: capabilities.value,
      });
      if (!input.ok) return input;
      tx.run("UPDATE analysis_runs SET initial_input_json=? WHERE id=?", [
        canonicalJson(input.value),
        runId,
      ]);
      const keys = input.value.seedRefs.map((ref) => ref.evidenceId);
      const budget = d.budget.recordEventsInTx(tx, ctx, {
        runId,
        sourceKeys: keys,
      });
      if (!budget.ok) return budget;
      const seeds = d.cases.projectInTx(tx, ctx, {
        runId,
        refs: input.value.seedRefs,
        fieldNames: [
          "timestamp",
          "agent.id",
          "agent.name",
          "rule.id",
          "rule.level",
          "rule.description",
          "event.action",
          "event.category",
          "source.ip",
          "destination.ip",
          "user.name",
          "user.namespace",
          "text",
          "summary",
        ],
      });
      return seeds.ok
        ? ok({ run, initialInput: input.value, seedProjections: seeds.value })
        : seeds;
    });
    if (!prepared.ok) {
      await d.db.write(ctx, (tx) => {
        const j = tx.get<JobRow>("SELECT * FROM jobs WHERE id=?", [
          selected.id,
        ])!;
        return j.run_id
          ? ok(undefined)
          : finish(tx, ctx, j, {
              terminalState: "failed",
              reason: "调查准备失败",
              error: prepared.error,
            });
      });
      return prepared;
    }
    const profile = await d.profiles.prepare(ctx, prepared.value);
    if (!profile.ok)
      return observe(
        ctx,
        selected.request_id,
        ok({
          runId: prepared.value.run.id,
          phase: "failed",
          verification: "verified",
          observedAt: d.clock.now(),
          error: profile.error,
        }),
      ).then((r) => (r.ok ? ok({ startedJobId: selected.id }) : r));
    const saved = await d.db.write(ctx, (tx) => {
      const j = tx.get<JobRow>("SELECT * FROM jobs WHERE id=?", [selected.id])!;
      if (j.state !== "preparing") return fail("CANCELLED", "准备期间已取消");
      tx.run("UPDATE analysis_runs SET prepared_profile_json=? WHERE id=?", [
        canonicalJson(profile.value),
        prepared.value.run.id,
      ]);
      transition(tx, ctx, j, "submitting");
      return ok(undefined);
    });
    if (!saved.ok) return saved;
    const channel = await d.channels.openChannel(ctx, prepared.value.run);
    if (!channel.ok)
      return observe(
        ctx,
        selected.request_id,
        ok({
          runId: prepared.value.run.id,
          phase: "failed",
          verification: "verified",
          observedAt: d.clock.now(),
          error: channel.error,
        }),
      ).then((r) => (r.ok ? ok({ startedJobId: selected.id }) : r));
    const started = await d.execution.start(ctx, {
      run: prepared.value.run,
      profile: profile.value,
      channel: channel.value,
    });
    if (!started.ok && started.error.code === "CAPABILITY_UNAVAILABLE")
      return observe(
        ctx,
        selected.request_id,
        ok({
          runId: prepared.value.run.id,
          phase: "not_submitted",
          verification: "verified",
          observedAt: d.clock.now(),
          error: started.error,
        }),
      ).then((r) => (r.ok ? ok({ startedJobId: selected.id }) : r));
    if (
      started.ok &&
      started.value.verification === "verified" &&
      started.value.userMessageId
    ) {
      const released = await d.db.write(ctx, (tx) => {
        const j = tx.get<JobRow>("SELECT * FROM jobs WHERE id=?", [
          selected.id,
        ])!;
        return j.state === "submitting"
          ? d.cases.releaseInTx(tx, ctx, {
              runId: prepared.value.run.id,
              projectionIds: profile.value.seedProjectionIds,
              outcome: "released",
            })
          : ok(undefined);
      });
      if (!released.ok) return released;
    }
    const observed = await observe(ctx, selected.request_id, started);
    return observed.ok ? ok({ startedJobId: selected.id }) : observed;
  }
  const atomic: RequestAtomicPort = {
    createAutoInTx(tx, ctx, candidate) {
      if (ctx.actor.role !== "system")
        return fail("FORBIDDEN", "自动受理仅允许系统调用");
      const policy = tx.get<{
        enabled: number;
        epoch: number;
        policy_json: string;
      }>("SELECT * FROM trigger_policies WHERE id=?", [candidate.policyId]);
      if (
        !policy ||
        !policy.enabled ||
        policy.epoch !== candidate.policyEpoch ||
        candidate.expiresAt <= d.clock.now()
      )
        return fail("EXPIRED", "自动策略或候选已失效");
      const seedRefs = candidate.alertIds
        .map((id) =>
          tx.get<{
            evidence_id: string;
            evidence_version: number;
          }>(
            "SELECT evidence_id,evidence_version FROM alerts_inbox WHERE id=?",
            [id],
          ),
        )
        .filter(
          (
            r,
          ): r is {
            evidence_id: string;
            evidence_version: number;
          } => !!r,
        )
        .map((r) => ({
          evidenceId: r.evidence_id,
          version: r.evidence_version,
        }));
      return createTx(
        tx,
        ctx,
        {
          origin: "alert_auto",
          connectionId: candidate.scope.connectionId,
          question: candidate.question,
          requestedScope: candidate.scope,
          seedRefs,
          caseId: candidate.caseId,
          idempotencyKey: candidate.id,
          autoCandidateId: candidate.id,
        },
        candidate,
      );
    },
    cancelPolicyInTx(tx, ctx, input) {
      if (ctx.actor.role !== "system")
        return fail("FORBIDDEN", "策略撤销仅允许系统调用");
      const rows = tx.all<JobRow>(
        "SELECT * FROM jobs WHERE policy_id=? AND policy_epoch<=? AND state NOT IN ('succeeded','needs_review','failed','cancelled')",
        [input.policyId, input.obsoleteEpoch],
      );
      const revokeRunIds: string[] = [];
      for (const j of rows) {
        if (j.run_id) {
          tx.run(
            "UPDATE analysis_runs SET tool_epoch=tool_epoch+1 WHERE id=?",
            [j.run_id],
          );
          transition(tx, ctx, j, "cancel_requested");
          revokeRunIds.push(j.run_id);
        } else {
          const result = finish(tx, ctx, j, {
            terminalState: "cancelled",
            reason: "自动策略已撤销",
          });
          if (!result.ok) return result;
        }
      }
      return ok({ revokeRunIds });
    },
  };
  const service: RequestService = {
    async create(ctx, raw) {
      const parsed = parseCreateRequest(raw);
      if (!parsed.ok) return parsed;
      return d.db.write(ctx, (tx) => createTx(tx, ctx, parsed.value));
    },
    async status(ctx, id) {
      const read = await d.db.read(ctx, (tx) => status(tx, ctx, id));
      return read.ok ? read.value : read;
    },
    async provideInput(ctx, input) {
      const parsed = parseDesktopInput("requests.provideInput", input);
      if (!parsed.ok) return parsed;
      return d.db.write(ctx, (tx) => {
        const found = row(tx, ctx, input.requestId);
        if (!found.ok) return found;
        const r = found.value;
        const old = tx.get<{
          text: string;
        }>(
          "SELECT text FROM deferred_inputs WHERE request_id=? AND input_key=?",
          [r.id, input.idempotencyKey],
        );
        const text = canonicalJson({
          ...(input.scope ? { scope: input.scope } : {}),
          ...(input.text ? { text: input.text } : {}),
        });
        if (old)
          return old.text === text
            ? status(tx, ctx, r.id)
            : fail("CONFLICT", "补充输入幂等冲突");
        if (r.state === "awaiting_scope" && input.scope) {
          if (r.expires_at <= d.clock.now())
            return fail("EXPIRED", "请求已过期");
          if (input.scope.connectionId !== r.connection_id)
            return fail("SCOPE_EXCEEDED", "补充范围连接不一致");
          if (
            tx.get<{
              n: number;
            }>(
              "SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','coalescing')",
            )!.n >= 20
          )
            return fail("QUEUE_FULL", "队列已满");
          let caseId = r.case_id;
          if (!caseId) {
            const made = d.cases.createInTx(tx, sys(ctx), {
              title: Array.from(r.question).slice(0, 200).join(""),
              scope: input.scope,
              seedRefs: JSON.parse(r.seed_refs_json),
            });
            if (!made.ok) return made;
            caseId = made.value.id;
          } else {
            const existing = d.cases.getInTx(tx, sys(ctx), caseId);
            if (!existing.ok) return existing;
            if (
              input.scope.agentIds.some(
                (id) => !existing.value.scope.agentIds.includes(id),
              ) ||
              input.scope.from < existing.value.scope.from ||
              input.scope.to > existing.value.scope.to
            )
              return fail("SCOPE_EXCEEDED", "补充范围超出案件");
          }
          const jobId = d.ids.next();
          tx.run(
            "INSERT INTO jobs(id,request_id,case_id,origin,state,revision,expires_at,created_at,updated_at) VALUES(?,?,?,?,'queued',1,?,?,?)",
            [
              jobId,
              r.id,
              caseId,
              r.origin,
              r.expires_at,
              d.clock.now(),
              d.clock.now(),
            ],
          );
          tx.run(
            "UPDATE investigation_requests SET state='accepted',requested_scope_json=?,effective_scope_json=?,case_id=?,job_id=?,missing_fields_json='[]' WHERE id=?",
            [
              canonicalJson(input.scope),
              canonicalJson(input.scope),
              caseId,
              jobId,
              r.id,
            ],
          );
        }
        tx.run(
          "INSERT INTO deferred_inputs(id,request_id,input_key,text,created_at) VALUES(?,?,?,?,?)",
          [d.ids.next(), r.id, input.idempotencyKey, text, d.clock.now()],
        );
        d.events.appendInTx(tx, sys(ctx), {
          type: "request.changed",
          aggregateId: r.id,
          revision:
            tx.get<{
              n: number;
            }>("SELECT COUNT(*) AS n FROM deferred_inputs WHERE request_id=?", [
              r.id,
            ])!.n + 1,
          payload: {
            requestId: r.id,
            state:
              r.state === "awaiting_scope" && input.scope
                ? "accepted"
                : r.state,
          },
        });
        return status(tx, ctx, r.id);
      });
    },
    async runSnapshot(ctx, id) {
      const read = await d.db.read(ctx, (tx) => {
        const r = run(tx, id);
        if (!r.ok) return r;
        const j = tx.get<JobRow>("SELECT * FROM jobs WHERE id=?", [
          r.value.jobId,
        ])!;
        const visible = status(tx, ctx, j.request_id);
        if (!visible.ok) return visible;
        const steps = tx.all<{
          id: string;
          phase: string;
          summary: string;
          purpose: string | null;
          created_at: string;
        }>(
          "SELECT * FROM investigation_steps WHERE run_id=? ORDER BY created_at,id",
          [id],
        );
        return parseDto("RunSnapshot", {
          run: r.value,
          job: job(j),
          budget: visible.value.budget!,
          steps: steps.map((s) => ({
            id: s.id,
            phase: s.phase,
            summary: s.summary,
            createdAt: s.created_at,
            ...(s.purpose ? { purpose: s.purpose } : {}),
          })),
        });
      });
      return read.ok ? read.value : read;
    },
    async cancel(ctx, input) {
      const valid = parseDesktopInput("requests.cancel", input);
      if (!valid.ok) return valid;
      const requested = await d.db.write(ctx, (tx) => {
        const found = row(tx, ctx, input.requestId);
        if (!found.ok) return found;
        const r = found.value;
        if (ctx.actor.role === "delegation") {
          const subscriptions = d.subscriptions.listInTx(tx, ctx, r.id);
          if (!subscriptions.ok) return subscriptions;
          const sub = subscriptions.value.find(
            (s) => s.bindingId === ctx.actor.originBindingId,
          );
          if (!sub?.canCancel) {
            const before = status(tx, ctx, r.id);
            if (!before.ok) return before;
            const withdrawn = d.subscriptions.withdrawInTx(tx, ctx, {
              requestId: r.id,
              bindingId: ctx.actor.originBindingId!,
            });
            return withdrawn.ok
              ? ok({ ...before.value, subscriptionCancelled: true })
              : withdrawn;
          }
        }
        if (!r.job_id) {
          tx.run(
            "UPDATE investigation_requests SET state='withdrawn' WHERE id=?",
            [r.id],
          );
          d.events.appendInTx(tx, sys(ctx), {
            type: "request.changed",
            aggregateId: r.id,
            revision: 2,
            payload: { requestId: r.id, state: "withdrawn" },
          });
          return status(tx, ctx, r.id);
        }
        const j = tx.get<JobRow>("SELECT * FROM jobs WHERE id=?", [r.job_id])!;
        if (terminal.has(j.state)) return status(tx, ctx, r.id);
        if (!j.run_id) {
          const ended = finish(tx, sys(ctx), j, {
            terminalState: "cancelled",
            reason: input.reason,
          });
          return ended.ok ? status(tx, ctx, r.id) : ended;
        }
        tx.run("UPDATE analysis_runs SET tool_epoch=tool_epoch+1 WHERE id=?", [
          j.run_id,
        ]);
        transition(tx, sys(ctx), j, "cancel_requested");
        return status(tx, ctx, r.id);
      });
      if (
        !requested.ok ||
        requested.value.subscriptionCancelled ||
        requested.value.job?.state !== "cancel_requested" ||
        !requested.value.job.runId
      )
        return requested;
      const revoked = await d.channels.revoke(
        sys(ctx),
        requested.value.job.runId,
      );
      if (!revoked.ok) return revoked;
      return observe(
        sys(ctx),
        input.requestId,
        await d.execution.abort(sys(ctx), requested.value.job.runId),
      );
    },
    async resume(ctx, input) {
      const valid = parseDesktopInput("requests.resume", input);
      if (!valid.ok) return valid;
      return d.db.write(ctx, (tx) => {
        const r = row(tx, ctx, input.requestId);
        if (!r.ok) return r;
        if (!r.value.job_id) return fail("NEEDS_INPUT", "请求缺少范围");
        const j = tx.get<JobRow>("SELECT * FROM jobs WHERE id=?", [
          r.value.job_id,
        ])!;
        if (j.revision !== input.expectedJobRevision)
          return fail("REVISION_CONFLICT", "任务版本已改变");
        if (j.state !== "queued" || !j.recovery_hold)
          return fail("CONFLICT", "只能恢复明确未提交的排队任务");
        if (j.expires_at <= d.clock.now())
          return fail("EXPIRED", "旧请求已过期，请新建请求");
        tx.run(
          "UPDATE jobs SET recovery_hold=0,revision=revision+1 WHERE id=?",
          [j.id],
        );
        d.events.appendInTx(tx, sys(ctx), {
          type: "job.changed",
          aggregateId: j.id,
          revision: j.revision + 1,
          payload: { jobId: j.id, state: "queued", revision: j.revision + 1 },
        });
        return status(tx, ctx, r.value.id);
      });
    },
    async reconcile(ctx, input) {
      const valid = parseDesktopInput("requests.reconcile", input);
      if (!valid.ok) return valid;
      const visible = await service.status(ctx, input.requestId);
      if (!visible.ok) return visible;
      const j = visible.value.job;
      if (!j?.runId || j.revision !== input.expectedJobRevision)
        return fail("REVISION_CONFLICT", "轮次或任务版本已改变");
      return observe(
        sys(ctx),
        input.requestId,
        await d.execution.inspect(sys(ctx), j.runId),
      );
    },
    async abandon(ctx, input) {
      const valid = parseDesktopInput("requests.abandon", input);
      if (!valid.ok) return valid;
      const visible = await service.status(ctx, input.requestId);
      if (!visible.ok) return visible;
      const j = visible.value.job;
      if (
        !j?.runId ||
        j.revision !== input.expectedJobRevision ||
        !["uncertain", "cancel_requested"].includes(j.state)
      )
        return fail("REVISION_CONFLICT", "仅可明确放弃当前未知轮次");
      return observe(
        sys(ctx),
        input.requestId,
        fail("UNCERTAIN", "远端可能仍在运行"),
        input.reason + "；本地放弃不证明远端已停止",
      );
    },
    async tick(ctx) {
      if (ctx.actor.role !== "system")
        return fail("FORBIDDEN", "调度仅允许系统调用");
      if (ticking) return ticking;
      ticking = advance(ctx);
      try {
        return await ticking;
      } finally {
        ticking = undefined;
      }
    },
  };
  async function recover(ctx: CallContext): Promise<Result<void>> {
    if (ctx.actor.role !== "system")
      return fail("FORBIDDEN", "恢复仅允许系统调用");
    const marked = await d.db.write(ctx, (tx) => {
      const a = auth(tx, ctx);
      if (!a.ok) return a;
      for (const j of tx.all<JobRow>(
        "SELECT * FROM jobs WHERE state NOT IN ('succeeded','needs_review','failed','cancelled')",
      )) {
        if (j.run_id) {
          tx.run(
            "UPDATE analysis_runs SET tool_epoch=tool_epoch+1 WHERE id=?",
            [j.run_id],
          );
          transition(
            tx,
            ctx,
            j,
            "uncertain",
            j.state === "uncertain" && j.error_json
              ? JSON.parse(j.error_json)
              : uncertainError(j),
          );
        } else if (j.origin === "alert_auto") {
          const ended = finish(tx, ctx, j, {
            terminalState: "cancelled",
            reason: "重启后不补派自动调查",
          });
          if (!ended.ok) return ended;
        } else
          tx.run(
            "UPDATE jobs SET recovery_hold=1,revision=revision+1 WHERE id=?",
            [j.id],
          );
      }
      return ok(undefined);
    });
    if (!marked.ok) return marked;
    const rows = await d.db.read(ctx, (tx) =>
      tx.all<{
        run_id: string;
      }>(
        "SELECT run_id FROM jobs WHERE state='uncertain' AND run_id IS NOT NULL",
      ),
    );
    if (!rows.ok) return rows;
    for (const r of rows.value) {
      const revoked = await d.channels.revoke(ctx, r.run_id);
      if (!revoked.ok) return revoked;
    }
    return ok(undefined);
  }
  return { service, atomic, recover };
}
