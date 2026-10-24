import { request } from "node:https";
import {
  fail,
  ok,
  type HttpPort,
  type Result,
  type HttpResponse,
} from "@campussec/contracts";
/** Strict HTTPS transport: no redirect following, bounded body, no response-body diagnostics. */
export function createStrictHttp(): HttpPort {
  return {
    request(input) {
      return new Promise<Result<HttpResponse>>((resolve) => {
        let settled = false;
        const done = (value: Result<HttpResponse>) => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        };
        try {
          const url = new URL(input.url);
          if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.hash
          ) {
            done(fail("INVALID_INPUT", "仅允许无用户信息的 HTTPS 地址"));
            return;
          }
          if (input.signal.aborted) {
            done(fail("CANCELLED", "请求已取消"));
            return;
          }
          const req = request(
            url,
            {
              method: input.method,
              headers: input.headers,
              ca: input.caPem,
              rejectUnauthorized: true,
              signal: input.signal,
            },
            (response) => {
              if (
                (response.statusCode ?? 0) >= 300 &&
                (response.statusCode ?? 0) < 400
              ) {
                response.destroy();
                done(fail("UPSTREAM_UNAVAILABLE", "上游重定向被拒绝"));
                return;
              }
              const parts: Buffer[] = [];
              let bytes = 0;
              response.on("data", (chunk: Buffer) => {
                bytes += chunk.byteLength;
                if (bytes > 4 * 1024 * 1024) {
                  done(fail("PARTIAL_RESULT", "上游响应超过 4 MiB"));
                  response.destroy();
                  req.destroy();
                } else parts.push(chunk);
              });
              response.on("end", () => {
                if (settled) return;
                try {
                  const bodyText = new TextDecoder("utf-8", {
                    fatal: true,
                  }).decode(Buffer.concat(parts));
                  done(
                    ok({
                      status: response.statusCode ?? 0,
                      headers: Object.fromEntries(
                        Object.entries(response.headers).filter(
                          (entry): entry is [string, string] =>
                            typeof entry[1] === "string",
                        ),
                      ),
                      bodyText,
                    }),
                  );
                } catch {
                  done(fail("UPSTREAM_UNAVAILABLE", "上游响应编码无效"));
                }
              });
              response.on("error", () =>
                done(fail("UPSTREAM_UNAVAILABLE", "上游响应中断", true)),
              );
            },
          );
          req.setTimeout(Math.min(10000, Math.max(1, input.timeoutMs)), () => {
            done(fail("UPSTREAM_TIMEOUT", "上游请求超时", true));
            req.destroy();
          });
          req.on("error", (error: { code?: string }) => {
            const code = error.code ?? "";
            done(
              input.signal.aborted
                ? fail("CANCELLED", "请求已取消")
                : /CERT|TLS|SELF_SIGNED|ISSUER|ALTNAME/.test(code)
                  ? fail("TLS_UNTRUSTED", "上游证书未被信任")
                  : fail("UPSTREAM_UNAVAILABLE", "上游连接失败", true),
            );
          });
          if (input.bodyText) req.write(input.bodyText);
          req.end();
        } catch {
          done(fail("UPSTREAM_UNAVAILABLE", "无法创建 HTTPS 请求"));
        }
      });
    },
  };
}
export function endpoint(
  base: string,
  segments: string[],
  parameters: Record<string, string> = {},
) {
  const url = new URL(base);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(base) ||
    /%2e|%2f|%5c/i.test(base)
  )
    throw new Error("Invalid base URL");
  if (
    segments.some(
      (s) => !s || s === "." || s === ".." || /[\\/\u0000-\u001f]/.test(s),
    )
  )
    throw new Error("Invalid path segment");
  url.pathname =
    url.pathname.replace(/\/$/, "") +
    "/" +
    segments.map(encodeURIComponent).join("/");
  for (const [key, value] of Object.entries(parameters))
    url.searchParams.set(key, value);
  return url.href;
}
// Shared across adapter instances: all platform requests use the same two slots.
let active = 0;
const waiting: (() => void)[] = [];
export async function withPlatformSlot<T>(
  signal: AbortSignal,
  work: () => Promise<Result<T>>,
): Promise<Result<T>> {
  if (signal.aborted) return fail("CANCELLED", "请求已取消");
  if (active >= 2) {
    const admitted = await new Promise<boolean>((resolve) => {
      const grant = () => {
        signal.removeEventListener("abort", abort);
        resolve(true);
      };
      const abort = () => {
        const i = waiting.indexOf(grant);
        if (i >= 0) waiting.splice(i, 1);
        resolve(false);
      };
      waiting.push(grant);
      signal.addEventListener("abort", abort, { once: true });
    });
    if (!admitted) return fail("CANCELLED", "等待期间已取消");
  } else active++;
  try {
    return signal.aborted ? fail("CANCELLED", "请求已取消") : await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
