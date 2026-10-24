import { test } from "node:test";
import assert from "node:assert/strict";
import { createSpaceController } from "../runtime/spaces.js";
import { composeRuntime } from "../runtime/compose.js";
import { createDesktopFacade } from "../runtime/facade.js";
import { createSecretStore } from "../main/secrets.js";
import {
  deactivateRuntime,
  type RecoveryActions,
} from "../runtime/recovery.js";
import {
  fail,
  ok,
  type CaseService,
  type ReportService,
} from "@campussec/contracts";
import {
  CASE,
  CONNECTION,
  context,
  FakeClock,
  FakeIds,
  PRINCIPAL,
  scope,
  SPACE,
} from "@campussec/testkit";
import {
  seedCase,
  storageFixture,
  temporaryDirectory,
} from "../../../tests/support/storage.js";

const protection = {
  available: () => false,
  encrypt: () => {
    throw new Error("unavailable");
  },
  decrypt: () => {
    throw new Error("unavailable");
  },
};
test("failed grant revocation still closes the gateway and reports the failure", async () => {
  const called: string[] = [];
  const actions: RecoveryActions = {
    revokeGrants: async () => {
      called.push("revoke");
      throw new Error("private details");
    },
    stopGateway: async () => {
      called.push("stop");
      return ok(undefined);
    },
    verifyIdentity: async () => ok(undefined),
    reconcileRequests: async () => ok(undefined),
    reconcileDeliveries: async () => ok(undefined),
    startGateway: async () => ok(undefined),
  };
  const result = await deactivateRuntime(actions);
  assert.equal(result.ok, false);
  assert.deepEqual(called, ["revoke", "stop"]);
  assert.equal(JSON.stringify(result).includes("private details"), false);
});
test("identity changes lock new work and an uncertain job prevents a second space from opening", async () => {
  const directory = await temporaryDirectory();
  let opened = 0;
  const controller = createSpaceController((identity) => {
    opened++;
    return composeRuntime({
      dataDir: directory.path,
      ...identity,
      protection,
      clock: new FakeClock(),
      ids: new FakeIds(),
    });
  });
  try {
    const initial = await controller.switchTo({
      spaceId: SPACE,
      principalId: PRINCIPAL,
      identityEpoch: 1,
    });
    assert.ok(initial.ok);
    const r = initial.value;
    const ctx = r.context();
    assert.ok(
      (
        await r.storage.db.write(ctx, (tx) => {
          seedCase(tx);
          tx.run(
            "INSERT INTO investigation_requests(id,origin,state,principal_id,connection_id,question,seed_refs_json,missing_fields_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            [
              SPACE,
              "client_user",
              "accepted",
              PRINCIPAL,
              CONNECTION,
              "synthetic?",
              "[]",
              "[]",
              scope.to,
              scope.to,
            ],
          );
          tx.run(
            "INSERT INTO jobs(id,request_id,case_id,origin,state,revision,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
            [
              SPACE,
              SPACE,
              CASE,
              "client_user",
              "uncertain",
              1,
              scope.to,
              scope.to,
              scope.to,
            ],
          );
          return ok(undefined);
        })
      ).ok,
    );
    assert.ok((await controller.notifyIdentityChanged()).ok);
    assert.equal(controller.isIdentityChanged(), true);
    const command = await r.facade.invoke(ctx, {
      protocolVersion: "0.1.0",
      requestId: CASE,
      method: "runtime.setTray",
      payload: { enabled: true },
    });
    assert.equal(command.result.ok, false);
    if (!command.result.ok)
      assert.equal(command.result.error.code, "IDENTITY_CHANGED");
    const blocked = await controller.switchTo({
      spaceId: CASE,
      principalId: CASE,
      identityEpoch: 1,
    });
    assert.equal(blocked.ok, false);
    assert.equal(opened, 1);
    const snapshot = await r.facade.invoke(ctx, {
      protocolVersion: "0.1.0",
      requestId: CASE,
      method: "workspace.snapshot",
      payload: {},
    });
    assert.ok(snapshot.result.ok);
    assert.equal(snapshot.result.value.jobs[0]?.state, "uncertain");
    // Only the test fixture emulates S07's explicit local-abandon decision.
    await r.storage.db.write(ctx, (tx) => {
      tx.run("UPDATE jobs SET state=?,revision=revision+1 WHERE id=?", [
        "needs_review",
        SPACE,
      ]);
      return ok(undefined);
    });
    const next = await controller.switchTo({
      spaceId: CASE,
      principalId: CASE,
      identityEpoch: 1,
    });
    assert.ok(next.ok);
    assert.equal(opened, 2);
    const empty = await next.value.facade.invoke(next.value.context(), {
      protocolVersion: "0.1.0",
      requestId: CASE,
      method: "workspace.snapshot",
      payload: {},
    });
    assert.ok(empty.result.ok);
    assert.equal(empty.result.value.totals.cases, 0);
  } finally {
    await controller.close();
    await directory.dispose();
  }
});
test("malformed service output and thrown exceptions cannot escape the desktop response boundary", async () => {
  const f = await storageFixture();
  try {
    const secrets = createSecretStore({
      directory: f.directory.path,
      spaceId: SPACE,
      protection,
      authorizeOwner: () => true,
    });
    let calls = 0;
    const cases = {
      create: async () => {
        calls++;
        return ok({
          id: CASE,
          spaceId: SPACE,
          revision: 1,
          title: "x",
          scope,
          status: "pending",
          createdAt: scope.to,
          updatedAt: scope.to,
          password: "must-not-escape",
        });
      },
    } as unknown as CaseService;
    const facade = createDesktopFacade({
      ...f,
      secrets,
      services: { cases },
      state: () => "degraded",
      hostCapabilities: () => [],
    });
    await facade.initialize(context());
    const input = {
      protocolVersion: "0.1.0" as const,
      requestId: CASE,
      method: "cases.create" as const,
      payload: { title: "x", scope, seedRefs: [] },
    };
    const response = await facade.invoke(context(), input);
    assert.equal(response.result.ok, false);
    assert.equal(JSON.stringify(response).includes("must-not-escape"), false);
    await facade.invoke(context(), {
      ...input,
      payload: {
        ...input.payload,
        scope: { ...scope, agentIds: ["1", "2", "3", "4", "5", "6"] },
      },
    });
    assert.equal(calls, 1);
    cases.create = async () => {
      throw new Error("private upstream response");
    };
    const thrown = await facade.invoke(context(), input);
    assert.equal(thrown.result.ok, false);
    assert.equal(JSON.stringify(thrown).includes("private upstream"), false);
    secrets.close();
  } finally {
    await f.dispose();
  }
});
test("export uses a sanitized filename and cancellation is not reported as success", async () => {
  const f = await storageFixture();
  try {
    const secrets = createSecretStore({
      directory: f.directory.path,
      spaceId: SPACE,
      protection,
      authorizeOwner: () => true,
    });
    let filename = "";
    const reports = {
      export: async () =>
        ok({
          filename: "../../folder/report.md",
          mediaType: "text/markdown",
          text: "# draft",
        }),
    } as unknown as ReportService;
    const facade = createDesktopFacade({
      ...f,
      secrets,
      services: { reports },
      state: () => "degraded",
      hostCapabilities: () => [],
      saveExport: async (value) => {
        filename = value.filename;
        return fail("CANCELLED", "已取消保存");
      },
    });
    await facade.initialize(context());
    const response = await facade.invoke(context(), {
      protocolVersion: "0.1.0",
      requestId: CASE,
      method: "cases.export",
      payload: { caseId: CASE, caseRevision: 1, format: "markdown" },
    });
    assert.equal(response.result.ok, false);
    if (!response.result.ok)
      assert.equal(response.result.error.code, "CANCELLED");
    assert.ok(filename);
    assert.equal(/[\/\\]/.test(filename), false);
    assert.equal(filename.startsWith("."), false);
    secrets.close();
  } finally {
    await f.dispose();
  }
});
