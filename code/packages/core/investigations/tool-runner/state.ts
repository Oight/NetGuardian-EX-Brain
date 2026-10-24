import { createHash } from "node:crypto";
import {
  canonicalJson,
  fail,
  ok,
  parseDto,
  parseControlToolEnvelope,
  parseEvidenceToolEnvelope,
  type AnalysisRun,
  type BudgetState,
  type CallContext,
  type CaseAtomicPort,
  type ClockPort,
  type ContextRef,
  type DatabasePort,
  type EventPort,
  type EvidenceRef,
  type FrozenRunInput,
  type IdPort,
  type PlatformQueryPort,
  type PreparedProfile,
  type ReadTx,
  type ReportProposalPort,
  type Result,
  type RunBudgetAtomicPort,
  type RunBudgetPort,
  type ToolReply,
  type WriteTx,
} from "@campussec/contracts";

export interface Dependencies {
  db: DatabasePort;
  events: EventPort;
  clock: ClockPort;
  ids: IdPort;
  budget: RunBudgetPort;
  budgetAtomic: RunBudgetAtomicPort;
  query: PlatformQueryPort;
  casesAtomic: CaseAtomicPort;
  proposals: ReportProposalPort;
}
export interface State {
  run: AnalysisRun;
  initial: FrozenRunInput;
  profile: PreparedProfile;
  hash: string;
}
export interface CallRow {
  id: string;
  transport_binding_id: string;
  call_id: string;
  argument_hash: string;
  tool_name: string;
  run_id: string;
  reservation_id: string;
  state: string;
  reply_json: string | null;
  projection_ids_json: string;
}
/** Private S07 ledger envelope; never accepted from a model. */
export interface Payload {
  formatVersion: 1;
  stateHash: string;
  contextRefs: ContextRef[];
  purpose?: string;
  pageReceipt?: {
    pageId: string;
    contentHash: string;
    queryHash: string;
    refs: EvidenceRef[];
  };
  reply?: ToolReply;
}
export const hash = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
export function current(
  deps: Dependencies,
  tx: WriteTx,
  ctx: CallContext,
  runId: string,
): Result<State> {
  const run = deps.budgetAtomic.assertRunOpenInTx(tx, ctx, runId);
  if (!run.ok) return run;
  const row = tx.get<{
    initial_input_json: string;
    prepared_profile_json: string | null;
  }>(
    "SELECT initial_input_json,prepared_profile_json FROM analysis_runs WHERE id=?",
    [runId],
  );
  try {
    const initial = parseDto(
      "FrozenRunInput",
      JSON.parse(row!.initial_input_json),
    );
    const profile = parseDto(
      "PreparedProfile",
      JSON.parse(row!.prepared_profile_json ?? "null"),
    );
    if (!initial.ok || !profile.ok)
      return fail("RESULT_NOT_READY", "本轮输入与配置尚未准备完毕");
    if (
      canonicalJson(initial.value.scope) !== canonicalJson(run.value.scope) ||
      profile.value.version !== run.value.profileVersion
    )
      return fail("CONFLICT", "冻结输入与轮次不一致");
    if (
      profile.value.contextRefs.some(
        (ref) =>
          !initial.value.contexts.some(
            (c) => c.id === ref.contextId && c.version === ref.version,
          ),
      )
    )
      return fail("VALIDATION_FAILED", "配置背景不属于冻结输入");
    return ok({
      run: run.value,
      initial: initial.value,
      profile: profile.value,
      hash: hash({ initial: initial.value, profile: profile.value }),
    });
  } catch {
    return fail("VALIDATION_FAILED", "本轮冻结输入损坏");
  }
}
export function payload(row: CallRow): Result<Payload> {
  try {
    const value = JSON.parse(row.reply_json ?? "null") as Payload | null;
    if (
      !value ||
      value.formatVersion !== 1 ||
      typeof value.stateHash !== "string" ||
      !Array.isArray(value.contextRefs)
    )
      return fail("UNCERTAIN", "调用缺少可核实的回复记录");
    return ok(value);
  } catch {
    return fail("VALIDATION_FAILED", "调用缓存损坏");
  }
}
export function findCall(tx: ReadTx, binding: string, callId: string) {
  return tx.get<CallRow>(
    "SELECT * FROM mcp_calls WHERE transport_binding_id=? AND call_id=?",
    [binding, callId],
  );
}
export function fence(tx: ReadTx, state: State, row: CallRow): Result<Payload> {
  if (row.run_id !== state.run.id) return fail("FORBIDDEN", "调用不属于本轮");
  const reservation = tx.get<{
    tool_epoch: number;
    identity_epoch: number;
    connection_generation: number;
    expires_at: string;
  }>(
    "SELECT tool_epoch,identity_epoch,connection_generation,expires_at FROM tool_reservations WHERE id=? AND run_id=?",
    [row.reservation_id, state.run.id],
  );
  if (
    !reservation ||
    reservation.tool_epoch !== state.run.toolEpoch ||
    reservation.identity_epoch !== state.run.identityEpoch ||
    reservation.connection_generation !== state.run.connectionGeneration ||
    reservation.expires_at !== state.run.expiresAt
  )
    return fail("IDENTITY_CHANGED", "旧调用凭据已失效");
  if (row.state === "expired") return fail("EXPIRED", "回复正文已过期");
  const stored = payload(row);
  if (!stored.ok) return stored;
  return stored.value.stateHash === state.hash
    ? stored
    : fail("CONFLICT", "调用后冻结输入已变化");
}
export function budgetState(tx: ReadTx, run: AnalysisRun): BudgetState {
  const tools = tx.get<{ tools: number; reads: number }>(
    "SELECT COUNT(*) AS tools,COALESCE(SUM(is_read),0) AS reads FROM tool_reservations WHERE run_id=?",
    [run.id],
  )!;
  const count = (table: string) =>
    tx.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id=?`, [
      run.id,
    ])!.n;
  return {
    runId: run.id,
    toolsUsed: tools.tools,
    readsUsed: tools.reads,
    platformAttempts: count("platform_attempts"),
    distinctEvents: count("run_event_keys"),
    deadline: run.expiresAt,
    closed: false,
  };
}
export function cache(
  tx: WriteTx,
  row: CallRow,
  stored: Payload,
  reply: ToolReply,
  contextRefs: ContextRef[] = [],
): Result<ToolReply> {
  tx.run(
    "UPDATE mcp_calls SET state='prepared',reply_json=?,projection_ids_json=? WHERE id=?",
    [
      canonicalJson({ ...stored, reply, contextRefs }),
      canonicalJson(reply.preparedProjectionIds),
      row.id,
    ],
  );
  return ok(reply);
}
export function cachedReply(
  deps: Dependencies,
  tx: ReadTx,
  ctx: CallContext,
  state: State,
  row: CallRow,
  stored: Payload,
): Result<ToolReply> {
  if (!stored.reply || row.state === "inflight")
    return fail("UNCERTAIN", "调用已受理，执行结果尚不确定；不得重新查询");
  const parsed = parseDto("ToolReply", stored.reply);
  if (!parsed.ok) return fail("VALIDATION_FAILED", "缓存回复无效");
  try {
    if (
      canonicalJson(JSON.parse(parsed.value.text)) !==
        canonicalJson(parsed.value.structured) ||
      canonicalJson(parsed.value.preparedProjectionIds) !==
        row.projection_ids_json
    )
      return fail("VALIDATION_FAILED", "缓存正文与投影记录不一致");
    const envelope = ["record_investigation_step", "propose_report"].includes(
      row.tool_name,
    )
      ? parseControlToolEnvelope(parsed.value.structured)
      : parseEvidenceToolEnvelope(parsed.value.structured);
    if (!envelope.ok) return fail("VALIDATION_FAILED", "缓存信封无效");
  } catch {
    return fail("VALIDATION_FAILED", "缓存正文无效");
  }
  const view = deps.casesAtomic.inspectRunInTx(tx, ctx, state.run);
  if (!view.ok) return view;
  if (
    parsed.value.preparedProjectionIds.some(
      (id) =>
        !view.value.projections.some(
          (p) => p.id === id && p.availability === "available",
        ),
    )
  )
    return fail("EXPIRED", "回复所含材料已过期");
  return ok(parsed.value);
}
