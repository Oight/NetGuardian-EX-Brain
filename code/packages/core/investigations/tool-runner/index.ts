import {
  canonicalJson,
  callContextSchema,
  fail,
  idSchema,
  ok,
  parseToolInvocation,
  parseWith,
  type CallContext,
  type ContextRef,
  type InvestigationStepInput,
  type InvestigationToolPort,
  type PlatformPage,
  type Result,
  type ToolInvocation,
  type ToolReply,
  type ToolReplyAtomicPort,
  type WriteTx,
} from "@campussec/contracts";
import { command, safeContent, safeField, type Command } from "./arguments.js";
import { control, evidence, failure, record } from "./replies.js";
import { executeQuery, failedPage } from "./query.js";
import {
  budgetState,
  cache,
  cachedReply,
  current,
  fence,
  findCall,
  hash,
  payload,
  type CallRow,
  type Dependencies,
  type Payload,
  type State,
} from "./state.js";
export type { Dependencies as InvestigationToolsDependencies } from "./state.js";

interface Admission {
  state: State;
  row: CallRow;
  stored: Payload;
  command: Command;
  cached?: ToolReply;
}
const isRead = (cmd: Command) => cmd.kind !== "step" && cmd.kind !== "proposal";

/** S07 application use cases only. Construction performs no IO or registration. */
export function createInvestigationTools(
  deps: Dependencies,
): InvestigationToolPort {
  function stepInTx(
    tx: WriteTx,
    ctx: CallContext,
    state: State,
    step: InvestigationStepInput,
  ): Result<string> {
    const view = deps.casesAtomic.inspectRunInTx(tx, ctx, state.run);
    if (!view.ok) return view;
    if (
      step.evidenceRefs.some(
        (ref) =>
          !view.value.projections.some(
            (p) =>
              p.id === ref.projectionId &&
              p.ref.evidenceId === ref.evidenceId &&
              p.ref.version === ref.version &&
              p.state === "released" &&
              p.availability === "available",
          ),
      )
    )
      return fail("FORBIDDEN", "步骤只能引用本轮已确认交付的投影");
    const id = deps.ids.next();
    tx.run(
      "INSERT INTO investigation_steps(id,run_id,phase,summary,purpose,evidence_refs_json,created_at) VALUES(?,?,?,?,?,?,?)",
      [
        id,
        state.run.id,
        step.phase,
        step.summary,
        step.purpose ?? null,
        canonicalJson(step.evidenceRefs),
        deps.clock.now(),
      ],
    );
    const revision = tx.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM investigation_steps WHERE run_id=?",
      [state.run.id],
    )!.n;
    deps.events.appendInTx(tx, ctx, {
      type: "investigation.step",
      aggregateId: state.run.id,
      revision,
      payload: { runId: state.run.id, stepId: id, summary: step.summary },
    });
    return ok(id);
  }
  function deliveredContexts(tx: WriteTx, state: State) {
    // PreparedProfile is preparation, not proof of delivery. Until host receipt
    // persistence exists, only acknowledged context replies authorize references.
    const refs = new Set<string>();
    for (const row of tx.all<CallRow>(
      "SELECT * FROM mcp_calls WHERE run_id=? AND tool_name='get_case_context' AND state='released'",
      [state.run.id],
    )) {
      const stored = fence(tx, state, row);
      if (stored.ok)
        for (const ref of stored.value.contextRefs)
          refs.add(`${ref.contextId}:${ref.version}`);
    }
    return state.initial.contexts
      .filter((c) => refs.has(`${c.id}:${c.version}`))
      .map((context) => ({
        ref: { contextId: context.id, version: context.version },
        context,
      }));
  }
  function admit(
    ctx: CallContext,
    invocation: ToolInvocation,
  ): Promise<Result<Admission>> {
    return deps.db.write(ctx, (tx) => {
      const state = current(deps, tx, ctx, ctx.actor.runId!);
      if (!state.ok) return state;
      const parsed = command(
        invocation.toolName,
        invocation.arguments,
        state.value,
      );
      if (!parsed.ok) return parsed;
      const argumentHash = hash({
        toolName: invocation.toolName,
        command: parsed.value,
      });
      const previous = findCall(
        tx,
        invocation.transportBindingId,
        invocation.callId,
      );
      if (previous) {
        if (
          previous.argument_hash !== argumentHash ||
          previous.tool_name !== invocation.toolName
        )
          return fail("CONFLICT", "同一调用标识不得更换参数或工具");
        const stored = fence(tx, state.value, previous);
        if (!stored.ok) return stored;
        const reply = cachedReply(
          deps,
          tx,
          ctx,
          state.value,
          previous,
          stored.value,
        );
        return reply.ok
          ? ok({
              state: state.value,
              row: previous,
              stored: stored.value,
              command: parsed.value,
              cached: reply.value,
            })
          : reply;
      }
      const seeds = deps.budgetAtomic.recordEventsInTx(tx, ctx, {
        runId: state.value.run.id,
        sourceKeys: state.value.initial.seedRefs.map((ref) => ref.evidenceId),
      });
      if (!seeds.ok) return seeds;
      const reserved = deps.budgetAtomic.reserveToolInTx(tx, ctx, {
        runId: state.value.run.id,
        toolName: invocation.toolName,
        isRead: isRead(parsed.value),
      });
      if (!reserved.ok) return reserved;
      const stored: Payload = {
        formatVersion: 1,
        stateHash: state.value.hash,
        contextRefs: [],
        ...(parsed.value.kind === "query" && parsed.value.purpose
          ? { purpose: parsed.value.purpose }
          : {}),
      };
      const row: CallRow = {
        id: deps.ids.next(),
        transport_binding_id: invocation.transportBindingId,
        call_id: invocation.callId,
        argument_hash: argumentHash,
        tool_name: invocation.toolName,
        run_id: state.value.run.id,
        reservation_id: reserved.value.id,
        state: "inflight",
        reply_json: canonicalJson(stored),
        projection_ids_json: "[]",
      };
      tx.run(
        "INSERT INTO mcp_calls(id,transport_binding_id,call_id,argument_hash,tool_name,run_id,reservation_id,state,reply_json,projection_ids_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        [
          row.id,
          row.transport_binding_id,
          row.call_id,
          row.argument_hash,
          row.tool_name,
          row.run_id,
          row.reservation_id,
          row.state,
          row.reply_json,
          row.projection_ids_json,
          deps.clock.now(),
        ],
      );
      return ok({ state: state.value, row, stored, command: parsed.value });
    });
  }
  function complete(
    ctx: CallContext,
    admitted: Admission,
    page?: PlatformPage,
  ): Promise<Result<ToolReply>> {
    return deps.db.write(ctx, (tx) => {
      const state = current(deps, tx, ctx, admitted.state.run.id);
      if (!state.ok) return state;
      const row = findCall(
        tx,
        admitted.row.transport_binding_id,
        admitted.row.call_id,
      )!;
      const stored = fence(tx, state.value, row);
      if (!stored.ok) return stored;
      if (row.state !== "inflight")
        return cachedReply(deps, tx, ctx, state.value, row, stored.value);
      const cmd = admitted.command;
      let reply: Result<ToolReply>;
      let contextRefs: ContextRef[] = [];
      let pageReceipt: Payload["pageReceipt"];
      if (cmd.kind === "query") {
        if (!page) return fail("INTERNAL", "查询结果缺失");
        const captureQuery =
          page.pageOrdinal === 0 &&
          page.coverage.queryCompleteness === "not_executed"
            ? { ...cmd.query, page: { limit: cmd.query.page.limit } }
            : cmd.query;
        // S04 may replay a stable page with zero NEW attempts. S06's immutable
        // snapshot includes its original attempt count, so reuse our own exact
        // receipt instead of recapturing a changed page or touching S06 tables.
        const { platformAttempts: _attempts, ...pageContent } = page;
        const contentHash = hash(pageContent);
        const queryHash = hash(cmd.query);
        let priorReceipt: Payload["pageReceipt"];
        for (const prior of tx.all<CallRow>(
          "SELECT * FROM mcp_calls WHERE run_id=? AND state!='expired'",
          [state.value.run.id],
        )) {
          const checked = fence(tx, state.value, prior);
          if (!checked.ok || checked.value.pageReceipt?.pageId !== page.pageId)
            continue;
          if (
            checked.value.pageReceipt.contentHash !== contentHash ||
            checked.value.pageReceipt.queryHash !== queryHash
          )
            return fail("CONFLICT", "同页内容或查询改变，已保存快照保持不变");
          priorReceipt = checked.value.pageReceipt;
          break;
        }
        const refs = priorReceipt
          ? ok(priorReceipt.refs)
          : deps.casesAtomic.captureInTx(tx, ctx, {
              runId: state.value.run.id,
              connectionId: state.value.run.scope.connectionId,
              query: captureQuery,
              page,
            });
        if (!refs.ok) return refs;
        pageReceipt = {
          pageId: page.pageId,
          contentHash,
          queryHash,
          refs: refs.value,
        };
        // Public evidence identity deduplicates source events across content versions.
        // Capture + budget accounting + projections/cache commit or roll back together.
        const counted = deps.budgetAtomic.recordEventsInTx(tx, ctx, {
          runId: state.value.run.id,
          sourceKeys: refs.value.map((ref) => ref.evidenceId),
        });
        if (!counted.ok) return counted;
        const fields = [
          ...new Set(page.records.flatMap((r) => Object.keys(r.fields))),
        ].filter((key) =>
          page.records.every(
            (r) =>
              !Object.hasOwn(r.fields, key) || safeField(key, r.fields[key]),
          ),
        );
        const projections = deps.casesAtomic.projectInTx(tx, ctx, {
          runId: state.value.run.id,
          refs: refs.value,
          fieldNames: fields.length ? fields : ["agent.id"],
        });
        if (!projections.ok) return projections;
        const result = evidence({
          schemaVersion: "0.1.0",
          status: page.status,
          queryId: page.queryId,
          records: projections.value.map(record),
          coverage: page.coverage,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          budget: budgetState(tx, state.value.run),
          warnings: [
            ...page.warnings,
            ...(page.records.some((r) =>
              Object.keys(r.fields).some((k) => !fields.includes(k)),
            )
              ? ["未开放或不安全的字段已省略"]
              : []),
          ],
        });
        if (!result.ok) return result;
        if (cmd.step) {
          const step = stepInTx(tx, ctx, state.value, cmd.step);
          if (!step.ok) return step;
        }
        reply = ok(result.value.reply);
      } else if (cmd.kind === "context") {
        const view = deps.casesAtomic.inspectRunInTx(tx, ctx, state.value.run);
        if (!view.ok) return view;
        const selected = state.value.profile.seedProjectionIds.map((id) =>
          view.value.projections.find((p) => p.id === id),
        );
        if (
          selected.some(
            (p) =>
              !p ||
              p.availability !== "available" ||
              !state.value.initial.seedRefs.some(
                (ref) =>
                  ref.evidenceId === p.ref.evidenceId &&
                  ref.version === p.ref.version,
              ),
          )
        )
          return fail("EXPIRED", "配置种子投影无效或已过期");
        const safe = selected.filter((p) => p && safeContent(p.content));
        const result = evidence({
          schemaVersion: "0.1.0",
          status: selected.length === safe.length ? "ok" : "partial",
          records: safe.map((p) => record(p!)),
          budget: budgetState(tx, state.value.run),
          warnings:
            selected.length === safe.length ? [] : ["不安全的种子投影已省略"],
          context: {
            question: state.value.initial.question,
            scope: state.value.initial.scope,
            capabilities: state.value.initial.capabilities,
            backgrounds: state.value.profile.contextRefs.map((ref) => ({
              ref,
              context: state.value.initial.contexts.find(
                (c) => c.id === ref.contextId && c.version === ref.version,
              )!,
            })),
          },
        });
        if (!result.ok) return result;
        contextRefs = result.value.contextRefs;
        reply = ok(result.value.reply);
      } else if (cmd.kind === "evidence") {
        const projections = deps.casesAtomic.projectInTx(tx, ctx, {
          runId: state.value.run.id,
          refs: [cmd.ref],
          fieldNames: cmd.fieldNames,
        });
        if (!projections.ok) return projections;
        if (projections.value.some((p) => !safeContent(p.content)))
          return fail("FORBIDDEN", "投影包含未开放的嵌套字段");
        const result = evidence({
          schemaVersion: "0.1.0",
          status: "ok",
          records: projections.value.map(record),
          budget: budgetState(tx, state.value.run),
          warnings: [],
        });
        reply = result.ok ? ok(result.value.reply) : result;
      } else if (cmd.kind === "step") {
        const id = stepInTx(tx, ctx, state.value, cmd.step);
        reply = id.ok
          ? control({ stepId: id.value }, budgetState(tx, state.value.run))
          : id;
      } else {
        const view = deps.casesAtomic.inspectRunInTx(tx, ctx, state.value.run);
        if (!view.ok) return view;
        const report = deps.proposals.proposeInTx(tx, ctx, {
          candidate: cmd.candidate,
          validationInput: {
            view: view.value,
            contexts: deliveredContexts(tx, state.value),
          },
        });
        reply = report.ok
          ? control(
              {
                reportId: report.value.id,
                version: report.value.version,
                validation: report.value.validation,
                review: report.value.review,
                issueCount: report.value.validationIssues.length,
                issues: report.value.validationIssues
                  .slice(0, 20)
                  .map((issue) => issue.slice(0, 200)),
              },
              budgetState(tx, state.value.run),
            )
          : report;
      }
      return reply.ok
        ? cache(
            tx,
            row,
            { ...stored.value, ...(pageReceipt ? { pageReceipt } : {}) },
            reply.value,
            contextRefs,
          )
        : reply;
    });
  }
  async function invoke(
    rawCtx: CallContext,
    rawInput: ToolInvocation,
  ): Promise<Result<ToolReply>> {
    const parsedCtx = parseWith<CallContext>(callContextSchema, rawCtx),
      input = parseToolInvocation(rawInput);
    if (!parsedCtx.ok || !input.ok)
      return fail("INVALID_INPUT", "调用参数无效");
    const ctx = parsedCtx.value;
    if (ctx.actor.role !== "evidence" || !ctx.actor.runId)
      return fail("FORBIDDEN", "工具调用需要已认证的本轮取证通道");
    const admitted = await admit(ctx, input.value);
    if (!admitted.ok) return admitted;
    if (admitted.value.cached) return ok(admitted.value.cached);
    const cmd = admitted.value.command;
    const page =
      cmd.kind === "query"
        ? await executeQuery(
            deps,
            ctx,
            admitted.value.state,
            admitted.value.row,
            cmd.query,
          )
        : undefined;
    const completed =
      page && !page.ok
        ? page
        : await complete(
            ctx,
            admitted.value,
            page?.ok ? page.value : undefined,
          );
    if (completed.ok) return completed;
    // A failed application transaction cannot refund committed reservations. Cache
    // a bounded failure separately, only while the exact original fence remains open.
    return deps.db.write(ctx, (tx) => {
      const state = current(deps, tx, ctx, admitted.value.state.run.id);
      if (!state.ok) return state;
      const row = findCall(
        tx,
        input.value.transportBindingId,
        input.value.callId,
      )!;
      const stored = fence(tx, state.value, row);
      if (!stored.ok) return stored;
      if (row.state !== "inflight")
        return cachedReply(deps, tx, ctx, state.value, row, stored.value);
      let reply: Result<ToolReply>;
      if (cmd.kind === "query") {
        const failed = failedPage(
          deps,
          cmd.query,
          completed.error,
          page?.ok ? page.value.platformAttempts : 0,
        );
        const captured = deps.casesAtomic.captureInTx(tx, ctx, {
          runId: state.value.run.id,
          connectionId: state.value.run.scope.connectionId,
          query: { ...cmd.query, page: { limit: cmd.query.page.limit } },
          page: failed,
        });
        if (!captured.ok) return captured;
        const result = evidence({
          schemaVersion: "0.1.0",
          status: failed.status,
          queryId: failed.queryId,
          records: [],
          coverage: failed.coverage,
          budget: budgetState(tx, state.value.run),
          warnings: failed.warnings,
        });
        reply = result.ok ? ok(result.value.reply) : result;
      } else
        reply = failure(
          completed.error,
          budgetState(tx, state.value.run),
          isRead(cmd),
        );
      return reply.ok ? cache(tx, row, stored.value, reply.value) : reply;
    });
  }
  const acknowledgeReply: InvestigationToolPort["acknowledgeReply"] = async (
    rawCtx,
    input,
  ) => {
    const parsed = parseWith<CallContext>(callContextSchema, rawCtx);
    if (
      !parsed.ok ||
      !input ||
      Object.keys(input).some(
        (k) => !["transportBindingId", "callId", "outcome"].includes(k),
      ) ||
      !idSchema.safeParse(input.transportBindingId).success ||
      typeof input.callId !== "string" ||
      !input.callId ||
      Array.from(input.callId).length > 256 ||
      !["released", "uncertain"].includes(input.outcome)
    )
      return fail("INVALID_INPUT", "发送确认参数无效");
    const ctx = parsed.value,
      args = { ...input };
    if (!["system", "evidence"].includes(ctx.actor.role))
      return fail("FORBIDDEN", "发送确认需要可信通道或协调者");
    return deps.db.write(ctx, (tx) => {
      const row = findCall(tx, args.transportBindingId, args.callId);
      if (!row) return fail("NOT_FOUND", "调用记录不存在");
      const state = current(deps, tx, ctx, row.run_id);
      if (!state.ok) return state;
      const stored = fence(tx, state.value, row);
      if (!stored.ok) return stored;
      const reply = cachedReply(deps, tx, ctx, state.value, row, stored.value);
      if (!reply.ok) return reply;
      if (row.state === "released") return ok(undefined);
      const view = deps.casesAtomic.inspectRunInTx(tx, ctx, state.value.run);
      if (!view.ok) return view;
      const released = deps.casesAtomic.releaseInTx(tx, ctx, {
        runId: row.run_id,
        projectionIds: reply.value.preparedProjectionIds.filter(
          (id) =>
            !view.value.projections.some(
              (p) => p.id === id && p.state === "released",
            ),
        ),
        outcome: args.outcome,
      });
      if (!released.ok) return released;
      tx.run("UPDATE mcp_calls SET state=? WHERE id=?", [args.outcome, row.id]);
      return ok(undefined);
    });
  };
  return { invoke, acknowledgeReply };
}

