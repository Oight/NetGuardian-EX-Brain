import { test } from "node:test";
import assert from "node:assert/strict";
import { composeRuntime } from "../../apps/desktop/runtime/compose.js";
import { createIpcHandler } from "../../apps/desktop/main/ipc.js";
import { createClient } from "../../apps/desktop/renderer/api.js";
import {
  FakeClock,
  FakeIds,
  SPACE,
  PRINCIPAL,
  scope,
} from "@campussec/testkit";
import { type DesktopApi, type Result, fail } from "@campussec/contracts";
import { temporaryDirectory } from "../support/storage.js";
const protection = {
  available: () => false,
  encrypt: () => {
    throw new Error("unavailable");
  },
  decrypt: () => {
    throw new Error("unavailable");
  },
};
function take<T>(r: Result<T>): T {
  assert.ok(r.ok, r.ok ? "" : r.error.code);
  return r.value;
}
test("production composition → trusted IPC → typed client → real cases/context → close/reopen, without seeded cases or network", async () => {
  const directory = await temporaryDirectory(),
    clock = new FakeClock(),
    ids = new FakeIds();
  let network = 0;
  const deps = {
    dataDir: directory.path,
    spaceId: SPACE,
    principalId: PRINCIPAL,
    identityEpoch: 1,
    protection,
    backgroundEnabled: false,
    clock,
    ids,
    http: {
      request: async () => {
        network++;
        return fail("FORBIDDEN", "本验收禁止网络");
      },
    },
  };
  let runtime = take(await composeRuntime(deps));
  function client() {
    const handler = createIpcHandler({
      windowId: 7,
      documentUrl: "file:///workbench/index.html",
      context: runtime.context,
      ids,
      facade: runtime.facade,
    });
    const api: DesktopApi = {
      invoke: (request) =>
        handler(
          {
            senderId: 7,
            frameId: 1,
            mainFrameId: 1,
            url: "file:///workbench/index.html",
            destroyed: false,
          },
          request,
        ),
    };
    return createClient(api);
  }
  try {
    let invoke = client();
    const connection = await invoke("connections.configure", {
      displayName: "离线配置",
      platformInstanceId: SPACE,
      alertsPattern: "wazuh-alerts-*",
      mappingVersion: "wazuh-alerts-v1",
    });
    const actualScope = { ...scope, connectionId: connection.id };
    const created = await invoke("cases.create", {
      title: "创建、保存并重启验证",
      scope: actualScope,
      seedRefs: [],
    });
    assert.equal(created.revision, 1);
    const background = await invoke("cases.putContext", {
      caseId: created.id,
      expectedRevision: 1,
      context: {
        caseId: created.id,
        connectionId: connection.id,
        agentIds: ["001"],
        text: "学校维护窗口，未核实",
        sourceLabel: "测试人员合成输入",
        verification: "unverified",
        from: scope.from,
        to: scope.to,
      },
    });
    assert.equal(background.authorId, PRINCIPAL);
    await assert.rejects(
      invoke("cases.putContext", {
        caseId: created.id,
        expectedRevision: 1,
        context: {
          caseId: created.id,
          connectionId: connection.id,
          agentIds: ["001"],
          text: "过时修改",
          sourceLabel: "合成",
          verification: "unverified",
          from: scope.from,
          to: scope.to,
        },
      }),
      /案件已更新/,
    );
    await runtime.close();
    runtime = take(await composeRuntime(deps));
    invoke = client();
    const restored = await invoke("cases.snapshot", {
      caseId: created.id,
      evidencePage: { limit: 20 },
    });
    assert.equal(restored.case.revision, 2);
    assert.equal(restored.contexts[0]?.id, background.id);
    assert.equal(restored.contexts[0]?.text, "学校维护窗口，未核实");
    assert.equal(
      (await invoke("cases.list", { page: { limit: 20 } })).items.length,
      1,
    );
    const status = await invoke("runtime.status", {});
    assert.equal(status.state, "degraded");
    const accepted = await invoke("requests.create", {
      origin: "client_user", connectionId: connection.id, caseId: created.id,
      question: "请调查", seedRefs: [], requestedScope: actualScope,
      idempotencyKey: "same-business-key",
    });
    assert.equal(accepted.job?.state, "queued");
    const cancelled = await invoke("requests.cancel", {requestId: accepted.request.id, reason: "本地验收结束"});
    assert.equal(cancelled.job?.state, "cancelled");
    assert.equal(network, 0);
  } finally {
    await runtime.close();
    await directory.dispose();
  }
});
