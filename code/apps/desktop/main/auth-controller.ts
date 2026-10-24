import { randomUUID } from "node:crypto";
import {
  authInputs,
  fail,
  ok,
  parseAuthRequest,
  parseAuthOutput,
  parseRpcRequest,
  idSchema,
  type AccountView,
  type Result,
  type RpcResponse,
  type DesktopMethodMap,
} from "@campussec/contracts";
import { authorizeRole, type Authentication } from "./authentication.js";
import type { SecretProtection } from "./secrets.js";
import type { composeRuntime } from "../runtime/compose.js";
type Runtime = Extract<
  Awaited<ReturnType<typeof composeRuntime>>,
  {
    ok: true;
  }
>["value"];
/** One authenticated account owns one runtime and one principal space. Caller-provided Actor,
 * principal, role and workspace are never accepted. Serialization spans auth and business calls,
 * preventing a role change racing an admitted write in this desktop/server process.
 */
export function createAuthController(input: {
  authentication: Authentication;
  open(
    account: AccountView,
    protection: SecretProtection,
    databaseProtection: SecretProtection,
  ): Promise<Result<Runtime>>;
  outerProtection?: SecretProtection;
}) {
  const auth = input.authentication,
    runtimes = new Map<
      string,
      {
        runtime: Runtime;
        token: string;
        accountId: string;
        protections: SecretProtection[];
      }
    >();
  let queue = Promise.resolve();
  function serial<T>(work: () => Promise<T>) {
    const result = queue.then(work);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async function closeAccount(id: string) {
    for (const [key, item] of runtimes)
      if (item.accountId === id) {
        runtimes.delete(key);
        try {
          await item.runtime.lockIdentity();
        } finally {
          try {
            await item.runtime.close();
          } finally {
            for (const protection of item.protections) protection.close?.();
          }
        }
      }
  }
  async function runtime(token: string) {
    const session = auth.validate(token);
    if (!session.ok) return session;
    let item = runtimes.get(token);
    if (!item) {
      const protections = [
        auth.protection(token, input.outerProtection, "secret-store", true),
        auth.protection(token, input.outerProtection, "database", true),
      ];
      let opened: Result<Runtime>;
      try {
        opened = await input.open(
          session.value.account,
          protections[0]!,
          protections[1]!,
        );
      } catch {
        for (const protection of protections) protection.close?.();
        return fail<Runtime>("STORAGE_UNAVAILABLE", "无法打开加密主体空间");
      }
      if (!opened.ok) {
        for (const p of protections) p.close?.();
        return opened;
      }
      item = {
        runtime: opened.value,
        token,
        accountId: session.value.account.id,
        protections,
      };
      runtimes.set(token, item);
    }
    return ok(item.runtime);
  }
  async function prune() {
    for (const [token, item] of runtimes)
      if (!auth.validate(token).ok) await closeAccount(item.accountId);
  }
  const timer = setInterval(() => {
    void serial(prune).catch(() => {});
  }, 1000);
  timer.unref();
  return {
    auth,
    authenticate(token: string | undefined, raw: unknown) {
      return serial(async () => {
        await prune();
        const parsed = parseAuthRequest(raw);
        if (!parsed.ok) return { result: parsed };
        const { method, input: payload } = parsed.value;
        let issued: string | undefined,
          clearCookie = false;
        try {
          let result: Result<unknown>;
          if (method === "status") result = ok(auth.status(token));
          else if (method === "setup" || method === "login") {
            const p = authInputs[method].parse(payload);
            const signed = await auth[method](p.username, p.password);
            if (!signed.ok) return { result: signed };
            issued = signed.value.token;
            const account = signed.value.status.account!;
            await closeAccount(account.id);
            const opened = await runtime(issued);
            if (!opened.ok) {
              auth.logout(issued);
              return { result: opened, clearCookie: true };
            }
            result = ok(signed.value.status);
          } else if (method === "logout") {
            const session = auth.validate(token);
            auth.logout(token);
            clearCookie = true;
            if (session.ok) await closeAccount(session.value.account.id);
            result = ok(auth.status());
            clearCookie = true;
          } else if (method === "accounts") result = auth.accounts(token);
          else if (method === "createAccount") {
            const p = authInputs.createAccount.parse(payload);
            result = await auth.createAccount(
              token,
              p.username,
              p.password,
              p.role,
            );
          } else if (method === "updateAccount") {
            const p = authInputs.updateAccount.parse(payload);
            result = await auth.updateAccount(token, p.id, p.role, p.enabled);
            if (result.ok) await closeAccount(p.id);
          } else if (method === "openExport") {
            const p = authInputs.openExport.parse(payload);
            const session = auth.validate(token);
            result = session.ok
              ? ok(auth.decryptExport(token!, p.text))
              : session;
          } else {
            const p = authInputs.changePassword.parse(payload);
            const session = auth.validate(token);
            result = await auth.changePassword(
              token,
              p.currentPassword,
              p.newPassword,
            );
            if (result.ok && session.ok) {
              clearCookie = true;
              await closeAccount(session.value.account.id);
            }
          }
          return {
            result: result.ok ? parseAuthOutput(method, result.value) : result,
            ...(issued ? { token: issued } : {}),
            ...(clearCookie ? { clearCookie: true } : {}),
          };
        } catch {
          if (issued) auth.logout(issued);
          return {
            result: fail("INTERNAL", "鉴权操作失败，请核对输入或本地存储"),
            ...(issued || method === "logout" || clearCookie
              ? { clearCookie: true }
              : {}),
          };
        }
      });
    },
    invoke(
      token: string | undefined,
      raw: unknown,
    ): Promise<RpcResponse<unknown>> {
      return serial(async () => {
        await prune();
        const requestId = idSchema.safeParse(
          (
            raw as {
              requestId?: unknown;
            }
          )?.requestId,
        ).success
          ? (
              raw as {
                requestId: string;
              }
            ).requestId
          : randomUUID();
        const reply = (result: Result<unknown>): RpcResponse<unknown> => ({
          protocolVersion: "0.1.0",
          requestId,
          result,
        });
        const session = auth.validate(token);
        if (!session.ok) return reply(session);
        const parsed = parseRpcRequest(raw);
        if (!parsed.ok) return reply(parsed);
        const permission = authorizeRole(
          session.value.account.role,
          parsed.value.method,
          parsed.value.payload,
        );
        if (!permission.ok) return reply(permission);
        const opened = await runtime(token!);
        if (!opened.ok) return reply(opened);
        const result = await opened.value.facade.invoke(
          opened.value.context(),
          parsed.value,
        );
        // Export text crossing the transport boundary is also an authenticated encrypted envelope.
        if (parsed.value.method === "cases.export" && result.result.ok)
          return reply(
            ok(
              auth.encryptExport(
                token!,
                result.result
                  .value as DesktopMethodMap["cases.export"]["output"],
              ),
            ),
          );
        return result;
      });
    },
    encryptExport(
      token: string,
      value: {
        filename: string;
        mediaType: string;
        text: string;
      },
    ) {
      return auth.encryptExport(token, value);
    },
    async close() {
      clearInterval(timer);
      await serial(async () => {
        for (const id of new Set(
          [...runtimes.values()].map((r) => r.accountId),
        ))
          await closeAccount(id);
        auth.close();
      });
    },
  };
}
export type AuthController = ReturnType<typeof createAuthController>;
