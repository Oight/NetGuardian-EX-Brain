import {
  DEFAULT_LIMITS,
  fail,
  ok,
  parseDto,
  type AppError,
  type CallContext,
  type PlatformPage,
  type PlatformQuery,
  type Result,
} from "@campussec/contracts";
import type { CallRow, Dependencies, State } from "./state.js";

export function failedPage(
  deps: Dependencies,
  query: PlatformQuery,
  error: AppError,
  attempts: number,
): PlatformPage {
  return {
    status:
      error.code === "UPSTREAM_DENIED" || error.code === "UPSTREAM_AUTH"
        ? "denied"
        : [
              "UPSTREAM_TIMEOUT",
              "UPSTREAM_UNAVAILABLE",
              "CAPABILITY_UNAVAILABLE",
            ].includes(error.code)
          ? "unavailable"
          : "failed",
    queryId: deps.ids.next(),
    pageId: deps.ids.next(),
    pageOrdinal: 0,
    records: [],
    platformAttempts: attempts,
    coverage: {
      requestedScope: query.scope,
      effectiveScope: query.scope,
      queryCompleteness: "not_executed",
      collectionCoverage: "unknown",
      sourceTypes: [],
      reasons: [error.code],
      retrievedAt: deps.clock.now(),
      returned: 0,
    },
    warnings: [`查询未完成：${error.code}`],
  };
}

export async function executeQuery(
  deps: Dependencies,
  ctx: CallContext,
  state: State,
  row: CallRow,
  query: PlatformQuery,
): Promise<Result<PlatformPage>> {
  const controller = new AbortController();
  let finished = false,
    attempts = 0;
  const timeoutMs = Math.min(
    DEFAULT_LIMITS.queryTimeoutMs,
    Math.max(1, Date.parse(state.run.expiresAt) - Date.parse(deps.clock.now())),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Result<PlatformPage>>((resolve) => {
    timer = setTimeout(() => {
      finished = true;
      controller.abort();
      resolve(fail("UPSTREAM_TIMEOUT", "查询超时"));
    }, timeoutMs);
  });
  const beforeAttempt = async (): Promise<Result<void>> => {
    if (finished || controller.signal.aborted)
      return fail("EXPIRED", "查询已结束");
    const reserved = await deps.budget.reservePlatformAttempt(
      ctx,
      row.reservation_id,
    );
    if (reserved.ok) attempts++;
    if (finished || controller.signal.aborted)
      return fail("EXPIRED", "查询已结束");
    return reserved;
  };
  let response: Result<PlatformPage>;
  try {
    response = await Promise.race([
      Promise.resolve().then(() =>
        deps.query.query(ctx, structuredClone(query), {
          runId: state.run.id,
          beforeAttempt,
          signal: controller.signal,
        }),
      ),
      timeout,
    ]);
  } catch {
    response = fail("UPSTREAM_UNAVAILABLE", "查询端口未返回结果");
  } finally {
    finished = true;
    clearTimeout(timer);
    controller.abort();
  }
  if (!response.ok)
    return ok(failedPage(deps, query, response.error, attempts));
  const valid = parseDto("PlatformPage", response.value);
  if (!valid.ok || valid.value.platformAttempts !== attempts)
    return ok(
      failedPage(
        deps,
        query,
        {
          code: "VALIDATION_FAILED",
          message: "查询端口计数或结果无效",
          retryable: false,
        },
        attempts,
      ),
    );
  return valid;
}
