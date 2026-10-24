import type {
  ExecutionPort,
  ExecutionSnapshot,
  HostDeliveryPort,
  HostReceipt,
  HttpPort,
  HttpRequest,
  HttpResponse,
  OriginBinding,
  PlatformQueryPort,
  ConnectionReadPort,
  NotificationPort,
  RequestAtomicPort,
  CallContext,
  WriteTx,
} from "@campussec/contracts";
import { ScriptedPort, SyncScriptedPort } from "./clock.js";

/** No default success or real I/O. Every response, failure and lost reply is explicitly scripted. */
export function createScriptedHttp() {
  const script = new ScriptedPort<HttpRequest, HttpResponse>();
  const port: HttpPort = { request: (input) => script.invoke(input) };
  return { script, port };
}
export function createScriptedExecution() {
  const start = new ScriptedPort<
    Parameters<ExecutionPort["start"]>[1],
    ExecutionSnapshot
  >();
  const inspect = new ScriptedPort<string, ExecutionSnapshot>();
  const abort = new ScriptedPort<string, ExecutionSnapshot>();
  const port: ExecutionPort = {
    start: (_ctx, input) => start.invoke(input),
    inspect: (_ctx, runId) => inspect.invoke(runId),
    abort: (_ctx, runId) => abort.invoke(runId),
  };
  return { port, start, inspect, abort };
}
export function createScriptedDelivery() {
  const binding = new ScriptedPort<string, OriginBinding>();
  const deliver = new ScriptedPort<
    Parameters<HostDeliveryPort["deliver"]>[1],
    HostReceipt
  >();
  const reconcile = new ScriptedPort<
    Parameters<HostDeliveryPort["reconcileDelivery"]>[1],
    { state: "found" | "absent" | "unknown"; receipt?: HostReceipt }
  >();
  const port: HostDeliveryPort = {
    binding: (_ctx, id) => binding.invoke(id),
    deliver: (_ctx, input) => deliver.invoke(input),
    reconcileDelivery: (_ctx, input) => reconcile.invoke(input),
  };
  return { port, binding, deliver, reconcile };
}

type Value<R> = R extends { ok: true; value: infer V } ? V : never;
export function createScriptedPlatformQuery() {
  const query = new ScriptedPort<
    {
      ctx: CallContext;
      input: Parameters<PlatformQueryPort["query"]>[1];
      call: Parameters<PlatformQueryPort["query"]>[2];
    },
    Value<Awaited<ReturnType<PlatformQueryPort["query"]>>>
  >();
  const port: PlatformQueryPort = {
    query: (ctx, input, call) => query.invoke({ ctx, input, call }),
  };
  return { port, query };
}
export function createScriptedConnectionRead() {
  const list = new ScriptedPort<
    CallContext,
    Value<Awaited<ReturnType<ConnectionReadPort["list"]>>>
  >();
  const capabilities = new ScriptedPort<
    { ctx: CallContext; connectionId: string; refresh: boolean },
    Value<Awaited<ReturnType<ConnectionReadPort["capabilities"]>>>
  >();
  const agents = new ScriptedPort<
    { ctx: CallContext; input: Parameters<ConnectionReadPort["agents"]>[1] },
    Value<Awaited<ReturnType<ConnectionReadPort["agents"]>>>
  >();
  const port: ConnectionReadPort = {
    list: (ctx) => list.invoke(ctx),
    capabilities: (ctx, connectionId, refresh) =>
      capabilities.invoke({ ctx, connectionId, refresh }),
    agents: (ctx, input) => agents.invoke({ ctx, input }),
  };
  return { port, list, capabilities, agents };
}
export function createScriptedNotification() {
  const show = new ScriptedPort<
    Parameters<NotificationPort["show"]>[0],
    { shown: boolean }
  >();
  const port: NotificationPort = { show: (input) => show.invoke(input) };
  return { port, show };
}
export function createScriptedRequestAtomic() {
  type Input<K extends keyof RequestAtomicPort> = {
    tx: WriteTx;
    ctx: CallContext;
    input: Parameters<RequestAtomicPort[K]>[2];
  };
  const createAutoInTx = new SyncScriptedPort<
    Input<"createAutoInTx">,
    Value<ReturnType<RequestAtomicPort["createAutoInTx"]>>
  >();
  const cancelPolicyInTx = new SyncScriptedPort<
    Input<"cancelPolicyInTx">,
    { revokeRunIds: string[] }
  >();
  const port: RequestAtomicPort = {
    createAutoInTx: (tx, ctx, input) =>
      createAutoInTx.invoke({ tx, ctx, input }),
    cancelPolicyInTx: (tx, ctx, input) =>
      cancelPolicyInTx.invoke({ tx, ctx, input }),
  };
  return { port, createAutoInTx, cancelPolicyInTx };
}
