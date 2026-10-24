import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  canonicalJson,
  fail,
  ok,
  idSchema,
  authRoleSchema,
  type AccountView,
  type AuthRole,
  type AuthStatus,
  type DesktopMethodMap,
  type Result,
} from "@campussec/contracts";
import {
  generateIdentityKeys,
  publicIdentity,
  exportPrivate,
  importPrivate,
  seal,
  openSealed,
  signClaims,
  verifyClaims,
  type IdentityKeys,
  type PublicIdentity,
} from "./cryptography.js";
import type { SecretProtection } from "./secrets.js";
const binary = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(8192);
const storedAccount = z.strictObject({
  id: idSchema,
  username: z.string().regex(/^[a-z0-9_.-]{3,64}$/),
  role: authRoleSchema,
  enabled: z.boolean(),
  spaceId: idSchema,
  epoch: z.number().int().positive(),
  salt: binary,
  verifier: binary,
  keys: z.strictObject({
    nonce: binary,
    tag: binary,
    ciphertext: binary,
  }),
  publicKeys: z.strictObject({ signing: binary, agreement: binary }),
});
type Account = z.infer<typeof storedAccount>;
const registrySchema = z.strictObject({
  version: z.literal(1),
  accounts: z.array(storedAccount).max(100),
});
const claimsSchema = z.strictObject({
  version: z.literal(1),
  aud: z.literal("netguardian"),
  sub: idSchema,
  spaceId: idSchema,
  epoch: z.number().int().positive(),
  role: authRoleSchema,
  jti: idSchema,
  iat: z.number().int(),
  exp: z.number().int(),
});
const view = (a: Account): AccountView => ({
  id: a.id,
  username: a.username,
  role: a.role,
  enabled: a.enabled,
  spaceId: a.spaceId,
});
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
async function derive(password: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) =>
    scrypt(
      password,
      Buffer.from(salt, "base64url"),
      32,
      {
        N: 32768,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}
const verifier = (key: Buffer, id: string) =>
  createHmac("sha256", key)
    .update("netguardian-password-verifier-v1:" + id)
    .digest();
const aad = (a: Pick<Account, "id" | "username" | "spaceId" | "publicKeys">) =>
  Buffer.from(
    canonicalJson({
      id: a.id,
      username: a.username,
      spaceId: a.spaceId,
      publicKeys: a.publicKeys,
      context: "netguardian-private-key-wrap-v1",
    }),
  );
const wrapKey = (master: Buffer, id: string) =>
  Buffer.from(
    hkdfSync(
      "sha256",
      master,
      Buffer.alloc(0),
      Buffer.from("netguardian-key-wrap-v1:" + id),
      32,
    ),
  );
function wrap(
  master: Buffer,
  a: Pick<Account, "id" | "username" | "spaceId" | "publicKeys">,
  keys: IdentityKeys,
) {
  const key = wrapKey(master, a.id),
    nonce = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad(a));
    return {
      nonce: b64(nonce),
      ...(() => {
        const encrypted = Buffer.concat([
          cipher.update(canonicalJson(exportPrivate(keys)), "utf8"),
          cipher.final(),
        ]);
        return { tag: b64(cipher.getAuthTag()), ciphertext: b64(encrypted) };
      })(),
    };
  } finally {
    key.fill(0);
  }
}
function unwrap(master: Buffer, a: Account): IdentityKeys {
  const key = wrapKey(master, a.id);
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(a.keys.nonce, "base64url"),
    );
    decipher.setAAD(aad(a));
    decipher.setAuthTag(Buffer.from(a.keys.tag, "base64url"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(a.keys.ciphertext, "base64url")),
      decipher.final(),
    ]);
    try {
      const keys = importPrivate(
        z
          .strictObject({ signing: binary, agreement: binary })
          .parse(JSON.parse(plain.toString("utf8"))),
      );
      if (canonicalJson(publicIdentity(keys)) !== canonicalJson(a.publicKeys))
        throw Error("Key mismatch");
      return keys;
    } finally {
      plain.fill(0);
    }
  } finally {
    key.fill(0);
  }
}
export const readMethods = new Set<keyof DesktopMethodMap>([
  "runtime.status",
  "runtime.settings",
  "workspace.snapshot",
  "events.read",
  "connections.list",
  "connections.capabilities",
  "connections.agents",
  "devices.detail",
  "alerts.list",
  "alerts.getPolicy",
  "statistics.alerts",
  "cases.list",
  "cases.snapshot",
  "evidence.get",
  "requests.status",
  "investigations.snapshot",
  "investigations.history",
  "investigations.input",
  "reports.list",
  "followups.list",
  "followups.search",
  "results.get",
  "deliveries.status",
]);
const adminMethods = new Set<keyof DesktopMethodMap>([
  "runtime.configure",
  "runtime.setTray",
  "connections.configure",
  "connections.setCredential",
  "connections.setCa",
  "alerts.setPolicy",
  "retention.preview",
  "retention.apply",
]);
export function authorizeRole(
  role: AuthRole,
  method: keyof DesktopMethodMap,
  payload: unknown,
): Result<void> {
  if (role === "admin") return ok(undefined);
  if (
    role === "viewer" &&
    (!readMethods.has(method) ||
      (method === "connections.capabilities" &&
        (
          payload as {
            refresh?: boolean;
          }
        )?.refresh))
  )
    return fail("FORBIDDEN", "只读账号不能执行此操作");
  if (role === "analyst" && adminMethods.has(method))
    return fail("FORBIDDEN", "此操作需要管理员权限");
  return ok(undefined);
}
/** Passwords are scrypt verified; they never become encryption keys directly. Each account owns
 * independent Ed25519/X25519 keys and a separate S02 space. Password-derived AES-GCM only wraps
 * private key material (bootstrap must not require the private key that is being unlocked).
 */
