import {
  canonicalJson,
  fail,
  ok,
  parseDto,
  type CallContext,
  type ClockPort,
  type DatabasePort,
  type HostAccessPort,
  type HostCapability,
  type OriginBinding,
  type Result,
} from "@campussec/contracts";
export interface HostWire {
  capabilities(ctx: CallContext): Promise<Result<HostCapability[]>>;
  resolveOrigin(
    ctx: CallContext,
    trustedTransportBindingId: string,
  ): Promise<Result<OriginBinding>>;
  deliver: HostAccessPort["deliver"];
  reconcileDelivery: HostAccessPort["reconcileDelivery"];
}
export function createHostAccess(deps: {
  db: DatabasePort;
  clock: ClockPort;
  wire?: HostWire;
}): HostAccessPort {
  function valid(ctx: CallContext, binding: OriginBinding) {
    return (
      binding.spaceId === ctx.actor.spaceId &&
      binding.principalId === ctx.actor.principalId &&
      binding.state === "active" &&
      binding.expiresAt > deps.clock.now()
    );
  }
  const missing = <T>() =>
    Promise.resolve(
      fail<T>("CAPABILITY_UNAVAILABLE", "宿主可信身份或回传接口未核实"),
    );
  const port: HostAccessPort = {
    capabilities: (ctx) =>
      deps.wire
        ? deps.wire.capabilities(ctx)
        : Promise.resolve(
            ok(
              [
                "signedApi",
                "dedicatedProfile",
                "isolatedEvidenceChannel",
                "trustedOrigin",
                "asyncDelivery",
                "deliveryReconcile",
              ].map((name) => ({
                name: name as HostCapability["name"],
                state: "unverified",
                version: "unverified",
                checkedAt: deps.clock.now(),
                evidence: "未提供经核实的 Windows TeleAgent 接口映射",
              })),
            ),
          ),
    async resolveOrigin(ctx, transport) {
      if (ctx.actor.role !== "system" || !deps.wire) return missing();
      const resolved = await deps.wire.resolveOrigin(ctx, transport);
      if (!resolved.ok) return resolved;
      const parsed = parseDto("OriginBinding", resolved.value);
      if (!parsed.ok) return parsed;
      if (!valid(ctx, parsed.value))
        return fail("FORBIDDEN", "宿主来源身份不匹配或已失效");
      return deps.db.write(ctx, (tx) => {
        const b = parsed.value;
        const old = tx.get<{
          session_id: string;
          request_message_id: string;
          host_account_id: string;
          host_id: string;
          workspace_id: string;
          created_at: string;
        }>("SELECT * FROM origin_bindings WHERE id=?", [b.id]);
        if (
          old &&
          (old.session_id !== b.sessionId ||
            old.request_message_id !== b.requestMessageId ||
            old.host_account_id !== b.hostAccountId ||
            old.host_id !== b.hostId ||
            old.workspace_id !== b.workspaceId ||
            old.created_at !== b.createdAt)
        )
          return fail("CONFLICT", "来源绑定不能重定向");
        tx.run(
          "INSERT INTO origin_bindings(id,principal_id,host_id,host_account_id,workspace_id,session_id,request_message_id,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,expires_at=excluded.expires_at",
          [
            b.id,
            b.principalId,
            b.hostId,
            b.hostAccountId,
            b.workspaceId,
            b.sessionId,
            b.requestMessageId,
            b.state,
            b.createdAt,
            b.expiresAt,
          ],
        );
        return ok(b);
      });
    },
    async binding(ctx, id) {
      if (
        ctx.actor.role !== "system" &&
        !(ctx.actor.role === "delegation" && ctx.actor.originBindingId === id)
      )
        return fail("FORBIDDEN", "来源绑定入口未授权");
      const read = await deps.db.read(ctx, (tx) => {
        const row = tx.get<Record<string, unknown>>(
          "SELECT * FROM origin_bindings WHERE id=?",
          [id],
        );
        if (!row) return fail("NOT_FOUND", "来源绑定不存在");
        const parsed = parseDto("OriginBinding", {
          id: row.id,
          spaceId: ctx.actor.spaceId,
          principalId: row.principal_id,
          hostId: row.host_id,
          hostAccountId: row.host_account_id,
          workspaceId: row.workspace_id,
          sessionId: row.session_id,
          requestMessageId: row.request_message_id,
          state: row.state,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
        });
        return parsed.ok && valid(ctx, parsed.value)
          ? parsed
          : fail<OriginBinding>("FORBIDDEN", "来源绑定未授权或已失效");
      });
      return read.ok ? read.value : read;
    },
    async deliver(ctx, input) {
      const binding = await port.binding(ctx, input.binding.id);
      if (!binding.ok) return binding;
      if (!deps.wire) return missing();
      if (canonicalJson(binding.value) !== canonicalJson(input.binding))
        return fail("IDENTITY_CHANGED", "投递绑定已改变");
      return deps.wire.deliver(ctx, input);
    },
    async reconcileDelivery(ctx, input) {
      const binding = await port.binding(ctx, input.binding.id);
      return binding.ok && deps.wire
        ? deps.wire.reconcileDelivery(ctx, { ...input, binding: binding.value })
        : binding.ok
          ? missing()
          : binding;
    },
  };
  return port;
}
