import assert from "node:assert/strict";
import { composeRuntime } from "../../apps/desktop/runtime/compose.js";
import {
  FakeClock,
  FakeIds,
  SPACE,
  PRINCIPAL,
  scope,
} from "@campussec/testkit";
import {
  ok,
  fail,
  type CallContext,
  type Result,
  type CreateRequest,
  type ExecutionSnapshot,
} from "@campussec/contracts";
import type { ExecutionWire } from "@campussec/teleagent-bridge/execution";
import { temporaryDirectory } from "./storage.js";
import type { HttpPort } from "@campussec/contracts";
import type { GatewayAuthentication } from "@campussec/mcp-server/gateway";
import type { HostWire } from "@campussec/teleagent-bridge/host-access";
export function take<T>(r: Result<T>): T {
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.error));
  return r.value;
}
const protection = {
  available: () => true,
  encrypt: (text: string) => Buffer.from(text),
  decrypt: (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8"),
}; // Explicitly synthetic; never used by production.
export async function composedFixture(
  wire?: ExecutionWire,
  hostWire?: HostWire,
  options: {
    http?: HttpPort;
    gatewayAuthentication?: GatewayAuthentication;
    teleagent?: Parameters<typeof composeRuntime>[0]["teleagent"];
  } = {},
) {
  const directory = await temporaryDirectory(),
    clock = new FakeClock(),
    ids = new FakeIds();
  let network = 0;
  const deps = {
    dataDir: directory.path,
    spaceId: SPACE,
    principalId: PRINCIPAL,
    identityEpoch: 1,
    clock,
    ids,
    protection,
    backgroundEnabled: false,
    executionWire: wire,
    hostWire,
    gatewayAuthentication: options.gatewayAuthentication,
    teleagent: options.teleagent,
    http: options.http ?? {
      request: async () => {
        network++;
        return fail("FORBIDDEN", "本验收禁止真实平台访问");
      },
    },
  };
  let runtime = take(await composeRuntime(deps));
  const ctx = runtime.context(),
    system: CallContext = { ...ctx, actor: { ...ctx.actor, role: "system" } };
  const invoke = async (method: string, payload: unknown) => {
    const reply = await runtime.facade.invoke(ctx, {
      protocolVersion: "0.1.0",
      requestId: ids.next(),
      method,
      payload,
    } as never);
    return take(reply.result);
  };
  const connection = (await invoke("connections.configure", {
    displayName: "合成离线连接",
    platformInstanceId: SPACE,
    alertsPattern: "wazuh-alerts-*",
    mappingVersion: "wazuh-alerts-v1",
  })) as {
    id: string;
  };
  const request = (key: string): CreateRequest => ({
    origin: "client_user",
    connectionId: connection.id,
    question: "检验实际调度",
    requestedScope: { ...scope, connectionId: connection.id },
    seedRefs: [],
    idempotencyKey: key,
  });
  return {
    databasePath: directory.path + "/spaces/" + SPACE + "/state.sqlite",
    get runtime() {
      return runtime;
    },
    ctx,
    system,
    clock,
    ids,
    request,
    invoke,
    network: () => network,
    async reopen() {
      await runtime.close();
      runtime = take(await composeRuntime(deps));
    },
    async close() {
      await runtime.close();
      await directory.dispose();
    },
  };
}
