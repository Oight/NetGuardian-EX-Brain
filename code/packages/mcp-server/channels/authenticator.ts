import {
  canonicalJson,
  fail,
  idSchema,
  ok,
  type CallContext,
  type Result,
} from "@campussec/contracts";
import {
  binding,
  digest,
  equalDigest,
  grantFence,
  readResult,
  readRun,
  secretAvailable,
  systemContext,
  type ChannelDependencies,
  type GrantRow,
} from "./grants.js";

/** Transport-internal input: trustedSessionBindingId comes from the trusted host adapter, never tool arguments. */
export interface ChannelCredentials {
  channelId: string;
  token: Uint8Array;
  trustedSessionBindingId: string;
}
export interface ChannelAuthentication {
  context: CallContext;
  transportBindingId: string;
}
export function createChannelAuthenticator(
  deps: Pick<ChannelDependencies, "db" | "secrets" | "clock">,
) {
  return {
    async authenticate(
      ctx: CallContext,
      input: ChannelCredentials,
    ): Promise<Result<ChannelAuthentication>> {
      const caller = systemContext(ctx);
      if (!caller.ok) return caller;
      if (
        !input ||
        Object.keys(input).sort().join(",") !==
          "channelId,token,trustedSessionBindingId" ||
        !idSchema.safeParse(input.channelId).success ||
        !idSchema.safeParse(input.trustedSessionBindingId).success ||
        !(input.token instanceof Uint8Array) ||
        input.token.byteLength !== 43 ||
        !/^[A-Za-z0-9_-]{43}$/.test(Buffer.from(input.token).toString("utf8"))
      )
        return fail("UNAUTHENTICATED", "通道凭据无效");
      const channelId = input.channelId,
        trustedSessionBindingId = input.trustedSessionBindingId;
      const tokenDigest = digest(input.token);
      const first = await readResult(deps.db, caller.value, (tx) => {
        const grant = tx.get<GrantRow>("SELECT * FROM mcp_grants WHERE id=?", [
          channelId,
        ]);
        if (!grant || !equalDigest(grant.token_digest, tokenDigest))
          return fail("UNAUTHENTICATED", "通道凭据无效");
        const run = readRun(tx, caller.value, grant.run_id, deps.clock);
        if (!run.ok) return run;
        const fence = grantFence(grant, run.value, deps.clock);
        if (!fence.ok) return fence;
        if (
          grant.state !== "active" ||
          grant.binding_json !==
            binding(caller.value, run.value, trustedSessionBindingId)
        )
          return fail("FORBIDDEN", "通道尚未绑定当前可信会话");
        return ok(grant);
      });
      if (!first.ok) return first;
      const available = await secretAvailable(deps.secrets, first.value);
      if (!available.ok) return available;
      // SecretPort is asynchronous. Recheck all persisted fences after it, immediately before admission.
      return readResult(deps.db, caller.value, (tx) => {
        const grant = tx.get<GrantRow>("SELECT * FROM mcp_grants WHERE id=?", [
          channelId,
        ]);
        if (!grant || canonicalJson(grant) !== canonicalJson(first.value))
          return fail("FORBIDDEN", "通道授权已改变");
        const run = readRun(tx, caller.value, grant.run_id, deps.clock);
        if (!run.ok) return run;
        const fence = grantFence(grant, run.value, deps.clock);
        if (!fence.ok) return fence;
        if (
          grant.state !== "active" ||
          grant.binding_json !==
            binding(caller.value, run.value, trustedSessionBindingId)
        )
          return fail("FORBIDDEN", "通道绑定已改变");
        return ok({
          context: {
            actor: {
              spaceId: caller.value.actor.spaceId,
              principalId: caller.value.actor.principalId,
              identityEpoch: run.value.identityEpoch,
              role: "evidence",
              runId: run.value.id,
            },
            traceId: caller.value.traceId,
          },
          transportBindingId: trustedSessionBindingId,
        });
      });
    },
  };
}
