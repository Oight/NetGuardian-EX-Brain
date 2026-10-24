import {
  fail,
  ok,
  parseDto,
  type CallContext,
  type ClockPort,
  type ConnectionProfile,
  type DatabasePort,
  type IdPort,
  type SecretPort,
  type HttpPort,
  type Result,
  type PlatformCall,
  type Capability,
} from "@campussec/contracts";
import { endpoint, createStrictHttp, withPlatformSlot } from "./http.js";
export interface Dependencies {
  db: DatabasePort;
  secrets: SecretPort;
  clock: ClockPort;
  ids: IdPort;
  http?: HttpPort;
  /** Trusted composition only. Renderer cannot choose a proxy address or bypass credentials. */
  external?: {
    matches(profile: ConnectionProfile): boolean;
    request(input: {
      kind: "indexer" | "server";
      segments: string[];
      parameters: Record<string, string>;
      body?: unknown;
      signal: AbortSignal;
    }): Promise<Result<Record<string, unknown>>>;
  };
}
type ProfileRow = {
  id: string;
  platform_instance_id: string;
  display_name: string;
  generation: number;
  indexer_base_url: string | null;
  server_base_url: string | null;
  indexer_secret_ref: string | null;
  server_secret_ref: string | null;
  ca_ref: string | null;
  alerts_pattern: string;
  archives_pattern: string | null;
  mapping_version: string;
  principal_fingerprint: string;
  updated_at: string;
};
export function profile(row: ProfileRow, ctx: CallContext): ConnectionProfile {
  return {
    id: row.id,
    spaceId: ctx.actor.spaceId,
    platformInstanceId: row.platform_instance_id,
    displayName: row.display_name,
    generation: row.generation,
    ...(row.indexer_base_url ? { indexerBaseUrl: row.indexer_base_url } : {}),
    ...(row.server_base_url ? { serverBaseUrl: row.server_base_url } : {}),
    ...(row.indexer_secret_ref
      ? { indexerSecretRef: row.indexer_secret_ref }
      : {}),
    ...(row.server_secret_ref
      ? { serverSecretRef: row.server_secret_ref }
      : {}),
    ...(row.ca_ref ? { caRef: row.ca_ref } : {}),
    alertsPattern: row.alerts_pattern,
    ...(row.archives_pattern ? { archivesPattern: row.archives_pattern } : {}),
    mappingVersion: row.mapping_version,
    principalFingerprint: row.principal_fingerprint,
    updatedAt: row.updated_at,
  };
}
export const patternValid = (value: string) =>
  /^[a-z0-9][a-z0-9._*-]{1,180}$/.test(value) &&
  !value.includes("..") &&
  !value.includes("**");
