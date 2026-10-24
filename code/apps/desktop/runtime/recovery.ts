import { fail, ok, type AppError, type Result } from "@campussec/contracts";

export interface RecoveryActions {
  revokeGrants(): Promise<Result<void>>;
  verifyIdentity(): Promise<Result<void>>;
  reconcileRequests(): Promise<Result<void>>;
  reconcileDeliveries(): Promise<Result<void>>;
  startGateway(): Promise<Result<void>>;
  stopGateway(): Promise<Result<void>>;
}

export async function recoverRuntime(
  actions: RecoveryActions,
): Promise<Result<void>> {
  // An unavailable capability blocks activation; it does not become synthetic success.
  for (const name of [
    "revokeGrants",
    "verifyIdentity",
    "reconcileRequests",
    "reconcileDeliveries",
    "startGateway",
  ] as const) {
    try {
      const result = await actions[name]();
      if (!result.ok) return result;
    } catch {
      return fail("INTERNAL", `恢复步骤失败：${name}`);
    }
  }
  return ok(undefined);
}

export async function deactivateRuntime(
  actions: RecoveryActions,
): Promise<Result<void>> {
  let failure: Result<void> | undefined;
  for (const name of ["revokeGrants", "stopGateway"] as const) {
    try {
      const result = await actions[name]();
      if (!result.ok) failure ??= result;
    } catch {
      failure ??= fail("INTERNAL", `停止步骤失败：${name}`);
    }
  }
  return failure ?? ok(undefined);
}

export function createBackgroundScheduler(
  onError: (name: string, error: AppError) => void,
) {
  let stopped = false;
  const intervals = new Set<ReturnType<typeof setInterval>>();
  const active = new Map<string, Promise<void>>();
  const names = new Set<string>();
  return {
    start(
      name: string,
      milliseconds: number,
      work: () => Promise<Result<unknown>>,
    ) {
      if (
        stopped ||
        !name ||
        names.has(name) ||
        milliseconds < 1 ||
        intervals.size >= 1000
      )
        throw new Error("Scheduler unavailable");
      names.add(name);
      const timer = setInterval(() => {
        if (stopped || active.has(name)) return;
        const operation = (async () => {
          try {
            const result = await work();
            if (!result.ok) onError(name, result.error);
          } catch {
            onError(name, {
              code: "INTERNAL",
              message: "后台操作失败",
              retryable: false,
            });
          } finally {
            active.delete(name);
          }
        })();
        active.set(name, operation);
      }, milliseconds);
      intervals.add(timer);
    },
    async stop() {
      stopped = true;
      for (const timer of intervals) clearInterval(timer);
      intervals.clear();
      await Promise.all(active.values());
    },
  };
}
