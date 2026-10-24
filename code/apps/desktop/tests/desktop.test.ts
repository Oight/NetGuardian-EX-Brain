import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDesktopFacade } from "../runtime/facade.js";
import { composeRuntime } from "../runtime/compose.js";
import { createIpcHandler } from "../main/ipc.js";
import { createSecretStore, type SecretProtection } from "../main/secrets.js";
import {
  createBackgroundScheduler,
  recoverRuntime,
  type RecoveryActions,
} from "../runtime/recovery.js";
import {
  fail,
  ok,
  type ConnectionProfile,
  type ConnectionService,
  type DesktopMethodMap,
  type Result,
  type SecretPort,
} from "@campussec/contracts";
import {
  CASE,
  CONNECTION,
  context,
  FakeClock,
  FakeIds,
  PRINCIPAL,
  SPACE,
  scope,
} from "@campussec/testkit";
import {
  seedCase,
  temporaryDirectory,
  storageFixture,
} from "../../../tests/support/storage.js";
const unavailableProtection: SecretProtection = {
  available: () => false,
  encrypt: () => {
    throw new Error("unavailable");
  },
  decrypt: () => {
    throw new Error("unavailable");
  },
};
function syntheticProtection(): SecretProtection {
  const key = randomBytes(32);
  return {
    available: () => true,
    encrypt(text) {
      const nonce = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, nonce);
      const encrypted = Buffer.concat([
        cipher.update(text, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    decrypt(bytes) {
      const data = Buffer.from(bytes);
      const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([
        cipher.update(data.subarray(28)),
        cipher.final(),
      ]).toString("utf8");
    },
  };
}
test("secrets default to memory, enforce owner/purpose/space and zero temporary buffers", async () => {
  const d = await temporaryDirectory();
  try {
    const store = createSecretStore({
      directory: d.path,
      spaceId: SPACE,
      protection: unavailableProtection,
      authorizeOwner: (owner) => owner === PRINCIPAL,
    });
    const value = await store.put({
      owner: PRINCIPAL,
      purpose: "test",
      value: new TextEncoder().encode("private"),
      persist: false,
    });
    assert.ok(value.ok);
    assert.equal(
      (await store.use(value.value, "other", async () => true)).ok,
      false,
    );
    let handed: Uint8Array | undefined;
    const used = await store.use(value.value, "test", async (bytes) => {
      handed = bytes;
      return new TextDecoder().decode(bytes);
    });
    assert.ok(used.ok);
    assert.equal(used.value, "private");
    assert.ok(handed!.every((x) => x === 0));
    const stranger = createSecretStore({
      directory: d.path,
      spaceId: CASE,
      protection: unavailableProtection,
      authorizeOwner: () => true,
    });
    assert.equal(
      (await stranger.use(value.value, "test", async () => true)).ok,
      false,
    );
    assert.equal(
      (
        await store.put({
          owner: CASE,
          purpose: "test",
          value: new Uint8Array(),
          persist: false,
        })
      ).ok,
      false,
    );
    assert.equal(
      (
        await store.put({
          owner: PRINCIPAL,
          purpose: "test",
          value: new Uint8Array([1]),
          persist: true,
        })
      ).ok,
      false,
    );
    assert.deepEqual(await readdir(d.path), []);
    assert.ok((await store.remove(value.value)).ok);
    assert.equal(
      (await store.use(value.value, "test", async () => true)).ok,
      false,
    );
    store.close();
    stranger.close();
  } finally {
    await d.dispose();
  }
});
test("persisted secrets use an explicit protection provider and can be reopened without plaintext files", async () => {
  const d = await temporaryDirectory();
  try {
    const protection = syntheticProtection();
    const create = () =>
      createSecretStore({
        directory: d.path,
        spaceId: SPACE,
        protection,
        authorizeOwner: (owner) => owner === PRINCIPAL,
      });
    const first = create();
    const saved = await first.put({
      owner: PRINCIPAL,
      purpose: "test",
      value: new TextEncoder().encode("private-credential"),
      persist: true,
    });
    assert.ok(saved.ok);
    const bytes = await readFile(join(d.path, SPACE, `${saved.value}.secret`));
    assert.equal(bytes.includes(Buffer.from("private-credential")), false);
    first.close();
    const second = create();
    const value = await second.use(saved.value, "test", async (bytes) =>
      new TextDecoder().decode(bytes),
    );
    assert.ok(value.ok);
    assert.equal(value.value, "private-credential");
    assert.ok((await second.remove(saved.value)).ok);
    second.close();
  } finally {
    await d.dispose();
  }
});
test("runtime persists settings and reads a same-transaction workspace snapshot without host services", async () => {
  const d = await temporaryDirectory();
  try {
    const input = {
      dataDir: d.path,
      spaceId: SPACE,
      principalId: PRINCIPAL,
      identityEpoch: 1,
      protection: unavailableProtection,
      clock: new FakeClock(),
      ids: new FakeIds(),
    };
    const runtime = await composeRuntime(input);
    assert.ok(runtime.ok);
    const r = runtime.value;
    const invoke = <K extends keyof DesktopMethodMap>(
      method: K,
      payload: DesktopMethodMap[K]["input"],
    ) =>
      r.facade.invoke(r.context(), {
        protocolVersion: "0.1.0",
        requestId: input.ids.next(),
        method,
        payload,
      });
    assert.equal(r.recovery.ok, false);
    const status = await invoke("runtime.status", {});
    assert.ok(status.result.ok);
    assert.equal(status.result.value.state, "degraded");
    assert.ok(
      status.result.value.hostCapabilities.every(
        (c) => c.state === "unverified",
      ),
    );
    assert.ok(
      (
        await r.storage.db.write(r.context(), (tx) => {
          seedCase(tx);
          return ok(undefined);
        })
      ).ok,
    );
    const snapshot = await invoke("workspace.snapshot", {});
    assert.ok(snapshot.result.ok);
    assert.equal(snapshot.result.value.cases[0]?.title, "合成案件");
    assert.equal(snapshot.result.value.totals.cases, 1);
    const next = {
      trayEnabled: false,
      budgetTimeZone: "Asia/Shanghai",
      dailyTotalTokenLimit: 12345,
    };
    const results = await Promise.all([
      invoke("runtime.configure", { expectedRevision: 1, settings: next }),
      invoke("runtime.configure", { expectedRevision: 1, settings: next }),
    ]);
    assert.equal(results.filter((x) => x.result.ok).length, 1);
    assert.ok((await invoke("runtime.setTray", { enabled: true })).result.ok);
    const settings = await invoke("runtime.settings", {});
    assert.ok(settings.result.ok);
    assert.equal(settings.result.value.dailyTotalTokenLimit, 12345);
    const unavailable = await invoke("requests.create", {
      origin: "client_user",
      connectionId: CONNECTION,
      question: "尚未接入的调查",
      requestedScope: scope,
      idempotencyKey: "unavailable-investigation",
      seedRefs: [],
    });
    assert.equal(unavailable.result.ok, false);
    if (!unavailable.result.ok)
      assert.equal(unavailable.result.error.code, "CAPABILITY_UNAVAILABLE");
    await r.close();
    const reopened = await composeRuntime(input);
    assert.ok(reopened.ok);
    const saved = await reopened.value.facade.invoke(reopened.value.context(), {
      protocolVersion: "0.1.0",
      requestId: input.ids.next(),
      method: "runtime.settings",
      payload: {},
    });
    assert.ok(saved.result.ok);
    assert.equal(saved.result.value.trayEnabled, true);
    assert.equal(saved.result.value.dailyTotalTokenLimit, 12345);
    await reopened.value.close();
  } finally {
    await d.dispose();
  }
});
test("IPC rejects another window, child frame, navigated document, fake actor and protocol mismatch", async () => {
  const f = await storageFixture();
  try {
    const secrets = createSecretStore({
      directory: f.directory.path,
      spaceId: SPACE,
      protection: unavailableProtection,
      authorizeOwner: () => true,
    });
    const facade = createDesktopFacade({
      ...f,
      secrets,
      services: {},
      state: () => "degraded",
      hostCapabilities: () => [],
    });
    await facade.initialize(context());
    const handler = createIpcHandler({
      windowId: 7,
      documentUrl: "file:///app/index.html",
      context,
      ids: f.ids,
      facade,
    });
    const event = {
      senderId: 7,
      frameId: 1,
      mainFrameId: 1,
      url: "file:///app/index.html",
      destroyed: false,
    };
    const request = {
      protocolVersion: "0.1.0",
      requestId: CASE,
      method: "runtime.status",
      payload: {},
    };
    assert.ok((await handler(event, request)).result.ok);
    for (const patch of [
      { senderId: 8 },
      { frameId: 2 },
      { url: "https://attacker.invalid" },
      { destroyed: true },
    ])
      assert.equal(
        (await handler({ ...event, ...patch }, request)).result.ok,
        false,
      );
    assert.equal(
      (
        await handler(event, {
          ...request,
          payload: { actor: context().actor },
        })
      ).result.ok,
      false,
    );
    assert.equal(
      (await handler(event, { ...request, protocolVersion: "9.0.0" })).result
        .ok,
      false,
    );
    assert.equal((await handler(event, null)).result.ok, false);
    const forged = await facade.invoke(
      { ...context(), actor: { ...context().actor, principalId: CASE } },
      request as never,
    );
    assert.equal(forged.result.ok, false);
    secrets.close();
  } finally {
    await f.dispose();
  }
});
test("credential CAS conflicts remove the newly-created secret and never echo credentials", async () => {
  const f = await storageFixture();
  try {
    const store = createSecretStore({
      directory: f.directory.path,
      spaceId: SPACE,
      protection: unavailableProtection,
      authorizeOwner: (owner) => owner === PRINCIPAL,
    });
    let createdRef = "";
    let removedRef = "";
    const secrets: SecretPort = {
      put: async (input) => {
        const r = await store.put(input);
        if (r.ok) createdRef = r.value;
        return r;
      },
      use: store.use,
      remove: async (ref) => {
        removedRef = ref;
        return store.remove(ref);
      },
    };
    const profile: ConnectionProfile = {
      id: CONNECTION,
      spaceId: SPACE,
      platformInstanceId: SPACE,
      displayName: "test",
      generation: 1,
      alertsPattern: "test-*",
      mappingVersion: "v1",
      principalFingerprint: "test",
      updatedAt: f.clock.now(),
    };
    const connections: ConnectionService = {
      list: async () => ok([profile]),
      save: async () => fail("REVISION_CONFLICT", "连接已改变"),
      capabilities: async () => fail("CAPABILITY_UNAVAILABLE", "unavailable"),
      agents: async () => fail("CAPABILITY_UNAVAILABLE", "unavailable"),
      deviceDetail: async () => fail("CAPABILITY_UNAVAILABLE", "unavailable"),
      query: async () => fail("CAPABILITY_UNAVAILABLE", "unavailable"),
      statistics: async () => fail("CAPABILITY_UNAVAILABLE", "unavailable"),
    };
    const facade = createDesktopFacade({
      ...f,
      secrets,
      services: { connections },
      state: () => "degraded",
      hostCapabilities: () => [],
      invalidateConnection: async () => ok(undefined),
    });
    await facade.initialize(context());
    const response = await facade.invoke(context(), {
      protocolVersion: "0.1.0",
      requestId: CASE,
      method: "connections.setCredential",
      payload: {
        connectionId: CONNECTION,
        expectedGeneration: 1,
        endpoint: "indexer",
        username: "user-private",
        password: "password-private",
        persist: false,
      },
    });
    assert.equal(response.result.ok, false);
    assert.equal(createdRef, removedRef);
    assert.ok(createdRef);
    assert.equal(JSON.stringify(response).includes("password-private"), false);
    assert.equal(
      (
        await store.use(
          createdRef,
          `wazuh:indexer:${CONNECTION}`,
          async () => true,
        )
      ).ok,
      false,
    );
    const forged = await facade.invoke(context(), {
      protocolVersion: "0.1.0",
      requestId: CASE,
      method: "requests.create",
      payload: {
        origin: "teleagent_user",
        connectionId: CONNECTION,
        question: "q",
        seedRefs: [],
        idempotencyKey: "k",
        originBindingId: CASE,
      },
    });
    assert.equal(forged.result.ok, false);
    if (!forged.result.ok) assert.equal(forged.result.error.code, "FORBIDDEN");
    store.close();
  } finally {
    await f.dispose();
  }
});
test("recovery runs in order and refuses gateway activation after an identity failure", async () => {
  const calls: string[] = [];
  const actions: RecoveryActions = {
    revokeGrants: async () => {
      calls.push("revoke");
      return ok(undefined);
    },
    verifyIdentity: async () => {
      calls.push("identity");
      return ok(undefined);
    },
    reconcileRequests: async () => {
      calls.push("requests");
      return ok(undefined);
    },
    reconcileDeliveries: async () => {
      calls.push("deliveries");
      return ok(undefined);
    },
    startGateway: async () => {
      calls.push("gateway");
      return ok(undefined);
    },
    stopGateway: async () => ok(undefined),
  };
  assert.ok((await recoverRuntime(actions)).ok);
  assert.deepEqual(calls, [
    "revoke",
    "identity",
    "requests",
    "deliveries",
    "gateway",
  ]);
  calls.length = 0;
  assert.equal(
    (
      await recoverRuntime({
        ...actions,
        verifyIdentity: async () => {
          calls.push("identity");
          return fail("IDENTITY_CHANGED", "changed");
        },
      })
    ).ok,
    false,
  );
  assert.deepEqual(calls, ["revoke", "identity"]);
});
test("background work does not overlap and shutdown waits for the active operation", async () => {
  const scheduler = createBackgroundScheduler(() => undefined);
  let starts = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  scheduler.start("poll", 2, async () => {
    starts++;
    await gate;
    return ok(undefined);
  });
  await delay(20);
  assert.equal(starts, 1);
  let stopped = false;
  const stopping = scheduler.stop().then(() => {
    stopped = true;
  });
  await delay(5);
  assert.equal(stopped, false);
  release();
  await stopping;
  await delay(5);
  assert.equal(starts, 1);
  assert.equal(stopped, true);
});
test("scheduler retries a synchronously throwing callback instead of retaining a completed active entry", async () => {
  let calls = 0,
    errors = 0;
  const scheduler = createBackgroundScheduler(() => {
    errors++;
  });
  scheduler.start("sync-throw", 2, () => {
    calls++;
    if (calls === 1) throw new Error("synthetic");
    return Promise.resolve(ok(undefined));
  });
  await delay(30);
  await scheduler.stop();
  assert.ok(calls >= 2);
  assert.equal(errors, 1);
});
test("facade validates service errors and never forwards unknown codes or unexpected fields", async () => {
  const f = await storageFixture();
  const runtime = await composeRuntime({
    ...f.deps,
    protection: unavailableProtection,
    services: {
      cases: {
        create: async () => ({
          ok: false,
          error: {
            code: "UNKNOWN_REVIEW_CODE",
            message: "synthetic",
            retryable: false,
            password: "synthetic-only",
          },
        }),
      } as never,
    },
  });
  assert.ok(runtime.ok);
  try {
    const result = await runtime.value.facade.invoke(runtime.value.context(), {
      protocolVersion: "0.1.0",
      requestId: f.ids.next(),
      method: "cases.create",
      payload: { title: "test", scope, seedRefs: [] },
    });
    assert.ok(!result.result.ok && result.result.error.code === "INTERNAL");
    assert.equal(JSON.stringify(result).includes("password"), false);
    assert.equal(JSON.stringify(result).includes("UNKNOWN_REVIEW_CODE"), false);
  } finally {
    await runtime.value.close();
    await f.dispose();
  }
});
