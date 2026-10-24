import {
  idSchema,
  fail,
  type CallContext,
  type IdPort,
  type RpcRequest,
  type DesktopMethodMap,
} from "@campussec/contracts";
import type { createDesktopFacade } from "../runtime/facade.js";

export interface TrustedIpcEvent {
  senderId: number;
  frameId: number;
  mainFrameId: number;
  url: string;
  destroyed: boolean;
}
export function createIpcHandler(deps: {
  windowId: number;
  documentUrl: string;
  context(): CallContext;
  ids: IdPort;
  facade: ReturnType<typeof createDesktopFacade>;
}) {
  return async (event: TrustedIpcEvent, input: unknown) => {
    const possibleId =
      input && typeof input === "object"
        ? (input as { requestId?: unknown }).requestId
        : undefined;
    const parsedId = idSchema.safeParse(possibleId);
    const requestId = parsedId.success ? parsedId.data : deps.ids.next();
    if (
      event.destroyed ||
      event.senderId !== deps.windowId ||
      event.frameId !== event.mainFrameId ||
      event.url !== deps.documentUrl
    ) {
      return {
        protocolVersion: "0.1.0" as const,
        requestId,
        result: fail("FORBIDDEN", "IPC 来源无效"),
      };
    }
    return deps.facade.invoke(
      deps.context(),
      input as RpcRequest<keyof DesktopMethodMap>,
    );
  };
}