export async function createAuthentication(input: {
  directory: string;
  now?: () => number;
  sessionMs?: number;
}) {
  const now = input.now ?? Date.now,
    sessionMs = input.sessionMs ?? 30 * 60 * 1000,
    path = join(input.directory, "accounts.json");
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  let accounts: Account[] = [];
  let expected = "";
  try {
    expected = await readFile(path, "utf8");
    accounts = registrySchema.parse(JSON.parse(expected)).accounts;
    if (
      new Set(accounts.map((a) => a.id)).size !== accounts.length ||
      new Set(accounts.map((a) => a.username)).size !== accounts.length ||
      !accounts.some((a) => a.enabled && a.role === "admin")
    )
      throw Error("Invalid account registry");
  } catch (error) {
    if (
      (
        error as {
          code?: string;
        }
      ).code !== "ENOENT"
    )
      throw Error("账号存储损坏，拒绝自动重建");
  }
  const sessions = new Map<
    string,
    {
      token: string;
      accountId: string;
      keys: IdentityKeys;
      expires: number;
    }
  >();
  const failures = new Map<
    string,
    {
      count: number;
      until: number;
    }
  >();
  let queue = Promise.resolve();
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async function save(next: Account[]) {
    const lock = join(input.directory, "accounts.lock");
    await writeFile(lock, "", { flag: "wx", mode: 0o600 });
    const temp = path + "." + randomUUID() + ".tmp";
    try {
      let actual = "";
      try {
        actual = await readFile(path, "utf8");
      } catch (error) {
        if (
          (
            error as {
              code?: string;
            }
          ).code !== "ENOENT"
        )
          throw error;
      }
      if (actual !== expected) throw Error("Account registry changed");
      const text = canonicalJson({ version: 1, accounts: next });
      await writeFile(temp, text, { flag: "wx", mode: 0o600 });
      await rename(temp, path);
      accounts = next;
      expected = text;
    } finally {
      await unlink(temp).catch(() => {});
      await unlink(lock);
    }
  }
  function validate(token: string | undefined): Result<{
    account: AccountView;
    keys: IdentityKeys;
    sessionId: string;
  }> {
    if (!token) return fail("UNAUTHENTICATED", "请先登录");
    try {
      const raw = token.split(".")[0];
      if (!raw || token.length > 8192) throw Error("Bad token");
      const hinted = JSON.parse(
        Buffer.from(raw, "base64url").toString("utf8"),
      ) as {
        sub?: unknown;
      };
      const account = accounts.find((a) => a.id === hinted.sub);
      if (!account || !account.enabled) throw Error("Account disabled");
      const claims = claimsSchema.parse(
        verifyClaims(token, account.publicKeys.signing),
      );
      const session = sessions.get(claims.jti);
      if (
        !session ||
        session.token !== token ||
        session.accountId !== account.id ||
        claims.sub !== account.id ||
        claims.spaceId !== account.spaceId ||
        claims.epoch !== account.epoch ||
        claims.role !== account.role ||
        claims.exp !== session.expires ||
        claims.exp <= now() ||
        claims.iat > now() ||
        claims.exp - claims.iat > sessionMs
      )
        throw Error("Expired session");
      return ok({
        account: view(account),
        keys: session.keys,
        sessionId: claims.jti,
      });
    } catch {
      return fail("UNAUTHENTICATED", "会话无效或已过期，请重新登录");
    }
  }
  function revoke(id: string) {
    for (const [key, s] of sessions)
      if (s.accountId === id) sessions.delete(key);
  }
  function status(token?: string): AuthStatus {
    const session = validate(token);
    return {
      initialized: accounts.length > 0,
      authenticated: session.ok,
      ...(session.ok ? { account: session.value.account } : {}),
    };
  }
  function issue(a: Account, keys: IdentityKeys) {
    revoke(a.id);
    for (const [key, s] of sessions)
      if (s.expires <= now()) sessions.delete(key);
    if (sessions.size >= 100) throw Error("Session capacity exceeded");
    const at = now(),
      jti = randomUUID(),
      expires = at + sessionMs;
    const token = signClaims(
      {
        version: 1,
        aud: "netguardian",
        sub: a.id,
        spaceId: a.spaceId,
        epoch: a.epoch,
        role: a.role,
        jti,
        iat: at,
        exp: expires,
      },
      keys,
    );
    sessions.set(jti, {
      token,
      accountId: a.id,
      keys,
      expires,
    });
    return { token, status: status(token) };
  }
  async function make(username: string, password: string, role: AuthRole) {
    const keys = generateIdentityKeys(),
      salt = b64(randomBytes(32));
    const a = {
      id: randomUUID(),
      username: username.toLowerCase(),
      role,
      enabled: true,
      spaceId: randomUUID(),
      epoch: 1,
      salt,
      verifier: "",
      keys: {
        nonce: "",
        tag: "",
        ciphertext: "",
      },
      publicKeys: publicIdentity(keys),
    };
    const master = await derive(password, salt);
    try {
      a.verifier = b64(verifier(master, a.id));
      a.keys = wrap(master, a, keys);
      return { account: a, keys };
    } finally {
      master.fill(0);
    }
  }
  async function login(username: string, password: string) {
    const normalized = username.toLowerCase(),
      limit = failures.get(normalized);
    if (limit && limit.until > now() && limit.count >= 5)
      return fail<{
        token: string;
        status: AuthStatus;
      }>("UNAUTHENTICATED", "登录失败次数过多，请稍后重试");
    for (const [key, value] of failures)
      if (value.until <= now()) failures.delete(key);
    if (failures.size > 1000)
      return fail<{
        token: string;
        status: AuthStatus;
      }>("UNAUTHENTICATED", "登录暂时受限，请稍后重试");
    const a = accounts.find((a) => a.username === normalized),
      master = await derive(password, a?.salt ?? b64(Buffer.alloc(32)));
    let keys: IdentityKeys | undefined;
    try {
      if (
        a &&
        a.enabled &&
        timingSafeEqual(
          verifier(master, a.id),
          Buffer.from(a.verifier, "base64url"),
        )
      )
        keys = unwrap(master, a);
    } catch {
    } finally {
      master.fill(0);
    }
    if (!a || !keys) {
      failures.set(normalized, {
        count: limit && limit.until > now() ? limit.count + 1 : 1,
        until: now() + 15 * 60 * 1000,
      });
      return fail<{
        token: string;
        status: AuthStatus;
      }>("UNAUTHENTICATED", "账号或密码不正确");
    }
    failures.delete(normalized);
    return ok(issue(a, keys));
  }
  return {
    status,
    validate,
    setup: (username: string, password: string) =>
      serial(async () => {
        if (accounts.length)
          return fail<{
            token: string;
            status: AuthStatus;
          }>("FORBIDDEN", "系统已经初始化");
        const made = await make(username, password, "admin");
        await save([made.account]);
        return ok(issue(made.account, made.keys));
      }),
    login: (username: string, password: string) =>
      serial(() => login(username, password)),
    logout(token?: string) {
      const session = validate(token);
      if (session.ok) sessions.delete(session.value.sessionId);
      return ok(status());
    },
    accounts(token?: string): Result<AccountView[]> {
      const a = validate(token);
      if (!a.ok) return a;
      if (a.value.account.role !== "admin")
        return fail("FORBIDDEN", "需要管理员权限");
      return ok(accounts.map(view));
    },
    createAccount: (
      token: string | undefined,
      username: string,
      password: string,
      role: AuthRole,
    ) =>
      serial(async () => {
        const caller = validate(token);
        if (!caller.ok) return caller;
        if (caller.value.account.role !== "admin")
          return fail<AccountView>("FORBIDDEN", "需要管理员权限");
        if (accounts.some((a) => a.username === username.toLowerCase()))
          return fail<AccountView>("CONFLICT", "账号已存在");
        if (accounts.length >= 100)
          return fail<AccountView>("CONFLICT", "账号数量已达上限");
        const made = await make(username, password, role);
        await save([...accounts, made.account]);
        return ok(view(made.account));
      }),
    updateAccount: (
      token: string | undefined,
      id: string,
      role: AuthRole,
      enabled: boolean,
    ) =>
      serial(async () => {
        const caller = validate(token);
        if (!caller.ok) return caller;
        if (caller.value.account.role !== "admin")
          return fail<AccountView>("FORBIDDEN", "需要管理员权限");
        const a = accounts.find((a) => a.id === id);
        if (!a) return fail<AccountView>("NOT_FOUND", "账号不存在");
        if (
          a.role === "admin" &&
          a.enabled &&
          (!enabled || role !== "admin") &&
          accounts.filter((a) => a.enabled && a.role === "admin").length === 1
        )
          return fail<AccountView>("CONFLICT", "不能停用或降级最后一个管理员");
        const updated = {
          ...a,
          role,
          enabled,
          epoch: a.epoch + 1,
        };
        await save(accounts.map((a) => (a.id === id ? updated : a)));
        revoke(id);
        return ok(view(updated));
      }),
    changePassword: (
      token: string | undefined,
      currentPassword: string,
      newPassword: string,
    ) =>
      serial(async () => {
        const session = validate(token);
        if (!session.ok) return session;
        const a = accounts.find((a) => a.id === session.value.account.id)!;
        const master = await derive(currentPassword, a.salt);
        try {
          if (
            !timingSafeEqual(
              verifier(master, a.id),
              Buffer.from(a.verifier, "base64url"),
            )
          )
            return fail<AuthStatus>("UNAUTHENTICATED", "当前密码不正确");
        } finally {
          master.fill(0);
        }
        const salt = b64(randomBytes(32)),
          nextMaster = await derive(newPassword, salt);
        try {
          const updated = {
            ...a,
            salt,
            epoch: a.epoch + 1,
            verifier: b64(verifier(nextMaster, a.id)),
            keys: wrap(nextMaster, a, session.value.keys),
          };
          await save(accounts.map((a) => (a.id === updated.id ? updated : a)));
          revoke(a.id);
          return ok(status());
        } finally {
          nextMaster.fill(0);
        }
      }),
    protection(
      token: string,
      outer?: SecretProtection,
      purpose = "secret-store",
      lease = false,
    ): SecretProtection {
      let pinned = lease ? validate(token) : undefined;
      let closed = false;
      const current = () =>
        closed
          ? fail<
              Extract<
                ReturnType<typeof validate>,
                {
                  ok: true;
                }
              >["value"]
            >("UNAUTHENTICATED", "Key lease closed")
          : (pinned ?? validate(token));
      return {
        close() {
          closed = true;
          pinned = undefined;
        },
        available: () => current().ok && (!outer || outer.available()),
        encrypt(text) {
          const session = current();
          if (!session.ok || (outer && !outer.available()))
            throw Error("Locked key store");
          const publicKeys = publicIdentity(session.value.keys);
          const encrypted = seal(
            Buffer.from(text),
            `${purpose}:${session.value.account.id}`,
            session.value.keys,
            publicKeys,
          );
          return outer ? outer.encrypt(encrypted) : Buffer.from(encrypted);
        },
        decrypt(bytes) {
          const session = current();
          if (!session.ok) throw Error("Locked key store");
          const plain = openSealed(
            outer ? outer.decrypt(bytes) : Buffer.from(bytes).toString("utf8"),
            `${purpose}:${session.value.account.id}`,
            session.value.keys,
            publicIdentity(session.value.keys),
          );
          try {
            return plain.toString("utf8");
          } finally {
            plain.fill(0);
          }
        },
      };
    },
    encryptExport(
      token: string,
      value: {
        filename: string;
        mediaType: string;
        text: string;
      },
    ) {
      const session = validate(token);
      if (!session.ok) throw Error("Not authenticated");
      return {
        filename: value.filename + ".ngenc",
        mediaType: "application/vnd.netguardian.encrypted+json",
        text: seal(
          Buffer.from(canonicalJson(value)),
          `case-export:${session.value.account.id}`,
          session.value.keys,
          publicIdentity(session.value.keys),
        ),
      };
    },
    decryptExport(token: string, text: string) {
      const session = validate(token);
      if (!session.ok) throw Error("Not authenticated");
      const plain = openSealed(
        text,
        `case-export:${session.value.account.id}`,
        session.value.keys,
        publicIdentity(session.value.keys),
      );
      try {
        return z
          .strictObject({
            filename: z.string().max(200),
            mediaType: z.string().max(200),
            text: z.string().max(4 * 1024 * 1024),
          })
          .parse(JSON.parse(plain.toString("utf8")));
      } finally {
        plain.fill(0);
      }
    },
    close() {
      sessions.clear();
      failures.clear();
    },
  };
}
export type Authentication = Awaited<ReturnType<typeof createAuthentication>>;
