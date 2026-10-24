import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  fail,
  ok,
  type CallContext,
  type ChannelHandle,
  type SecretPort,
} from "@campussec/contracts";
import {
  createScriptedDatabase,
  createScriptedSecrets,
  context,
  deferred,
  CASE,
} from "@campussec/testkit";
import { createStorage } from "@campussec/storage";
import {
  createChannelAuthenticator,
  createEvidenceChannels,
  channelSecretPurpose,
} from "@campussec/mcp-server/channels";
import { error, OTHER, SESSION, setup, system, take } from "./fixtures.js";

async function token(secrets: SecretPort, channel: ChannelHandle) {
  return take(
    await secrets.use(
      channel.secretRef,
      channelSecretPurpose(channel.id),
      async (bytes) => bytes.slice(),
    ),
  );
}
async function active(f: Awaited<ReturnType<typeof setup>>) {
  const channel = take(await f.channels.openChannel(system(), f.run));
  take(
    await f.channels.bindChannel(system(), {
      channelId: channel.id,
      runId: f.run.id,
      trustedSessionBindingId: SESSION,
    }),
  );
  return {
    channel,
    input: {
      channelId: channel.id,
      token: await token(f.secrets, channel),
      trustedSessionBindingId: SESSION,
    },
  };
}

test("construction is inert; pending grants contain only a digest and secret reference", async () => {
  const f = await setup();
  try {
    const db = createScriptedDatabase(),
      secrets = createScriptedSecrets();
    createEvidenceChannels({ ...f.deps, db: db.port, secrets: secrets.port });
    createChannelAuthenticator({
      ...f.deps,
      db: db.port,
      secrets: secrets.port,
    });
    assert.equal(secrets.put.calls.length, 0);
    const channel = take(await f.channels.openChannel(system(), f.run));
    const bytes = await token(f.secrets, channel);
    assert.equal(bytes.byteLength, 43);
    assert.match(Buffer.from(bytes).toString("utf8"), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(channel.state, "pending");
    assert.equal(channel.endpoint, undefined);
    const row = take(
      await f.db.read(system(), (tx) =>
        tx.get<{
          token_digest: string;
          binding_json: string | null;
          role: string;
        }>("SELECT * FROM mcp_grants")!,
      ),
    );
    assert.equal(
      row.token_digest,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.equal(row.binding_json, null);
    assert.equal(row.role, "evidence");
    assert.ok(
      !JSON.stringify(row).includes(Buffer.from(bytes).toString("utf8")),
    );
    error(
      await f.auth.authenticate(system(), {
        channelId: channel.id,
        token: bytes,
        trustedSessionBindingId: SESSION,
      }),
      "FORBIDDEN",
    );
    bytes.fill(0);
  } finally {
    await f.dispose();
  }
});

test("open/bind retries are idempotent; authentication produces a run-bound evidence actor", async () => {
  const f = await setup();
  try {
    const { channel, input } = await active(f);
    const reopened = take(await f.channels.openChannel(system(), f.run));
    assert.equal(reopened.id, channel.id);
    assert.equal(reopened.state, "active");
    assert.deepEqual(
      take(
        await f.channels.bindChannel(system(), {
          channelId: channel.id,
          runId: CASE,
          trustedSessionBindingId: SESSION,
        }),
      ),
      reopened,
    );
    const caller = system(),
      authenticated = take(await f.auth.authenticate(caller, input));
    assert.deepEqual(authenticated, {
      context: {
        actor: { ...caller.actor, role: "evidence", runId: CASE },
        traceId: caller.traceId,
      },
      transportBindingId: SESSION,
    });
    error(
      await f.channels.bindChannel(system(), {
        channelId: channel.id,
        runId: CASE,
        trustedSessionBindingId: OTHER,
      }),
      "CONFLICT",
    );
    error(
      await f.auth.authenticate(system(), {
        ...input,
        trustedSessionBindingId: OTHER,
      }),
      "FORBIDDEN",
    );
    error(
      await f.auth.authenticate(system(), { ...input, channelId: OTHER }),
      "UNAUTHENTICATED",
    );
    error(
      await f.auth.authenticate(system(), {
        ...input,
        token: new TextEncoder().encode("x".repeat(43)),
      }),
      "UNAUTHENTICATED",
    );
    error(
      await f.auth.authenticate(system(), {
        ...input,
        token: new Uint8Array(100000),
      }),
      "UNAUTHENTICATED",
    );
    error(
      await f.auth.authenticate(system(), {
        ...input,
        runId: CASE,
      } as typeof input),
      "UNAUTHENTICATED",
    );
  } finally {
    await f.dispose();
  }
});

test("management and transport authentication reject UI, delegation, evidence and mismatched system scopes", async () => {
  const f = await setup();
  try {
    const { channel, input } = await active(f);
    for (const role of ["ui", "delegation", "evidence"] as const) {
      const ctx: CallContext = {
        ...context(),
        actor: { ...context().actor, role, runId: CASE },
      };
      error(await f.channels.openChannel(ctx, f.run), "FORBIDDEN");
      error(
        await f.channels.bindChannel(ctx, {
          channelId: channel.id,
          runId: CASE,
          trustedSessionBindingId: SESSION,
        }),
        "FORBIDDEN",
      );
      error(await f.channels.revoke(ctx, CASE), "FORBIDDEN");
      error(await f.channels.revokeAll(ctx), "FORBIDDEN");
      error(await f.auth.authenticate(ctx, input), "FORBIDDEN");
    }
    const scoped = { ...system(), actor: { ...system().actor, runId: OTHER } };
    error(await f.channels.openChannel(scoped, f.run), "FORBIDDEN");
    error(await f.channels.revokeAll(scoped), "FORBIDDEN");
    const stranger = {
      ...system(),
      actor: { ...system().actor, principalId: OTHER },
    };
    error(await f.auth.authenticate(stranger, input), "FORBIDDEN");
    error(await f.channels.revokeAll(stranger), "FORBIDDEN");
    error(
      await f.channels.bindChannel(system(), {
        channelId: channel.id,
        runId: CASE,
        trustedSessionBindingId: "model-session",
      }),
      "INVALID_INPUT",
    );
    error(
      await f.channels.openChannel(system(), { ...f.run, toolEpoch: 2 }),
      "REVISION_CONFLICT",
    );
    error(
      await f.channels.openChannel(system(), {
        ...f.run,
        scope: { ...f.run.scope, connectionId: OTHER },
      }),
      "REVISION_CONFLICT",
    );
  } finally {
    await f.dispose();
  }
});

test("every authentication rechecks lifecycle, identity, connection and tool epochs", async () => {
  const changes: [string, string][] = [
    ["UPDATE jobs SET state='cancel_requested'", "CANCELLED"],
    ["UPDATE jobs SET state='uncertain'", "UNCERTAIN"],
    ["UPDATE jobs SET recovery_hold=1", "UNCERTAIN"],
    ["UPDATE jobs SET state='verifying'", "EXPIRED"],
    [
      "UPDATE analysis_runs SET sealed_at='2026-10-23T01:00:00.000Z'",
      "EXPIRED",
    ],
    ["UPDATE analysis_runs SET tool_epoch=2", "IDENTITY_CHANGED"],
    ["UPDATE analysis_runs SET identity_epoch=2", "IDENTITY_CHANGED"],
    ["UPDATE space_metadata SET identity_epoch=2", "IDENTITY_CHANGED"],
    ["UPDATE connections SET generation=2", "IDENTITY_CHANGED"],
    [`UPDATE investigation_requests SET principal_id='${OTHER}'`, "FORBIDDEN"],
    ["UPDATE investigation_requests SET state='withdrawn'", "FORBIDDEN"],
    [`UPDATE investigation_requests SET job_id='${OTHER}'`, "NOT_FOUND"],
    ["UPDATE mcp_grants SET role='delegation'", "FORBIDDEN"],
    ["UPDATE mcp_grants SET binding_json='{}'", "FORBIDDEN"],
    ["UPDATE jobs SET expires_at='invalid'", "VALIDATION_FAILED"],
  ];
  for (const [sql, code] of changes) {
    const f = await setup();
    try {
      const { input } = await active(f);
      await f.mutate(sql);
      error(await f.auth.authenticate(system(), input), code);
    } finally {
      await f.dispose();
    }
  }
});

test("run and grant deadlines are enforced at the boundary; malformed clocks fail closed", async () => {
  const f = await setup();
  try {
    const { input } = await active(f);
    await f.mutate(
      "UPDATE mcp_grants SET expires_at='2026-10-23T02:00:00.000Z'",
    );
    error(await f.auth.authenticate(system(), input), "VALIDATION_FAILED");
    await f.mutate(
      "UPDATE mcp_grants SET expires_at='2026-10-23T01:00:00.000Z'",
    );
    error(await f.auth.authenticate(system(), input), "EXPIRED");
    await f.mutate("UPDATE mcp_grants SET expires_at=?", [f.run.expiresAt]);
    const invalidClock = createChannelAuthenticator({
      ...f.deps,
      clock: { now: () => "invalid", monotonicMs: () => 0 },
    });
    error(
      await invalidClock.authenticate(system(), input),
      "VALIDATION_FAILED",
    );
    f.clock.advance(300000);
    error(await f.auth.authenticate(system(), input), "EXPIRED");
    error(await f.channels.openChannel(system(), f.run), "EXPIRED");
    take(await f.channels.revoke(system(), CASE));
  } finally {
    await f.dispose();
  }
});

test("revocation persists before secret cleanup; retries cannot resurrect the same epoch", async () => {
  let failRemove = true;
  const f = await setup((port) => ({
    ...port,
    remove: (ref) =>
      failRemove
        ? Promise.resolve(fail("SECRET_STORE_UNAVAILABLE", "synthetic failure"))
        : port.remove(ref),
  }));
  try {
    const { input } = await active(f);
    error(await f.channels.revoke(system(), CASE), "SECRET_STORE_UNAVAILABLE");
    error(await f.auth.authenticate(system(), input), "EXPIRED");
    error(await f.channels.openChannel(system(), f.run), "EXPIRED");
    failRemove = false;
    take(await f.channels.revoke(system(), CASE));
    take(await f.channels.revoke(system(), CASE));
    take(await f.channels.revoke(system(), OTHER));
    take(await f.channels.revokeAll(system()));
    assert.equal(
      take(
        await f.db.read(system(), (tx) =>
          tx.get<{ state: string }>("SELECT state FROM mcp_grants")!,
        ),
      ).state,
      "revoked",
    );
  } finally {
    await f.dispose();
  }
});

test("a newer tool epoch rotates the token and binding without reviving old credentials", async () => {
  const f = await setup();
  try {
    const old = await active(f);
    await f.mutate("UPDATE analysis_runs SET tool_epoch=2");
    const nextRun = { ...f.run, toolEpoch: 2 };
    error(await f.auth.authenticate(system(), old.input), "IDENTITY_CHANGED");
    const next = take(await f.channels.openChannel(system(), nextRun));
    assert.notEqual(next.id, old.channel.id);
    assert.equal(next.state, "pending");
    error(
      await f.secrets.use(
        old.channel.secretRef,
        channelSecretPurpose(old.channel.id),
        async () => undefined,
      ),
    );
    error(await f.auth.authenticate(system(), old.input), "UNAUTHENTICATED");
    take(
      await f.channels.bindChannel(system(), {
        channelId: next.id,
        runId: CASE,
        trustedSessionBindingId: OTHER,
      }),
    );
    take(
      await f.auth.authenticate(system(), {
        channelId: next.id,
        token: await token(f.secrets, next),
        trustedSessionBindingId: OTHER,
      }),
    );
    assert.equal(
      take(
        await f.db.read(system(), (tx) =>
          tx.get<{ n: number }>("SELECT COUNT(*) AS n FROM mcp_grants")!,
        ),
      ).n,
      1,
    );
  } finally {
    await f.dispose();
  }
});

test("secret creation and failed database writes leave no usable grant or orphan token", async () => {
  const f = await setup();
  try {
    const scripted = createScriptedSecrets();
    scripted.put.push(async () =>
      fail("SECRET_STORE_UNAVAILABLE", "synthetic failure"),
    );
    const unavailable = createEvidenceChannels({
      ...f.deps,
      secrets: scripted.port,
    });
    error(
      await unavailable.openChannel(system(), f.run),
      "SECRET_STORE_UNAVAILABLE",
    );
    let createdRef = "",
      createdPurpose = "",
      suppliedBytes: Uint8Array | undefined;
    const tracked: SecretPort = {
      ...f.secrets,
      async put(input) {
        suppliedBytes = input.value;
        const result = await f.secrets.put(input);
        if (result.ok) {
          createdRef = result.value;
          createdPurpose = input.purpose;
        }
        return result;
      },
    };
    const brokenDb = createEvidenceChannels({
      ...f.deps,
      secrets: tracked,
      db: {
        read: f.db.read,
        write: async () => fail("STORAGE_UNAVAILABLE", "synthetic failure"),
      },
    });
    error(await brokenDb.openChannel(system(), f.run), "STORAGE_UNAVAILABLE");
    assert.ok(suppliedBytes?.every((byte) => byte === 0));
    error(
      await f.secrets.use(createdRef, createdPurpose, async () => undefined),
    );
    assert.equal(
      take(
        await f.db.read(system(), (tx) =>
          tx.get<{ n: number }>("SELECT COUNT(*) AS n FROM mcp_grants")!,
        ),
      ).n,
      0,
    );
  } finally {
    await f.dispose();
  }
});

test("parallel managers race safely: one grant commits and unused secrets are removed", async () => {
  const f = await setup();
  const refs: { ref: string; purpose: string }[] = [];
  const secrets: SecretPort = {
    ...f.secrets,
    async put(input) {
      const result = await f.secrets.put(input);
      if (result.ok) refs.push({ ref: result.value, purpose: input.purpose });
      return result;
    },
  };
  try {
    const first = createEvidenceChannels({ ...f.deps, secrets }),
      second = createEvidenceChannels({ ...f.deps, secrets });
    const results = await Promise.all([
      first.openChannel(system(), f.run),
      second.openChannel(system(), f.run),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(refs.length, 2);
    let available = 0;
    for (const stored of refs)
      if (
        (await f.secrets.use(stored.ref, stored.purpose, async () => true)).ok
      )
        available++;
    assert.equal(available, 1);
  } finally {
    await f.dispose();
  }
});

test("revoke requested while open awaits secret storage runs after creation and leaves the grant revoked", async () => {
  const entered = deferred<void>(),
    release = deferred<void>();
  const f = await setup((port) => ({
    ...port,
    async put(input) {
      entered.resolve();
      await release.promise;
      return port.put(input);
    },
  }));
  try {
    const opened = f.channels.openChannel(system(), f.run);
    await entered.promise;
    const revoked = f.channels.revoke(system(), CASE);
    release.resolve();
    take(await opened);
    take(await revoked);
    assert.equal(
      take(
        await f.db.read(system(), (tx) =>
          tx.get<{ state: string }>("SELECT state FROM mcp_grants")!,
        ),
      ).state,
      "revoked",
    );
  } finally {
    release.resolve();
    await f.dispose();
  }
});

test("authentication rechecks authorization after asynchronous secret access", async () => {
  for (const change of ["revoke", "connection", "epoch"] as const) {
    let hold = false;
    const entered = deferred<void>(),
      release = deferred<void>();
    const f = await setup((port) => ({
      ...port,
      async use(ref, purpose, work) {
        const result = await port.use(ref, purpose, work);
        if (hold) {
          entered.resolve();
          await release.promise;
        }
        return result;
      },
    }));
    try {
      const { input } = await active(f);
      hold = true;
      const authenticating = f.auth.authenticate(system(), input);
      await entered.promise;
      if (change === "revoke") take(await f.channels.revoke(system(), CASE));
      else
        await f.mutate(
          change === "connection"
            ? "UPDATE connections SET generation=2"
            : "UPDATE analysis_runs SET tool_epoch=2",
        );
      release.resolve();
      error(
        await authenticating,
        change === "revoke" ? "FORBIDDEN" : "IDENTITY_CHANGED",
      );
    } finally {
      release.resolve();
      await f.dispose();
    }
  }
});

test("persisted revocations survive database reopen; missing session secrets cannot authenticate", async () => {
  const f = await setup();
  let reopened: Awaited<ReturnType<typeof createStorage>> | undefined;
  try {
    const { input } = await active(f);
    f.secretStore.close();
    error(
      await f.auth.authenticate(system(), input),
      "SECRET_STORE_UNAVAILABLE",
    );
    // Use an empty, explicitly scripted secret store after restart. Revoked grants must reject before secret access.
    const secrets = createScriptedSecrets();
    secrets.remove.push(async () =>
      fail("NOT_FOUND", "synthetic missing secret"),
    );
    take(
      await createEvidenceChannels({
        ...f.deps,
        secrets: secrets.port,
      }).revokeAll(system()),
    );
    await f.close();
    reopened = await createStorage(f.storageDeps);
    const storage = take(reopened);
    error(
      await createChannelAuthenticator({
        ...f.deps,
        db: storage.db,
        secrets: secrets.port,
      }).authenticate(system(), input),
      "EXPIRED",
    );
    assert.equal(secrets.read.calls.length, 0);
  } finally {
    if (reopened?.ok) await reopened.value.close();
    await f.dispose();
  }
});

test("rotation cleanup failure preserves a revoked reference and can be retried", async () => {
  let failRemove = false;
  const f = await setup((port) => ({
    ...port,
    remove: (ref) =>
      failRemove
        ? Promise.resolve(fail("SECRET_STORE_UNAVAILABLE", "synthetic failure"))
        : port.remove(ref),
  }));
  try {
    const old = await active(f);
    await f.mutate("UPDATE analysis_runs SET tool_epoch=2");
    failRemove = true;
    error(
      await f.channels.openChannel(system(), { ...f.run, toolEpoch: 2 }),
      "SECRET_STORE_UNAVAILABLE",
    );
    const row = take(
      await f.db.read(system(), (tx) =>
        tx.get<{ id: string; state: string; secret_ref: string }>(
          "SELECT * FROM mcp_grants",
        )!,
      ),
    );
    assert.equal(row.id, old.channel.id);
    assert.equal(row.secret_ref, old.channel.secretRef);
    assert.equal(row.state, "revoked");
    failRemove = false;
    const rotated = take(
      await f.channels.openChannel(system(), { ...f.run, toolEpoch: 2 }),
    );
    assert.notEqual(rotated.id, old.channel.id);
    error(
      await f.secrets.use(
        old.channel.secretRef,
        channelSecretPurpose(old.channel.id),
        async () => true,
      ),
    );
  } finally {
    await f.dispose();
  }
});

test("a connection change during secret creation prevents commit and removes the new secret", async () => {
  const entered = deferred<void>(),
    release = deferred<void>();
  let created: { ref: string; purpose: string } | undefined;
  const f = await setup((port) => ({
    ...port,
    async put(input) {
      const result = await port.put(input);
      if (result.ok) created = { ref: result.value, purpose: input.purpose };
      entered.resolve();
      await release.promise;
      return result;
    },
  }));
  try {
    const opening = f.channels.openChannel(system(), f.run);
    await entered.promise;
    await f.mutate("UPDATE connections SET generation=2");
    release.resolve();
    error(await opening, "IDENTITY_CHANGED");
    assert.ok(created);
    error(await f.secrets.use(created.ref, created.purpose, async () => true));
    assert.equal(
      take(
        await f.db.read(system(), (tx) =>
          tx.get<{ n: number }>("SELECT COUNT(*) AS n FROM mcp_grants")!,
        ),
      ).n,
      0,
    );
  } finally {
    release.resolve();
    await f.dispose();
  }
});

test("a trusted transport binding cannot be shared by active grants", async () => {
  const f = await setup();
  try {
    await active(f);
    take(
      await f.db.write(system(), (tx) => {
        tx.run("UPDATE jobs SET state='succeeded' WHERE id=?", [CASE]);
        tx.run(
          `INSERT INTO investigation_requests(id,origin,state,principal_id,connection_id,question,
        seed_refs_json,case_id,job_id,missing_fields_json,created_at,expires_at)
        SELECT ?,origin,state,principal_id,connection_id,question,seed_refs_json,case_id,?,missing_fields_json,created_at,expires_at
        FROM investigation_requests WHERE id=?`,
          [OTHER, OTHER, CASE],
        );
        tx.run(
          `INSERT INTO jobs(id,request_id,case_id,run_id,origin,state,revision,expires_at,created_at,updated_at)
        SELECT ?,?,case_id,?,origin,'preparing',1,expires_at,created_at,updated_at FROM jobs WHERE id=?`,
          [OTHER, OTHER, OTHER, CASE],
        );
        tx.run(
          `INSERT INTO analysis_runs(id,job_id,case_id,base_revision,scope_json,connection_generation,
        identity_epoch,profile_version,tool_epoch,expires_at,initial_input_json)
        SELECT ?,?,case_id,base_revision,scope_json,connection_generation,identity_epoch,profile_version,
        tool_epoch,expires_at,initial_input_json FROM analysis_runs WHERE id=?`,
          [OTHER, OTHER, CASE],
        );
        return ok(undefined);
      }),
    );
    const next = take(
      await f.channels.openChannel(system(), {
        ...f.run,
        id: OTHER,
        jobId: OTHER,
      }),
    );
    const binding = {
      channelId: next.id,
      runId: OTHER,
      trustedSessionBindingId: SESSION,
    };
    error(await f.channels.bindChannel(system(), binding), "CONFLICT");
    take(await f.channels.revoke(system(), CASE));
    take(await f.channels.bindChannel(system(), binding));
    take(await f.channels.revokeAll(system()));
    const states = take(
      await f.db.read(system(), (tx) =>
        tx.all<{ state: string }>("SELECT state FROM mcp_grants"),
      ),
    );
    assert.equal(states.length, 2);
    assert.ok(states.every((row) => row.state === "revoked"));
  } finally {
    await f.dispose();
  }
});
