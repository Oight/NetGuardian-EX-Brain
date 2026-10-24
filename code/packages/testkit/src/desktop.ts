import {
  parseRpcRequest,
  parseRpcResponse,
  type DesktopApi,
  type DesktopMethodMap,
  type RpcRequest,
  type Result,
} from "@campussec/contracts";

type Method = keyof DesktopMethodMap;
type Step = {
  method: Method;
  reply: (request: RpcRequest<Method>) => Promise<Result<unknown>>;
};

/** Explicit, method-ordered replies. Uses real contract validation, never IPC or storage. */
export function createScriptedDesktop() {
  const steps: Step[] = [];
  const calls: RpcRequest<Method>[] = [];
  const port: DesktopApi = {
    async invoke<K extends Method>(request: RpcRequest<K>) {
      const parsed = parseRpcRequest(request);
      if (!parsed.ok)
        return {
          protocolVersion: "0.1.0" as const,
          requestId: request.requestId,
          result: parsed,
        };
      calls.push(parsed.value);
      const next = steps[0];
      if (!next) throw new Error("Unscripted desktop call");
      if (next.method !== request.method)
        throw new Error(`Expected ${next.method}, received ${request.method}`);
      steps.shift();
      const result = await next.reply(parsed.value);
      const response = parseRpcResponse(request.method, request.requestId, {
        protocolVersion: "0.1.0",
        requestId: request.requestId,
        result,
      });
      return response.ok
        ? response.value
        : {
            protocolVersion: "0.1.0" as const,
            requestId: request.requestId,
            result: response,
          };
    },
  };
  return {
    port,
    calls,
    push<K extends Method>(
      method: K,
      reply: (
        request: RpcRequest<K>,
      ) => Promise<Result<DesktopMethodMap[K]["output"]>>,
    ) {
      // The method equality check above establishes K for this queued callback.
      steps.push({
        method,
        reply: (request) => reply(request as RpcRequest<K>),
      });
    },
    pending: () => steps.length,
  };
}
