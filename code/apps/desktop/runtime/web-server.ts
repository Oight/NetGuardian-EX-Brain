import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  fail,
  ok,
  parseRpcRequest,
  idSchema,
  type Result,
} from "@campussec/contracts";
import {
  generateIdentityKeys,
  publicIdentity,
  seal,
  openSealed,
} from "../main/cryptography.js";
import type { AuthController } from "../main/auth-controller.js";
const publicKeysSchema = z.strictObject({
  signing: z.string().max(256),
  agreement: z.string().max(256),
});
const packetSchema = z.strictObject({
  sentAt: z.number().int(),
  nonce: idSchema,
  value: z.unknown(),
});
/** Strict loopback transport. Passwords, business RPC and responses use signed authenticated
 * envelopes; account secrets never enter Renderer. Remote access requires a separate HTTPS
 * deployment and authentication review; this server deliberately refuses non-loopback hosts.
 */
export async function serveWorkbench(input: {
  authentication: AuthController;
  assets: string;
  port?: number;
  label: string;
}) {
  const assets = new Map(
    [
      "index.html",
      "style.css",
      "view.js",
      "app.js",
      "api.js",
      "auth.js",
      "model.js",
      "ui.js",
      "context.js",
      "charts.js",
      "platform.js",
      "reports.js",
      "investigations.js",
      "settings.js",
    ].map((n) => ["/" + n, n]),
  );
  const keys = generateIdentityKeys(),
    publicKeys = publicIdentity(keys),
    marker = randomUUID();
  const downloads = new Map<
    string,
    {
      filename: string;
      mediaType: string;
      text: string;
      token: string;
      expires: number;
    }
  >();
  const seen = new Map<string, number>();
  let exported = false,
    origin = "",
    queue = Promise.resolve();
  function session(cookie?: string) {
    try {
      const value = cookie
        ?.split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith("ng_session="))
        ?.slice(11);
      if (!value || value.length > 4096) return undefined;
      return openSealed(
        Buffer.from(value, "base64url").toString("utf8"),
        "web-session-cookie",
        keys,
        publicKeys,
      ).toString("utf8");
    } catch {
      return undefined;
    }
  }
  const server = createServer((request, response) => {
    const task = async () => {
      const url = new URL(request.url ?? "/", origin),
        token = session(request.headers.cookie);
      const reply = (
        status: number,
        body: string,
        type = "application/json",
      ) => {
        response.writeHead(status, {
          "Content-Type": type,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        });
        response.end(body);
      };
      if (request.headers.host !== new URL(origin).host)
        return reply(403, "{}");
      if (request.method === "POST") {
        if (
          request.headers.origin !== origin ||
          request.headers["x-campus-web"] !== marker ||
          request.headers["content-type"] !== "application/json"
        )
          return reply(403, "{}");
        if (!["/api/rpc", "/api/auth"].includes(url.pathname))
          return reply(404, "{}");
        try {
          const raw = z
            .strictObject({
              publicKeys: publicKeysSchema,
              envelope: z.string().max(14 * 1024 * 1024),
            })
            .parse(JSON.parse(await body(request)));
          const plain = openSealed(
            raw.envelope,
            "web-request:" + url.pathname,
            keys,
            raw.publicKeys,
          );
          let packet: z.infer<typeof packetSchema>;
          try {
            packet = packetSchema.parse(JSON.parse(plain.toString("utf8")));
          } finally {
            plain.fill(0);
          }
          for (const [key, expires] of seen)
            if (expires < Date.now()) seen.delete(key);
          if (
            Math.abs(Date.now() - packet.sentAt) > 30000 ||
            seen.has(packet.nonce) ||
            seen.size >= 10000
          )
            return reply(409, "{}");
          seen.set(packet.nonce, Date.now() + 60000);
          const encrypted = (value: unknown) =>
            reply(
              200,
              seal(
                Buffer.from(JSON.stringify({ nonce: packet.nonce, value })),
                "web-response:" + url.pathname,
                keys,
                raw.publicKeys,
              ),
            );
          if (url.pathname === "/api/auth") {
            const result = await input.authentication.authenticate(
              token,
              packet.value,
            );
            if (result.token) {
              const cookie = Buffer.from(
                seal(
                  Buffer.from(result.token),
                  "web-session-cookie",
                  keys,
                  publicKeys,
                ),
              ).toString("base64url");
              response.setHeader(
                "Set-Cookie",
                `ng_session=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`,
              );
            } else if (result.clearCookie)
              response.setHeader(
                "Set-Cookie",
                "ng_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
              );
            return encrypted(result.result);
          }
          const parsed = parseRpcRequest(packet.value);
          if (!parsed.ok)
            return encrypted({
              protocolVersion: "0.1.0",
              requestId: randomUUID(),
              result: parsed,
            });
          if (
            parsed.value.method === "runtime.setTray" ||
            (parsed.value.method === "runtime.configure" &&
              (
                parsed.value.payload as {
                  settings: {
                    trayEnabled: boolean;
                  };
                }
              ).settings.trayEnabled)
          )
            return encrypted({
              protocolVersion: "0.1.0",
              requestId: parsed.value.requestId,
              result: fail(
                "CAPABILITY_UNAVAILABLE",
                "网页没有系统托盘，请使用桌面客户端",
              ),
            });
          exported = false;
          const result = await input.authentication.invoke(token, parsed.value);
          if (exported && result.result.ok && token) {
            for (const [id, item] of downloads)
              if (item.expires < Date.now()) downloads.delete(id);
            const ticket = randomUUID();
            downloads.set(ticket, {
              ...(result.result.value as {
                filename: string;
                mediaType: string;
                text: string;
              }),
              token,
              expires: Date.now() + 60000,
            });
            response.setHeader("X-Campus-Download", ticket);
          }
          return encrypted(result);
        } catch {
          return reply(400, "{}");
        }
      }
      if (request.method !== "GET") return reply(405, "{}");
      if (url.pathname.startsWith("/download/")) {
        const id = url.pathname.slice("/download/".length),
          item = downloads.get(id);
        if (
          !item ||
          item.expires < Date.now() ||
          !token ||
          item.token !== token ||
          !input.authentication.auth.validate(token).ok
        )
          return reply(404, "{}");
        downloads.delete(id);
        response.setHeader(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(item.filename)}`,
        );
        return reply(200, item.text, item.mediaType);
      }
      if (url.pathname === "/web-crypto.js")
        return reply(
          200,
          await readFile(
            join(input.assets, "../runtime/web-crypto.js"),
            "utf8",
          ),
          "text/javascript; charset=utf-8",
        );
      if (url.pathname === "/web-bridge.js")
        return reply(
          200,
          `const channel=import('/web-crypto.js').then(m=>m.createWebChannel(${JSON.stringify(publicKeys)},${JSON.stringify(marker)}));window.campusAuth=Object.freeze({invoke:async(method,input)=>(await(await channel)('/api/auth',{method,input})).value});window.campusSec=Object.freeze({invoke:async request=>{const response=await(await channel)('/api/rpc',request);if(response.download){const a=document.createElement('a');a.href='/download/'+encodeURIComponent(response.download);a.download='';document.body.append(a);a.click();a.remove();}return response.value;}});const banner=document.createElement('aside');banner.className='fixture-banner';banner.textContent=${JSON.stringify(input.label)};document.body.prepend(banner);`,
          "text/javascript; charset=utf-8",
        );
      const name = assets.get(
        url.pathname === "/" ? "/index.html" : url.pathname,
      );
      if (!name) return reply(404, "{}");
      let content = await readFile(join(input.assets, name), "utf8");
      if (name === "index.html")
        content = content
          .replace("connect-src 'none'", "connect-src 'self'")
          .replace(
            '<script type="module"',
            '<script src="/web-bridge.js"></script><script type="module"',
          );
      return reply(
        200,
        content,
        name.endsWith(".html")
          ? "text/html; charset=utf-8"
          : name.endsWith(".css")
            ? "text/css; charset=utf-8"
            : "text/javascript; charset=utf-8",
      );
    };
    queue = queue.then(task).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port ?? 4180, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(Error("No loopback address"));
      origin = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
  return {
    origin,
    saveExport: async (_value: {
      filename: string;
      mediaType: string;
      text: string;
    }): Promise<Result<void>> => {
      exported = true;
      return ok(undefined);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
async function body(request: IncomingMessage) {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > 16 * 1024 * 1024) throw Error("Request too large");
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts).toString("utf8");
}
