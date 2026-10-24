import type {
  AppError,
  DesktopApi,
  DesktopMethodMap,
} from "@campussec/contracts";
export class ApiError extends Error {
  constructor(
    readonly code: AppError["code"],
    message: string,
  ) {
    super(message);
  }
}
/** The renderer has one typed capability: DesktopApi. All authoritative schemas run in Main. */
export function createClient(api: DesktopApi) {
  return async <K extends keyof DesktopMethodMap>(
    method: K,
    payload: DesktopMethodMap[K]["input"],
  ): Promise<DesktopMethodMap[K]["output"]> => {
    const requestId = crypto.randomUUID();
    const response = await api.invoke({
      protocolVersion: "0.1.0",
      requestId,
      method,
      payload,
    });
    if (
      !response ||
      response.protocolVersion !== "0.1.0" ||
      response.requestId !== requestId ||
      !response.result ||
      typeof response.result.ok !== "boolean"
    )
      throw new ApiError("INTERNAL", "桌面响应无效或与请求不匹配");
    if (!response.result.ok)
      throw new ApiError(
        response.result.error.code,
        response.result.error.message,
      );
    return response.result.value;
  };
}