/** Retention coordinator calls this in the same transaction as S06 cleanup. */
export function createToolReplyAtomic(): ToolReplyAtomicPort {
  return {
    expireRepliesInTx(tx, ctx, input) {
      if (!parseWith(callContextSchema, ctx).ok || ctx.actor.role !== "system")
        return fail("FORBIDDEN", "缓存清理需要系统协调者");
      const identity = tx.get<{
        space_id: string;
        principal_id: string;
        identity_epoch: number;
      }>("SELECT space_id,principal_id,identity_epoch FROM space_metadata");
      if (
        !identity ||
        identity.space_id !== ctx.actor.spaceId ||
        identity.principal_id !== ctx.actor.principalId ||
        identity.identity_epoch !== ctx.actor.identityEpoch
      )
        return fail("IDENTITY_CHANGED", "清理主体不匹配");
      if (
        !input ||
        !Array.isArray(input.projectionIds) ||
        input.projectionIds.some((id) => !idSchema.safeParse(id).success)
      )
        return fail("INVALID_INPUT", "清理投影无效");
      const ids = new Set(input.projectionIds);
      for (const row of tx.all<CallRow>(
        "SELECT * FROM mcp_calls WHERE state!='expired'",
      )) {
        const projectionIds: unknown = JSON.parse(row.projection_ids_json);
        if (
          !Array.isArray(projectionIds) ||
          projectionIds.some((id) => typeof id !== "string")
        )
          return fail("VALIDATION_FAILED", "缓存投影索引损坏");
        if (!projectionIds.some((id) => ids.has(id))) continue;
        if (ctx.actor.runId && ctx.actor.runId !== row.run_id)
          return fail("FORBIDDEN", "清理超出协调者轮次");
        tx.run(
          "UPDATE mcp_calls SET state='expired',reply_json=NULL WHERE id=?",
          [row.id],
        );
      }
      return ok(undefined);
    },
  };
}
