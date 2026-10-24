import { randomBytes } from "node:crypto";
import {
  canonicalJson,
  fail,
  idSchema,
  ok,
  parseDto,
  type AnalysisRun,
  type CallContext,
  type ChannelHandle,
  type EvidenceChannelPort,
  type Result,
} from "@campussec/contracts";
import {
  binding,
  channelSecretPurpose,
  digest,
  grantFence,
  handle,
  readResult,
  readRun,
  removeSecrets,
  secretAvailable,
  systemContext,
  type ChannelDependencies,
  type GrantRow,
} from "./grants.js";

export { createChannelAuthenticator } from "./authenticator.js";
export { channelSecretPurpose } from "./grants.js";
export type { ChannelDependencies } from "./grants.js";
export type {
  ChannelAuthentication,
  ChannelCredentials,
} from "./authenticator.js";

export function createEvidenceChannels(
  deps: ChannelDependencies,
): EvidenceChannelPort {
  // Serialize management across secret I/O as well as SQL, so revoke cannot be overtaken by open/bind.
  let tail: Promise<unknown> = Promise.resolve();
  function serialize<T>(work: () => Promise<Result<T>>): Promise<Result<T>> {
    const result = tail
      .then(work)
      .catch(() => fail<T>("INTERNAL", "通道操作失败"));
    tail = result;
    return result;
  }
  async function current(
    ctx: CallContext,
    run: AnalysisRun,
  ): Promise<Result<GrantRow | undefined>> {
    return readResult(deps.db, ctx, (tx) => {
      const saved = readRun(tx, ctx, run.id, deps.clock);
      if (!saved.ok) return saved;
      if (canonicalJson(saved.value) !== canonicalJson(run))
        return fail("REVISION_CONFLICT", "调查轮次已改变");
      return ok(
        tx.get<GrantRow>("SELECT * FROM mcp_grants WHERE run_id=?", [run.id]),
      );
    });
  }
  async function open(
    ctx: CallContext,
    run: AnalysisRun,
  ): Promise<Result<ChannelHandle>> {
    const original = await current(ctx, run);
    if (!original.ok) return original;
    let old = original.value;
    if (old && old.tool_epoch >= run.toolEpoch) {
      const fence = grantFence(old, run, deps.clock);
      if (!fence.ok) return fence;
      const available = await secretAvailable(deps.secrets, old);
      if (!available.ok) return available;
      const checked = await current(ctx, run);
      if (!checked.ok) return checked;
      if (!checked.value || canonicalJson(checked.value) !== canonicalJson(old))
        return fail("CONFLICT", "通道已改变");
      return handle(old);
    }
    if (old) {
      // Keep the old reference until cleanup succeeds, so a failed rotation remains retryable.
      const expected = old;
      const revoked = await deps.db.write(ctx, (tx) => {
        const live = readRun(tx, ctx, run.id, deps.clock);
        if (!live.ok) return live;
        if (canonicalJson(live.value) !== canonicalJson(run))
          return fail("REVISION_CONFLICT", "调查轮次已改变");
        const existing = tx.get<GrantRow>(
          "SELECT * FROM mcp_grants WHERE run_id=?",
          [run.id],
        );
        if (!existing || canonicalJson(existing) !== canonicalJson(expected))
          return fail("CONFLICT", "通道已改变");
        tx.run("UPDATE mcp_grants SET state='revoked' WHERE id=?", [
          existing.id,
        ]);
        return ok({ ...existing, state: "revoked" as const });
      });
      if (!revoked.ok) return revoked;
      old = revoked.value;
      const cleaned = await removeSecrets(deps.secrets, [old.secret_ref]);
      if (!cleaned.ok) return cleaned;
    }
    const id = deps.ids.next();
    if (!idSchema.safeParse(id).success)
      return fail("INVALID_INPUT", "通道标识无效");
    const token = new TextEncoder().encode(
      randomBytes(32).toString("base64url"),
    );
    const tokenDigest = digest(token);
    let stored: Result<string>;
    try {
      stored = await deps.secrets.put({
        owner: ctx.actor.principalId,
        purpose: channelSecretPurpose(id),
        value: token,
        persist: false,
      });
    } catch {
      return fail("SECRET_STORE_UNAVAILABLE", "通道秘密创建失败");
    } finally {
      token.fill(0);
    }
    if (!stored.ok) return fail("SECRET_STORE_UNAVAILABLE", "通道秘密创建失败");
    const row: GrantRow = {
      id,
      run_id: run.id,
      role: "evidence",
      token_digest: tokenDigest,
      secret_ref: stored.value,
      tool_epoch: run.toolEpoch,
      state: "pending",
      binding_json: null,
      expires_at: run.expiresAt,
    };
    let saved: Result<ChannelHandle>;
    try {
      saved = await deps.db.write(ctx, (tx) => {
        const live = readRun(tx, ctx, run.id, deps.clock);
        if (!live.ok) return live;
        if (canonicalJson(live.value) !== canonicalJson(run))
          return fail("REVISION_CONFLICT", "调查轮次已改变");
        const existing = tx.get<GrantRow>(
          "SELECT * FROM mcp_grants WHERE run_id=?",
          [run.id],
        );
        if (canonicalJson(existing ?? null) !== canonicalJson(old ?? null))
          return fail("CONFLICT", "通道已被其他操作改变");
        const valid = handle(row);
        if (!valid.ok) return valid;
        tx.run(
          `INSERT INTO mcp_grants(id,run_id,role,token_digest,secret_ref,tool_epoch,state,binding_json,expires_at)
          VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET id=excluded.id, role=excluded.role,
          token_digest=excluded.token_digest, secret_ref=excluded.secret_ref, tool_epoch=excluded.tool_epoch,
          state=excluded.state, binding_json=excluded.binding_json, expires_at=excluded.expires_at`,
          [
            row.id,
            row.run_id,
            row.role,
            row.token_digest,
            row.secret_ref,
            row.tool_epoch,
            row.state,
            null,
            row.expires_at,
          ],
        );
        return valid;
      });
    } catch {
      saved = fail("STORAGE_UNAVAILABLE", "通道保存失败");
    }
    if (!saved.ok) {
      const cleaned = await removeSecrets(deps.secrets, [stored.value]);
      return cleaned.ok ? saved : cleaned;
    }
    return saved;
  }
  return {
    openChannel(ctx, run) {
      const parsed = parseDto("AnalysisRun", run);
      if (!parsed.ok) return Promise.resolve(parsed);
      const caller = systemContext(ctx, parsed.value.id);
      if (!caller.ok) return Promise.resolve(caller);
      return serialize(() => open(caller.value, parsed.value));
    },
    bindChannel(ctx, input) {
      if (
        !input ||
        Object.keys(input).sort().join(",") !==
          "channelId,runId,trustedSessionBindingId" ||
        ![input.channelId, input.runId, input.trustedSessionBindingId].every(
          (id) => idSchema.safeParse(id).success,
        )
      )
        return Promise.resolve(fail("INVALID_INPUT", "通道绑定参数无效"));
      const caller = systemContext(ctx, input.runId);
      if (!caller.ok) return Promise.resolve(caller);
      const { channelId, runId, trustedSessionBindingId } = input;
      return serialize(async () => {
        const found = await readResult(deps.db, caller.value, (tx) => {
          const row = tx.get<GrantRow>(
            "SELECT * FROM mcp_grants WHERE id=? AND run_id=?",
            [channelId, runId],
          );
          return row ? ok(row) : fail("NOT_FOUND", "通道不存在");
        });
        if (!found.ok) return found;
        const available = await secretAvailable(deps.secrets, found.value);
        if (!available.ok) return available;
        return deps.db.write(caller.value, (tx) => {
          const run = readRun(tx, caller.value, runId, deps.clock);
          if (!run.ok) return run;
          const row = tx.get<GrantRow>(
            "SELECT * FROM mcp_grants WHERE id=? AND run_id=?",
            [channelId, runId],
          );
          if (!row) return fail("NOT_FOUND", "通道不存在");
          const fence = grantFence(row, run.value, deps.clock);
          if (!fence.ok) return fence;
          if (canonicalJson(row) !== canonicalJson(found.value))
            return fail("CONFLICT", "通道已改变");
          const bound = binding(
            caller.value,
            run.value,
            trustedSessionBindingId,
          );
          if (row.state === "active")
            return row.binding_json === bound
              ? handle(row)
              : fail("CONFLICT", "通道已绑定其他会话");
          for (const other of tx.all<GrantRow>(
            "SELECT * FROM mcp_grants WHERE state='active' AND id<>?",
            [channelId],
          )) {
            try {
              if (
                JSON.parse(other.binding_json ?? "null")
                  ?.trustedSessionBindingId === trustedSessionBindingId
              )
                return fail("CONFLICT", "可信会话已绑定其他通道");
            } catch {
              return fail("VALIDATION_FAILED", "已有通道绑定损坏");
            }
          }
          tx.run(
            "UPDATE mcp_grants SET state='active',binding_json=? WHERE id=?",
            [bound, channelId],
          );
          return handle({ ...row, state: "active", binding_json: bound });
        });
      });
    },
    revoke(ctx, runId) {
      if (!idSchema.safeParse(runId).success)
        return Promise.resolve(fail("INVALID_INPUT", "轮次标识无效"));
      const caller = systemContext(ctx, runId);
      if (!caller.ok) return Promise.resolve(caller);
      return serialize(async () => {
        const saved = await deps.db.write(caller.value, (tx) => {
          const refs = tx.all<{ secret_ref: string }>(
            "SELECT secret_ref FROM mcp_grants WHERE run_id=?",
            [runId],
          );
          tx.run("UPDATE mcp_grants SET state='revoked' WHERE run_id=?", [
            runId,
          ]);
          return ok(refs.map((row) => row.secret_ref));
        });
        return saved.ok ? removeSecrets(deps.secrets, saved.value) : saved;
      });
    },
    revokeAll(ctx) {
      const caller = systemContext(ctx);
      if (!caller.ok) return Promise.resolve(caller);
      return serialize(async () => {
        const saved = await deps.db.write(caller.value, (tx) => {
          const refs = tx.all<{ secret_ref: string }>(
            "SELECT secret_ref FROM mcp_grants",
          );
          tx.run("UPDATE mcp_grants SET state='revoked'");
          return ok(refs.map((row) => row.secret_ref));
        });
        return saved.ok ? removeSecrets(deps.secrets, saved.value) : saved;
      });
    },
  };
}
