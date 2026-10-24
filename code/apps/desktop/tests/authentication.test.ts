import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { temporaryDirectory } from "../../../tests/support/storage.js";
import {
  createAuthentication,
  authorizeRole,
  readMethods,
} from "../main/authentication.js";
import {
  generateIdentityKeys,
  publicIdentity,
  seal,
  openSealed,
} from "../main/cryptography.js";
import { createAuthController } from "../main/auth-controller.js";
import { createSecretStore } from "../main/secrets.js";
import { composeRuntime } from "../runtime/compose.js";
import {
  desktopSchemas,
  parseAuthRequest,
  fail,
  type Result,
  type DesktopMethodMap,
} from "@campussec/contracts";
function take<T>(result: Result<T>): T {
  assert.ok(result.ok, result.ok ? "" : JSON.stringify(result.error));
  return result.value;
}
const password = "Synthetic-authentication-2026!";
test("Ed25519 matches RFC 8032 vector 1; encryption authenticates recipient, sender, context and every envelope field", () => {
  const seed =
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
  const key = createPrivateKey({
    key: Buffer.from("302e020100300506032b657004220420" + seed, "hex"),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign(null, Buffer.alloc(0), key);
  assert.equal(
    signature.toString("hex"),
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  );
  assert.ok(verify(null, Buffer.alloc(0), createPublicKey(key), signature));
  const sender = generateIdentityKeys(),
    recipient = generateIdentityKeys(),
    other = generateIdentityKeys();
  const encrypted = seal(
    Buffer.from("Sensitive synthetic material"),
    "test-purpose",
    sender,
    publicIdentity(recipient),
  );
  assert.ok(!encrypted.includes("Sensitive synthetic material"));
  assert.equal(
    openSealed(
      encrypted,
      "test-purpose",
      recipient,
      publicIdentity(sender),
    ).toString(),
    "Sensitive synthetic material",
  );
  assert.notEqual(
    encrypted,
    seal(
      Buffer.from("Sensitive synthetic material"),
      "test-purpose",
      sender,
      publicIdentity(recipient),
    ),
    "Fresh ephemeral keys/nonces",
  );
  assert.throws(() =>
    openSealed(
      encrypted,
      "different-purpose",
      recipient,
      publicIdentity(sender),
    ),
  );
  assert.throws(() =>
    openSealed(encrypted, "test-purpose", other, publicIdentity(sender)),
  );
  assert.throws(() =>
    openSealed(encrypted, "test-purpose", recipient, publicIdentity(other)),
  );
  for (const field of [
    "sender",
    "recipient",
    "ephemeral",
    "salt",
    "nonce",
    "ciphertext",
    "tag",
    "signature",
  ]) {
    const value = JSON.parse(encrypted);
    value[field] = value[field].startsWith("A")
      ? "B" + value[field].slice(1)
      : "A" + value[field].slice(1);
    assert.throws(
      () =>
        openSealed(
          JSON.stringify(value),
          "test-purpose",
          recipient,
          publicIdentity(sender),
        ),
      field,
    );
  }
  const unknown = { ...JSON.parse(encrypted), extra: true };
  assert.throws(() =>
    openSealed(
      JSON.stringify(unknown),
      "test-purpose",
      recipient,
      publicIdentity(sender),
    ),
  );
});
test("accounts persist wrapped private keys; Ed25519 session expiry, logout, restart, changed roles and disabled accounts revoke authority", async () => {
  const directory = await temporaryDirectory();
  let at = 1000;
  const auth = await createAuthentication({
    directory: directory.path,
    now: () => at,
    sessionMs: 10000,
  });
  try {
    const admin = take(await auth.setup("admin", password));
    assert.equal(admin.status.account?.role, "admin");
    const text = await readFile(join(directory.path, "accounts.json"), "utf8");
    assert.ok(!text.includes(password) && !text.includes("PRIVATE KEY"));
    const viewer = take(
      await auth.createAccount(admin.token, "viewer", password, "viewer"),
    );
    const signed = take(await auth.login("viewer", password));
    assert.equal(take(auth.validate(signed.token)).account.id, viewer.id);
    assert.equal(
      auth.validate(
        signed.token.slice(0, -1) + (signed.token.endsWith("A") ? "B" : "A"),
      ).ok,
      false,
    );
    assert.equal(auth.accounts(signed.token).ok, false);
    take(await auth.updateAccount(admin.token, viewer.id, "analyst", true));
    assert.equal(auth.validate(signed.token).ok, false);
    const analyst = take(await auth.login("viewer", password));
    take(await auth.updateAccount(admin.token, viewer.id, "analyst", false));
    assert.equal(auth.validate(analyst.token).ok, false);
    assert.equal(
      (
        await auth.updateAccount(
          admin.token,
          admin.status.account!.id,
          "viewer",
          true,
        )
      ).ok,
      false,
    );
    const fresh = take(await auth.login("admin", password));
    assert.equal(
      auth.validate(admin.token).ok,
      false,
      "New login supersedes old session",
    );
    at = 11001;
    assert.equal(auth.validate(fresh.token).ok, false);
    const reopened = await createAuthentication({ directory: directory.path });
    assert.equal(reopened.status().initialized, true);
    assert.equal(reopened.validate(fresh.token).ok, false);
    reopened.close();
  } finally {
    auth.close();
    await directory.dispose();
  }
});
test("password change rewraps the same identity keys, preserving encrypted secrets/exports and revoking previous sessions", async () => {
  const directory = await temporaryDirectory(),
    auth = await createAuthentication({ directory: directory.path });
  try {
    let signed = take(await auth.setup("admin", password));
    const account = signed.status.account!;
    let store = createSecretStore({
      directory: join(directory.path, "secrets"),
      spaceId: account.spaceId,
      protection: auth.protection(signed.token),
      authorizeOwner: (id) => id === account.id,
    });
    const ref = take(
      await store.put({
        owner: account.id,
        purpose: "synthetic",
        value: Buffer.from("secret-test-value"),
        persist: true,
      }),
    );
    store.close();
    const bytes = await readFile(
      join(directory.path, "secrets", account.spaceId, ref + ".secret"),
      "utf8",
    );
    assert.ok(!bytes.includes("secret-test-value"));
    assert.equal(
      JSON.parse(bytes).suite,
      "Ed25519+X25519+HKDF-SHA256+AES-256-GCM",
    );
    const exported = auth.encryptExport(signed.token, {
      filename: "case.json",
      mediaType: "application/json",
      text: '{"synthetic":true}',
    });
    const old = signed.token;
    take(await auth.changePassword(old, password, password + "-new"));
    assert.equal(auth.validate(old).ok, false);
    assert.equal((await auth.login("admin", password)).ok, false);
    signed = take(await auth.login("admin", password + "-new"));
    store = createSecretStore({
      directory: join(directory.path, "secrets"),
      spaceId: account.spaceId,
      protection: auth.protection(signed.token),
      authorizeOwner: (id) => id === account.id,
    });
    assert.equal(
      take(
        await store.use(ref, "synthetic", async (value) =>
          Buffer.from(value).toString(),
        ),
      ),
      "secret-test-value",
    );
    store.close();
    assert.equal(
      auth.decryptExport(signed.token, exported.text).text,
      '{"synthetic":true}',
    );
    const other = take(
        await auth.createAccount(signed.token, "other", password, "analyst"),
      ),
      login = take(await auth.login("other", password));
    assert.notEqual(other.spaceId, account.spaceId);
    assert.throws(() => auth.decryptExport(login.token, exported.text));
  } finally {
    auth.close();
    await directory.dispose();
  }
});
test("all business methods enforce role permissions; forged auth fields and weak passwords are rejected", () => {
  for (const method of Object.keys(
    desktopSchemas,
  ) as (keyof DesktopMethodMap)[]) {
    assert.ok(authorizeRole("admin", method, {}).ok);
    if (!readMethods.has(method))
      assert.equal(authorizeRole("viewer", method, {}).ok, false);
  }
  assert.equal(
    authorizeRole("viewer", "connections.capabilities", { refresh: true }).ok,
    false,
  );
  for (const method of [
    "connections.configure",
    "connections.setCredential",
    "connections.setCa",
    "alerts.setPolicy",
    "retention.apply",
    "runtime.configure",
  ] as const)
    assert.equal(authorizeRole("analyst", method, {}).ok, false);
  assert.ok(authorizeRole("analyst", "cases.create", {}).ok);
  assert.ok(authorizeRole("analyst", "reports.review", {}).ok);
  assert.equal(
    parseAuthRequest({
      method: "login",
      input: {
        username: "admin",
        password,
        role: "admin",
      },
    }).ok,
    false,
  );
  assert.equal(
    parseAuthRequest({
      method: "setup",
      input: { username: "admin", password: "short" },
    }).ok,
    false,
  );
});
test("controller denies anonymous RPC and role escalation before storage; account spaces stay separate after login and disable", async () => {
  const directory = await temporaryDirectory(),
    auth = await createAuthentication({
      directory: join(directory.path, "auth"),
    });
  const controller = createAuthController({
    authentication: auth,
    open: (account, protection, databaseProtection) =>
      composeRuntime({
        dataDir: directory.path,
        spaceId: account.spaceId,
        principalId: account.id,
        identityEpoch: 1,
        protection,
        databaseProtection,
        backgroundEnabled: false,
        http: { request: async () => fail("FORBIDDEN", "No network") },
      }),
  });
  const rpc = (token: string | undefined, method: string, payload: unknown) =>
    controller.invoke(token, {
      protocolVersion: "0.1.0",
      requestId: crypto.randomUUID(),
      method,
      payload,
    });
  try {
    assert.equal(
      (await rpc(undefined, "workspace.snapshot", {})).result.ok,
      false,
    );
    const admin = await controller.authenticate(undefined, {
      method: "setup",
      input: { username: "admin", password },
    });
    assert.ok(admin.token);
    const configured = take(
      (
        await rpc(admin.token, "connections.configure", {
          displayName: "isolated",
          platformInstanceId: crypto.randomUUID(),
          alertsPattern: "wazuh-alerts-*",
          mappingVersion: "wazuh-alerts-v1",
        })
      ).result,
    ) as {
      id: string;
    };
    const created = take(
      (
        await rpc(admin.token, "cases.create", {
          title: "admin-only case",
          scope: {
            connectionId: configured.id,
            agentIds: ["001"],
            from: "2026-10-23T00:00:00.000Z",
            to: "2026-10-23T00:30:00.000Z",
            timeZone: "UTC",
          },
          seedRefs: [],
        })
      ).result,
    ) as {
      id: string;
    };
    const account = take(
      await auth.createAccount(admin.token, "viewer", password, "viewer"),
    );
    const viewer = await controller.authenticate(undefined, {
      method: "login",
      input: { username: "viewer", password },
    });
    assert.ok(viewer.token);
    const foreign = await rpc(viewer.token, "cases.snapshot", {
      caseId: created.id,
      evidencePage: { limit: 20 },
    });
    assert.equal(foreign.result.ok, false);
    const denied = await rpc(viewer.token, "connections.configure", {
      displayName: "forged",
      platformInstanceId: crypto.randomUUID(),
      alertsPattern: "wazuh-alerts-*",
      mappingVersion: "wazuh-alerts-v1",
    });
    assert.ok(!denied.result.ok && denied.result.error.code === "FORBIDDEN");
    const updated = await controller.authenticate(admin.token, {
      method: "updateAccount",
      input: {
        id: account.id,
        role: "viewer",
        enabled: false,
      },
    });
    assert.ok(updated.result.ok);
    assert.equal(
      (await rpc(viewer.token, "workspace.snapshot", {})).result.ok,
      false,
    );
    await controller.authenticate(admin.token, { method: "logout", input: {} });
    const reopened = await controller.authenticate(undefined, {
      method: "login",
      input: { username: "admin", password },
    });
    assert.ok(reopened.token);
    const preserved = take(
      (
        await rpc(reopened.token, "cases.snapshot", {
          caseId: created.id,
          evidencePage: { limit: 20 },
        })
      ).result,
    ) as {
      case: {
        title: string;
      };
    };
    assert.equal(preserved.case.title, "admin-only case");
  } finally {
    await controller.close();
    await directory.dispose();
  }
});
test("rate limit expires and corrupt account storage is never silently overwritten", async () => {
  const directory = await temporaryDirectory();
  let at = 0;
  const auth = await createAuthentication({
    directory: directory.path,
    now: () => at,
  });
  try {
    take(await auth.setup("admin", password));
    for (let i = 0; i < 5; i++)
      assert.equal((await auth.login("admin", password + "wrong")).ok, false);
    assert.equal((await auth.login("admin", password)).ok, false);
    at = 900001;
    assert.ok((await auth.login("admin", password)).ok);
    auth.close();
    await writeFile(join(directory.path, "accounts.json"), "{}");
    await assert.rejects(createAuthentication({ directory: directory.path }));
    assert.equal(
      await readFile(join(directory.path, "accounts.json"), "utf8"),
      "{}",
    );
  } finally {
    auth.close();
    await directory.dispose();
  }
});

test("failed authenticated runtime creation releases leased keys and never returns an active session", async () => {
  const directory = await temporaryDirectory(),
    auth = await createAuthentication({ directory: directory.path });
  const leases: import("../main/secrets.js").SecretProtection[] = [];
  const controller = createAuthController({
    authentication: auth,
    open: async (_account, secret, database) => {
      leases.push(secret, database);
      throw Error("synthetic unavailable storage");
    },
  });
  try {
    const result = await controller.authenticate(undefined, {
      method: "setup",
      input: { username: "admin", password },
    });
    assert.equal(result.result.ok, false);
    assert.equal(result.token, undefined);
    assert.equal(result.clearCookie, true);
    assert.equal(leases.length, 2);
    assert.ok(leases.every((key) => !key.available()));
  } finally {
    await controller.close();
    await directory.dispose();
  }
});
