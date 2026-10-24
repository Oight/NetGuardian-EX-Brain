import {
  fail,
  ok,
  parseDesktopInput,
  type CallContext,
  type CaseAtomicPort,
  type DatabasePort,
  type RetentionService,
  type ToolReplyAtomicPort,
} from "@campussec/contracts";
export function createRetentionService(d: {
  db: DatabasePort;
  cases: CaseAtomicPort;
  replies: ToolReplyAtomicPort;
}): RetentionService {
  const system = (ctx: CallContext): CallContext => ({
    traceId: ctx.traceId,
    actor: {
      spaceId: ctx.actor.spaceId,
      principalId: ctx.actor.principalId,
      identityEpoch: ctx.actor.identityEpoch,
      role: "system",
    },
  });
  const active = (tx: import("@campussec/contracts").ReadTx) =>
    tx
      .all<{
        run_id: string;
      }>(
        "SELECT run_id FROM jobs WHERE run_id IS NOT NULL AND state IN ('preparing','submitting','running','verifying','cancel_requested','uncertain')",
      )
      .map((r) => r.run_id);
  return {
    async preview(ctx, input) {
      const valid = parseDesktopInput("retention.preview", input);
      if (!valid.ok) return valid;
      if (!["ui", "system"].includes(ctx.actor.role))
        return fail("FORBIDDEN", "清理入口未授权");
      return d.db.write(ctx, (tx) =>
        d.cases.previewCleanupInTx(tx, system(ctx), {
          ...valid.value,
          protectedRunIds: active(tx),
        }),
      );
    },
    async apply(ctx, input) {
      const valid = parseDesktopInput("retention.apply", input);
      if (!valid.ok) return valid;
      if (!["ui", "system"].includes(ctx.actor.role))
        return fail("FORBIDDEN", "清理入口未授权");
      return d.db.write(ctx, (tx) => {
        const cleaned = d.cases.applyCleanupInTx(tx, system(ctx), {
          ...valid.value,
          protectedRunIds: active(tx),
        });
        if (!cleaned.ok) return cleaned;
        const expired = d.replies.expireRepliesInTx(tx, system(ctx), {
          projectionIds: cleaned.value.projectionIds,
        });
        return expired.ok
          ? ok({ expiredVersions: cleaned.value.expiredVersions })
          : expired;
      });
    },
  };
}
