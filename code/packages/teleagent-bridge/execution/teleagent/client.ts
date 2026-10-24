import { createHmac, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { isAbsolute } from "node:path";
import { fail, ok, type Result } from "@campussec/contracts";

export interface SignedRequest {
  method: string;
  target: string;
  timestamp: string;
  nonce: string;
}
export type LocalSigner = (input: SignedRequest) => string;

/** local-v1 uses the original key's UTF-8 bytes, not a decoded base64 key. */
export function localSigner(key: string): LocalSigner {
  if (Buffer.byteLength(key) < 32) throw Error("Invalid local signing key");
  return ({ method, target, timestamp, nonce }) =>
    createHmac("sha256", key)
      .update(
        ["local-v1", method.toUpperCase(), target, timestamp, nonce].join("\n"),
      )
      .digest("base64url");
}

export function loopbackUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error("An explicit HTTP loopback endpoint is required");
  return url;
}

/** No credential discovery, proxy inheritance, redirects or automatic write retries. */
export function createSignedClient(input: {
  endpoint: string;
  directory: string;
  sign: LocalSigner;
  now?: () => number;
  nonce?: () => string;
  timeoutMs?: number;
  maxBytes?: number;
}) {
  const base = loopbackUrl(input.endpoint);
  if (base.pathname !== "/" || !isAbsolute(input.directory))
    throw Error("Invalid TeleAgent endpoint or owned workspace");
  const timeoutMs = Math.min(8000, Math.max(1, input.timeoutMs ?? 4000));
  const maxBytes = Math.min(4194304, Math.max(1, input.maxBytes ?? 1048576));
  return {
    async request(
      method: "GET" | "POST",
      path: string,
      body?: unknown,
      signal?: AbortSignal,
    ): Promise<Result<{ status: number; value: unknown }>> {
      if (
        !/^\/[A-Za-z0-9_/-]*$/.test(path) ||
        path.includes("//") ||
        (path.length > 1 && path.endsWith("/"))
      )
        return fail("INVALID_INPUT", "TeleAgent 请求路径无效");
      if (signal?.aborted) return fail("CANCELLED", "TeleAgent 操作已停止");
      const url = new URL(path, base);
      url.searchParams.set("directory", input.directory);
      const stamp = String((input.now ?? Date.now)());
      const nonce = (
        input.nonce ?? (() => randomBytes(18).toString("base64url"))
      )();
      const signed = {
        method,
        target: url.pathname + url.search,
        timestamp: stamp,
        nonce,
      };
      let signature: string, payload: string | undefined;
      try {
        signature = input.sign(signed);
        payload = body === undefined ? undefined : JSON.stringify(body);
      } catch {
        return fail("UNAUTHENTICATED", "无法签署 TeleAgent 请求");
      }
      return new Promise((resolve) => {
        let ended = false;
        const done = (value: Result<{ status: number; value: unknown }>) => {
          if (ended) return;
          ended = true;
          clearTimeout(timer);
          resolve(value);
        };
        const req = httpRequest(
          url,
          {
            method,
            signal,
            agent: false,
            headers: {
              "X-SA-Sign-Version": "local-v1",
              "X-SA-Timestamp": stamp,
              "X-SA-Nonce": nonce,
              "X-SA-Signature": signature,
              Accept: "application/json",
              ...(payload === undefined
                ? {}
                : {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(payload),
                  }),
            },
          },
          (res) => {
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              done(
                fail(
                  status === 401
                    ? "UNAUTHENTICATED"
                    : status === 403
                      ? "FORBIDDEN"
                      : status === 404
                        ? "NOT_FOUND"
                        : "HOST_UNAVAILABLE",
                  "TeleAgent 请求被拒绝（HTTP " + status + "）",
                ),
              );
              res.destroy();
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > maxBytes) {
                done(fail("VALIDATION_FAILED", "TeleAgent 响应超过限制"));
                res.destroy();
              } else chunks.push(chunk);
            });
            res.once("error", () =>
              done(fail("HOST_UNAVAILABLE", "TeleAgent 响应未完整读取")),
            );
            res.once("aborted", () =>
              done(fail("HOST_UNAVAILABLE", "TeleAgent 响应中断")),
            );
            res.once("end", () => {
              if (status === 204) {
                done(ok({ status, value: undefined }));
                return;
              }
              try {
                done(
                  ok({
                    status,
                    value: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                  }),
                );
              } catch {
                done(fail("VALIDATION_FAILED", "TeleAgent 响应不是有效 JSON"));
              }
            });
          },
        );
        const timer = setTimeout(() => {
          done(fail("UPSTREAM_TIMEOUT", "TeleAgent 请求超时"));
          req.destroy();
        }, timeoutMs);
        req.once("error", () =>
          done(
            fail(
              signal?.aborted ? "CANCELLED" : "HOST_UNAVAILABLE",
              "TeleAgent 连接不可用",
            ),
          ),
        );
        req.end(payload);
      });
    },
  };
}
export type SignedClient = ReturnType<typeof createSignedClient>;
