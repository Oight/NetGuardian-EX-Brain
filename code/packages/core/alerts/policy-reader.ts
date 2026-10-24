import {
  callContextSchema,
  fail,
  idSchema,
  ok,
  parseDto,
  parseWith,
  type AlertPolicyReadPort,
  type DatabasePort,
} from "@campussec/contracts";

/** Read the persisted S05 policy, without starting polling or synthesizing a default policy. */
export function createPolicyReader(deps: {
  db: DatabasePort;
}): AlertPolicyReadPort {
  return {
    async getPolicy(ctx, connectionId) {
      if (!parseWith(callContextSchema, ctx).ok || ctx.actor.role !== "ui")
        return fail("FORBIDDEN", "策略读取仅允许主体界面");
      if (!idSchema.safeParse(connectionId).success)
        return fail("INVALID_INPUT", "连接标识无效");
      const result = await deps.db.read(ctx, (tx) => {
        const owner = tx.get<{
          space_id: string;
          principal_id: string;
          identity_epoch: number;
        }>("SELECT space_id,principal_id,identity_epoch FROM space_metadata");
        if (
          owner?.space_id !== ctx.actor.spaceId ||
          owner.principal_id !== ctx.actor.principalId ||
          owner.identity_epoch !== ctx.actor.identityEpoch
        )
          return fail("IDENTITY_CHANGED", "主体空间已改变");
        if (!tx.get("SELECT id FROM connections WHERE id=?", [connectionId]))
          return fail("NOT_FOUND", "连接不存在");
        const row = tx.get<{
          id: string;
          revision: number;
          epoch: number;
          enabled: number;
          enabled_after_receive_seq: number;
          policy_json: string;
        }>("SELECT * FROM trigger_policies WHERE connection_id=?", [
          connectionId,
        ]);
        if (!row) return ok({ configured: false as const });
        try {
          const policy = parseDto("TriggerPolicy", JSON.parse(row.policy_json));
          if (!policy.ok) return policy;
          if (
            policy.value.id !== row.id ||
            policy.value.connectionId !== connectionId ||
            policy.value.revision !== row.revision ||
            policy.value.epoch !== row.epoch ||
            Number(policy.value.enabled) !== row.enabled ||
            policy.value.enabledAfterReceiveSeq !==
              row.enabled_after_receive_seq
          )
            return fail("VALIDATION_FAILED", "策略索引与快照不一致");
          return ok({ configured: true as const, policy: policy.value });
        } catch {
          return fail("VALIDATION_FAILED", "策略快照损坏");
        }
      });
      return result.ok ? result.value : result;
    },
  };
}
