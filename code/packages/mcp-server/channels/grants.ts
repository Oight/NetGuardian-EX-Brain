import { createHash, timingSafeEqual } from "node:crypto";
import {
  callContextSchema, canonicalJson, fail, ok, parseDto, parseScope, parseWith,
  type AnalysisRun, type CallContext, type ChannelHandle, type ClockPort,
  type DatabasePort, type IdPort, type ReadTx, type Result, type SecretPort,
} from "@campussec/contracts";

export interface ChannelDependencies {
  db: DatabasePort;
  secrets: SecretPort;
  clock: ClockPort;
  ids: IdPort;
}
export interface GrantRow {
  id: string;
  run_id: string;
  role: string;
  token_digest: string;
  secret_ref: string;
  tool_epoch: number;
  state: ChannelHandle["state"];
  binding_json: string | null;
  expires_at: string;
}
export function systemContext(ctx: CallContext, runId?: string): Result<CallContext> {
  const parsed = parseWith(callContextSchema, ctx);
  if (!parsed.ok) return parsed;
  const actor = parsed.value.actor;
  if (actor.role !== "system" || actor.originBindingId ||
    (actor.runId !== undefined && actor.runId !== runId))
    return fail("FORBIDDEN", "通道管理仅允许可信系统调用");
  return parsed;
}

/** Only a read projection of other owners' identity and lifecycle facts. */
export function readRun(tx: ReadTx, ctx: CallContext, runId: string, clock: ClockPort): Result<AnalysisRun> {
  const row = tx.get<{
    id: string; job_id: string; case_id: string; base_revision: number;
    scope_json: string; connection_generation: number; identity_epoch: number;
    profile_version: string; tool_epoch: number; expires_at: string;
    manifest_hash: string | null; sealed_at: string | null;
    state: string; recovery_hold: number; job_expires_at: string;
    request_principal: string; request_state: string; connection_id: string;
    space_id: string; principal_id: string; space_epoch: number;
  }>(`SELECT r.*, j.state, j.recovery_hold, j.expires_at AS job_expires_at,
      q.principal_id AS request_principal, q.state AS request_state, q.connection_id,
      m.space_id, m.principal_id, m.identity_epoch AS space_epoch
      FROM analysis_runs r JOIN jobs j ON j.id=r.job_id AND j.run_id=r.id AND j.case_id=r.case_id
      JOIN investigation_requests q ON q.id=j.request_id AND q.job_id=j.id AND q.case_id=r.case_id
      CROSS JOIN space_metadata m WHERE r.id=?`, [runId]);
  if (!row) return fail("NOT_FOUND", "调查轮次不存在");
  if (row.space_id !== ctx.actor.spaceId || row.principal_id !== ctx.actor.principalId ||
    row.request_principal !== ctx.actor.principalId || row.request_state !== "accepted")
    return fail("FORBIDDEN", "调查主体或请求不匹配");
  if (row.identity_epoch !== ctx.actor.identityEpoch || row.space_epoch !== ctx.actor.identityEpoch)
    return fail("IDENTITY_CHANGED", "调查身份代次已改变");
  if (row.recovery_hold || row.state === "uncertain")
    return fail("UNCERTAIN", "调查尚待恢复核实");
  if (row.state === "cancel_requested" || row.state === "cancelled")
    return fail("CANCELLED", "调查已请求取消");
  if (!["preparing", "submitting", "running"].includes(row.state) || row.sealed_at)
    return fail("EXPIRED", "调查不再接受取证");
  const now = Date.parse(clock.now()), deadline = Date.parse(row.expires_at), jobDeadline = Date.parse(row.job_expires_at);
  if (![now, deadline, jobDeadline].every(Number.isFinite))
    return fail("VALIDATION_FAILED", "调查期限无效");
  if (deadline <= now || jobDeadline <= now) return fail("EXPIRED", "调查已过期");
  let scope;
  try { scope = parseScope(JSON.parse(row.scope_json)); }
  catch { return fail("VALIDATION_FAILED", "调查作用域损坏"); }
  if (!scope.ok || scope.value.connectionId !== row.connection_id)
    return fail("VALIDATION_FAILED", "调查连接不匹配");
  const connection = tx.get<{ generation: number }>("SELECT generation FROM connections WHERE id=?", [row.connection_id]);
  if (!connection || connection.generation !== row.connection_generation)
    return fail("IDENTITY_CHANGED", "连接代次已改变");
  return parseDto("AnalysisRun", {
    id: row.id, jobId: row.job_id, caseId: row.case_id, baseRevision: row.base_revision,
    scope: scope.value, connectionGeneration: row.connection_generation,
    identityEpoch: row.identity_epoch, profileVersion: row.profile_version,
    toolEpoch: row.tool_epoch, expiresAt: row.expires_at,
    ...(row.manifest_hash ? { manifestHash: row.manifest_hash } : {}),
  });
}

