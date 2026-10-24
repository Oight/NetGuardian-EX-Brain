import { createHash } from "node:crypto";
import {
  createChannelAuthenticator,
  channelSecretPurpose,
} from "@campussec/mcp-server/channels";
import {
  canonicalJson,
  fail,
  idSchema,
  ok,
  type CallContext,
  type ClockPort,
  type DatabasePort,
  type Result,
  type SecretPort,
} from "@campussec/contracts";
import type { GatewayAuthentication, TrustedAdmission } from "./index.js";

/** Registration is only called by the owned-backend launcher after it creates and binds a session. */
export function createOwnedGatewayAuthentication(d: {
  db: DatabasePort;
  secrets: SecretPort;
  clock: ClockPort;
}) {
  const authenticator = createChannelAuthenticator(d);
  type Registration = {
    ctx: CallContext;
    channelId: string;
    secretRef: string;
    bindingId: string;
    allowedTools: string[];
  };
  const registrations = new Map<string, Registration>();
  const tokenKey = (token: Uint8Array) =>
    createHash("sha256").update(token).digest("hex");
  async function verify(
    reg: Registration,
    token: Uint8Array,
  ): Promise<Result<TrustedAdmission>> {
    const auth = await authenticator.authenticate(reg.ctx, {
      channelId: reg.channelId,
      token,
      trustedSessionBindingId: reg.bindingId,
    });
    return auth.ok
      ? ok({ ...auth.value, allowedTools: [...reg.allowedTools] })
      : auth;
  }
  const authentication: GatewayAuthentication = {
    async authenticate(request) {
      const value = request.headers.authorization;
      if (
        typeof value !== "string" ||
        !/^Bearer [A-Za-z0-9_-]{43}$/.test(value)
      )
        return fail("UNAUTHENTICATED", "缺少独占后端凭据");
      const token = Buffer.from(value.slice(7));
      try {
        const reg = registrations.get(tokenKey(token));
        return reg
          ? await verify(reg, token)
          : fail("UNAUTHENTICATED", "未知独占后端通道");
      } finally {
        token.fill(0);
      }
    },
    async recheck(admission) {
      const found = [...registrations.values()].find(
        (reg) => reg.bindingId === admission.transportBindingId,
      );
      if (!found) return fail("FORBIDDEN", "独占后端通道已撤销");
      const result = await d.secrets.use(
        found.secretRef,
        channelSecretPurpose(found.channelId),
        async (token) => verify(found, token),
      );
      if (!result.ok) return result;
      if (!result.value.ok) return result.value;
      return canonicalJson(result.value.value) === canonicalJson(admission)
        ? ok(undefined)
        : fail("IDENTITY_CHANGED", "通道认证上下文已变化");
    },
  };
  return {
    authentication,
    async register(input: Registration): Promise<Result<string>> {
      const reg = structuredClone(input);
      if (
        reg.ctx.actor.role !== "system" ||
        !idSchema.safeParse(reg.bindingId).success ||
        !Array.isArray(reg.allowedTools) ||
        reg.allowedTools.some((name) => !/^[a-z_]+$/.test(name))
      )
        return fail("FORBIDDEN", "通道登记不是可信启动输入");
      const lease = await d.secrets.use(
        reg.secretRef,
        channelSecretPurpose(reg.channelId),
        async (token) => {
          const verified = await verify(reg, token);
          if (!verified.ok) return verified;
          const key = tokenKey(token);
          if (
            registrations.has(key) ||
            [...registrations.values()].some(
              (r) => r.bindingId === reg.bindingId,
            )
          )
            return fail("CONFLICT", "独占后端通道已登记");
          registrations.set(key, reg);
          return ok(Buffer.from(token).toString("utf8"));
        },
      );
      return lease.ok ? lease.value : lease;
    },
    unregister(bindingId: string) {
      for (const [key, reg] of registrations)
        if (reg.bindingId === bindingId) registrations.delete(key);
    },
    clear() {
      registrations.clear();
    },
  };
}