export function createConnections(deps: Dependencies) {
  const http = deps.http ?? createStrictHttp();
  const tokens = new Map<string, string>();
  const logins = new Map<string, Promise<Result<string>>>();
  async function list(ctx: CallContext): Promise<Result<ConnectionProfile[]>> {
    if (!["ui", "system"].includes(ctx.actor.role))
      return fail("FORBIDDEN", "连接管理只允许本地主体");
    return deps.db.read(ctx, (tx) =>
      tx
        .all<ProfileRow>("SELECT * FROM connections ORDER BY display_name,id")
        .map((row) => profile(row, ctx)),
    );
  }
  async function get(
    ctx: CallContext,
    id: string,
  ): Promise<Result<ConnectionProfile>> {
    const result = await deps.db.read(ctx, (tx) =>
      tx.get<ProfileRow>("SELECT * FROM connections WHERE id=?", [id]),
    );
    if (!result.ok) return result;
    return result.value
      ? ok(profile(result.value, ctx))
      : fail("NOT_FOUND", "连接不存在");
  }
  async function save(
    ctx: CallContext,
    input: Omit<ConnectionProfile, "generation" | "updatedAt"> & {
      expectedGeneration?: number;
    },
  ): Promise<Result<ConnectionProfile>> {
    if (!["ui", "system"].includes(ctx.actor.role))
      return fail("FORBIDDEN", "当前入口不能修改连接");
    const { expectedGeneration, ...rest } = input;
    const parsed = parseDto("ConnectionProfile", {
      ...rest,
      generation: (expectedGeneration ?? 0) + 1,
      updatedAt: deps.clock.now(),
    });
    if (!parsed.ok) return parsed;
    if (
      input.spaceId !== ctx.actor.spaceId ||
      !patternValid(input.alertsPattern) ||
      (input.archivesPattern && !patternValid(input.archivesPattern))
    )
      return fail("INVALID_INPUT", "连接空间或索引模式无效");
    try {
      for (const base of [input.indexerBaseUrl, input.serverBaseUrl])
        if (base) endpoint(base, ["agents"]);
    } catch {
      return fail(
        "INVALID_INPUT",
        "入口必须是严格 HTTPS 地址，并保留受控代理前缀",
      );
    }
    return deps.db.write(ctx, (tx) => {
      const old = tx.get<ProfileRow>("SELECT * FROM connections WHERE id=?", [
        input.id,
      ]);
      if (
        (old && old.generation !== expectedGeneration) ||
        (!old && expectedGeneration !== undefined && expectedGeneration !== 0)
      )
        return fail("REVISION_CONFLICT", "连接已更新，请重新读取");
      if (
        old &&
        (old.platform_instance_id !== input.platformInstanceId ||
          old.principal_fingerprint !== input.principalFingerprint)
      )
        return fail("IDENTITY_CHANGED", "主体或平台改变需要先切换主体空间");
      const value = parsed.value;
      tx.run(
        "INSERT INTO connections(id,platform_instance_id,display_name,generation,indexer_base_url,server_base_url,indexer_secret_ref,server_secret_ref,ca_ref,alerts_pattern,archives_pattern,mapping_version,principal_fingerprint,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,generation=excluded.generation,indexer_base_url=excluded.indexer_base_url,server_base_url=excluded.server_base_url,indexer_secret_ref=excluded.indexer_secret_ref,server_secret_ref=excluded.server_secret_ref,ca_ref=excluded.ca_ref,alerts_pattern=excluded.alerts_pattern,archives_pattern=excluded.archives_pattern,mapping_version=excluded.mapping_version,updated_at=excluded.updated_at",
        [
          value.id,
          value.platformInstanceId,
          value.displayName,
          value.generation,
          value.indexerBaseUrl ?? null,
          value.serverBaseUrl ?? null,
          value.indexerSecretRef ?? null,
          value.serverSecretRef ?? null,
          value.caRef ?? null,
          value.alertsPattern,
          value.archivesPattern ?? null,
          value.mappingVersion,
          value.principalFingerprint,
          value.updatedAt,
        ],
      );
      tx.run("DELETE FROM capabilities WHERE connection_id=?", [input.id]);
      for (const key of tokens.keys())
        if (key.startsWith(input.id + ":")) tokens.delete(key);
      return ok(value);
    });
  }
  function operation(
    ctx: CallContext,
    p: ConnectionProfile,
    call?: PlatformCall,
  ) {
    const controller = AbortSignal.timeout(10000);
    const signal = call
      ? AbortSignal.any([call.signal, controller])
      : controller;
    let attempts = 0;
    async function fence(): Promise<Result<void>> {
      if (signal.aborted)
        return call?.signal.aborted
          ? fail("CANCELLED", "请求已取消")
          : fail("UPSTREAM_TIMEOUT", "查询期限已到");
      const current = await get(ctx, p.id);
      if (!current.ok) return current;
      if (
        current.value.generation !== p.generation ||
        current.value.principalFingerprint !== p.principalFingerprint
      )
        return fail("IDENTITY_CHANGED", "连接或身份已改变，旧响应不再交付");
      return ok(undefined);
    }
    async function send(
      kind: "indexer" | "server",
      segments: string[],
      auth: string,
      method: "GET" | "POST",
      parameters: Record<string, string> = {},
      body?: unknown,
    ) {
      const base = kind === "indexer" ? p.indexerBaseUrl : p.serverBaseUrl;
      if (!base) return fail("CAPABILITY_UNAVAILABLE", "所需组件入口尚未配置");
      let url: string;
      try {
        url = endpoint(base, segments, parameters);
      } catch {
        return fail("INVALID_INPUT", "上游路径不在白名单内");
      }
      return withPlatformSlot(signal, async () => {
        const before = await fence();
        if (!before.ok) return before;
        if (attempts >= 20)
          return fail("BUDGET_EXHAUSTED", "后台平台请求预算耗尽");
        if (call) {
          const reserved = await call.beforeAttempt();
          if (!reserved.ok) return reserved;
        }
        const checked = await fence();
        if (!checked.ok) return checked;
        attempts++;
        const input = {
          method,
          url,
          headers: { authorization: auth, "content-type": "application/json" },
          ...(body !== undefined ? { bodyText: JSON.stringify(body) } : {}),
          timeoutMs: 10000,
          signal,
        };
        let result;
        try {
          if (p.caRef) {
            const used = await deps.secrets.use(
              p.caRef,
              `ca:${p.id}`,
              (value) =>
                http.request({
                  ...input,
                  caPem: new TextDecoder().decode(value),
                }),
            );
            result = used.ok ? used.value : used;
          } else result = await http.request(input);
        } catch {
          return fail("UPSTREAM_UNAVAILABLE", "平台请求失败");
        }
        const after = await fence();
        if (!after.ok) return after;
        if (!result.ok) return result;
        if (
          new TextEncoder().encode(result.value.bodyText).byteLength >
          4 * 1024 * 1024
        )
          return fail("PARTIAL_RESULT", "上游响应超过 4 MiB");
        if (result.value.status >= 300 && result.value.status < 400)
          return fail("UPSTREAM_UNAVAILABLE", "上游重定向被拒绝");
        return result;
      });
    }
    async function basic(kind: "indexer" | "server"): Promise<Result<string>> {
      const ref = kind === "indexer" ? p.indexerSecretRef : p.serverSecretRef;
      if (!ref) return fail("UPSTREAM_AUTH", "该组件的凭据尚未配置");
      const used = await deps.secrets.use(
        ref,
        `wazuh:${kind}:${p.id}`,
        async (value) => {
          try {
            const credential = JSON.parse(new TextDecoder().decode(value)) as {
              username?: unknown;
              password?: unknown;
            };
            if (
              typeof credential.username !== "string" ||
              typeof credential.password !== "string" ||
              credential.username.includes(":")
            )
              return fail("UPSTREAM_AUTH", "凭据格式无效");
            return ok(
              "Basic " +
                Buffer.from(
                  credential.username + ":" + credential.password,
                ).toString("base64"),
            );
          } catch {
            return fail("UPSTREAM_AUTH", "凭据格式无效");
          }
        },
      );
      return used.ok ? used.value : used;
    }
    const tokenKey = p.id + ":" + p.generation;
    async function login(): Promise<Result<string>> {
      if (tokens.has(tokenKey)) return ok(tokens.get(tokenKey)!);
      const running = logins.get(tokenKey);
      if (running) return running;
      const promise = (async () => {
        const credential = await basic("server");
        if (!credential.ok) return credential;
        const response = await send(
          "server",
          ["security", "user", "authenticate"],
          credential.value,
          "POST",
          { raw: "true" },
        );
        if (!response.ok) return response;
        if (response.value.status === 403)
          return fail("UPSTREAM_DENIED", "Server 认证权限受限");
        if (response.value.status !== 200)
          return fail("UPSTREAM_AUTH", "Server 认证失败");
        let token = response.value.bodyText.trim();
        try {
          const parsed = JSON.parse(token);
          if (typeof parsed === "string") token = parsed;
        } catch {}
        if (
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ||
          token.length > 16384
        )
          return fail("UPSTREAM_AUTH", "Server 未返回有效 JWT");
        tokens.set(tokenKey, token);
        return ok(token);
      })();
      logins.set(tokenKey, promise);
      try {
        return await promise;
      } finally {
        if (logins.get(tokenKey) === promise) logins.delete(tokenKey);
      }
    }
    async function request(
      kind: "indexer" | "server",
      segments: string[],
      parameters: Record<string, string> = {},
      body?: unknown,
    ): Promise<Result<Record<string, unknown>>> {
      if (deps.external?.matches(p)) {
        return withPlatformSlot(signal, async () => {
          const before = await fence();
          if (!before.ok) return before;
          if (attempts >= 20)
            return fail("BUDGET_EXHAUSTED", "后台平台请求预算耗尽");
          if (call) {
            const reserved = await call.beforeAttempt();
            if (!reserved.ok) return reserved;
          }
          const checked = await fence();
          if (!checked.ok) return checked;
          attempts++;
          const response = await deps.external!.request({
            kind,
            segments,
            parameters,
            body,
            signal,
          });
          const after = await fence();
          return after.ok ? response : after;
        });
      }
      let renewed = false,
        retried = false;
      while (true) {
        const credential =
          kind === "server" ? await login() : await basic("indexer");
        if (!credential.ok) return credential;
        const response = await send(
          kind,
          segments,
          (kind === "server" ? "Bearer " : "") + credential.value,
          kind === "indexer" ? "POST" : "GET",
          parameters,
          body,
        );
        if (!response.ok) return response;
        const status = response.value.status;
        if (status === 401 && kind === "server" && !renewed) {
          renewed = true;
          if (tokens.get(tokenKey) === credential.value)
            tokens.delete(tokenKey);
          continue;
        }
        if (status === 401) return fail("UPSTREAM_AUTH", "该组件认证失败");
        if (status === 403)
          return fail("UPSTREAM_DENIED", "该业务接口权限受限");
        if ((status === 429 || status >= 500) && !retried) {
          retried = true;
          const wait = await new Promise<boolean>((resolve) => {
            const abort = () => {
              clearTimeout(timer);
              resolve(false);
            };
            const timer = setTimeout(() => {
              signal.removeEventListener("abort", abort);
              resolve(true);
            }, 50);
            signal.addEventListener("abort", abort, { once: true });
          });
          if (!wait) return fail("CANCELLED", "重试等待被取消");
          continue;
        }
        if (status < 200 || status >= 300)
          return fail(
            "UPSTREAM_UNAVAILABLE",
            "上游只读接口返回错误",
            status >= 500,
          );
        try {
          const value: unknown = JSON.parse(response.value.bodyText);
          if (!value || typeof value !== "object" || Array.isArray(value))
            return fail("UPSTREAM_UNAVAILABLE", "上游响应结构无效");
          return ok(value as Record<string, unknown>);
        } catch {
          return fail("UPSTREAM_UNAVAILABLE", "上游响应不是有效 JSON");
        }
      }
    }
    return { request, fence, attempts: () => attempts, signal };
  }
  async function storeCapability(
    ctx: CallContext,
    p: ConnectionProfile,
    value: Capability,
  ) {
    return deps.db.write(ctx, (tx) => {
      const current = tx.get<{
        generation: number;
      }>("SELECT generation FROM connections WHERE id=?", [p.id]);
      if (current?.generation !== p.generation)
        return fail("IDENTITY_CHANGED", "连接已经改变");
      tx.run(
        "INSERT INTO capabilities(connection_id,name,state,checked_at,evidence,endpoint_kind) VALUES(?,?,?,?,?,?) ON CONFLICT(connection_id,name) DO UPDATE SET state=excluded.state,checked_at=excluded.checked_at,evidence=excluded.evidence,endpoint_kind=excluded.endpoint_kind",
        [
          p.id,
          value.name,
          value.state,
          value.checkedAt,
          value.evidence,
          value.endpointKind,
        ],
      );
      return ok(undefined);
    });
  }
  return { list, get, save, operation, storeCapability };
}
export type Connections = ReturnType<typeof createConnections>;