export function grantFence(grant: GrantRow, run: AnalysisRun, clock: ClockPort): Result<void> {
  if (grant.role !== "evidence") return fail("FORBIDDEN", "通道角色不匹配");
  if (grant.state === "revoked") return fail("EXPIRED", "通道已撤销");
  if (grant.tool_epoch !== run.toolEpoch) return fail("IDENTITY_CHANGED", "工具代次已改变");
  const deadline = Date.parse(grant.expires_at), now = Date.parse(clock.now());
  if (!Number.isFinite(deadline) || !Number.isFinite(now) || deadline > Date.parse(run.expiresAt))
    return fail("VALIDATION_FAILED", "通道期限无效");
  if (deadline <= now) return fail("EXPIRED", "通道已过期");
  return ok(undefined);
}
export function binding(ctx: CallContext, run: AnalysisRun, trustedSessionBindingId: string): string {
  return canonicalJson({
    trustedSessionBindingId, spaceId: ctx.actor.spaceId, principalId: ctx.actor.principalId,
    identityEpoch: run.identityEpoch, connectionId: run.scope.connectionId,
    connectionGeneration: run.connectionGeneration, toolEpoch: run.toolEpoch,
  });
}
export function handle(row: GrantRow): Result<ChannelHandle> {
  return parseDto("ChannelHandle", {
    id: row.id, runId: row.run_id, transport: "streamable-http", secretRef: row.secret_ref,
    expiresAt: row.expires_at, state: row.state,
  });
}
/** SecretPort contains the UTF-8 base64url bearer token; the database contains only its digest. */
export const channelSecretPurpose = (channelId: string) => `mcp:evidence:${channelId}`;
export const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
export function equalDigest(a: string, b: string): boolean {
  return /^[0-9a-f]{64}$/.test(a) && /^[0-9a-f]{64}$/.test(b) &&
    timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
export async function secretAvailable(secrets: SecretPort, grant: GrantRow): Promise<Result<void>> {
  try {
    const result = await secrets.use(grant.secret_ref, channelSecretPurpose(grant.id), async (bytes) =>
      equalDigest(digest(bytes), grant.token_digest));
    return result.ok && result.value ? ok(undefined) : fail("SECRET_STORE_UNAVAILABLE", "通道秘密不可用");
  } catch { return fail("SECRET_STORE_UNAVAILABLE", "通道秘密不可用"); }
}
export async function removeSecrets(secrets: SecretPort, refs: string[]): Promise<Result<void>> {
  let failed = false;
  for (const ref of new Set(refs)) {
    try {
      const removed = await secrets.remove(ref);
      if (!removed.ok && removed.error.code !== "NOT_FOUND") failed = true;
    } catch { failed = true; }
  }
  return failed ? fail("SECRET_STORE_UNAVAILABLE", "通道已失效，但秘密清理失败，可重试撤销") : ok(undefined);
}
export async function readResult<T>(db: DatabasePort, ctx: CallContext, work: (tx: ReadTx) => Result<T>): Promise<Result<T>> {
  const result = await db.read(ctx, work);
  return result.ok ? result.value : result;
}
