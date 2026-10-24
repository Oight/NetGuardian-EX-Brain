/** Bun-only synthetic browser harness. It is never imported by product code or the standard build. */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { composeRuntime } from "../../apps/desktop/runtime/compose.ts";
import { temporaryDirectory } from "../../tests/support/storage.ts";
import { fail, type DesktopApi } from "@campussec/contracts";
if (!process.versions.bun) throw new Error("Run this local harness with Bun");
const localRuntime = globalThis as typeof globalThis & {
  Bun: {
    serve(input: {
      hostname: string;
      port: number;
      fetch(request: Request): Promise<Response>;
    }): {
      port: number;
      stop(): void;
    };
  };
};
const directory = await temporaryDirectory();
const deps = {
  dataDir: directory.path,
  spaceId: randomUUID(),
  principalId: randomUUID(),
  identityEpoch: 1,
  protection: {
    available: () => false,
    encrypt: () => {
      throw new Error("Unavailable");
    },
    decrypt: () => {
      throw new Error("Unavailable");
    },
  },
  http: {
    request: async () => fail("FORBIDDEN", "合成浏览器验收禁止真实平台请求"),
  },
};
let opened = await composeRuntime(deps);
if (!opened.ok) throw new Error(opened.error.code);
let runtime = opened.value;
const fixture = `window.campusSec=Object.freeze({invoke:async request=>{const r=await fetch('/invoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});return r.json();}});
const bar=document.createElement('aside');bar.style.cssText='padding:12px;background:#fff4c9;text-align:center';bar.textContent='合成验收环境 · 本地临时 SQLite · 禁止真实平台连接 ';document.body.prepend(bar);
const restart=document.createElement('button');restart.textContent='重启本地测试核心';restart.onclick=async()=>{await fetch('/restart',{method:'POST'});location.reload();};bar.append(restart);
const concurrent=document.createElement('button');concurrent.textContent='模拟另一人保存背景';concurrent.onclick=async()=>{const api=window.campusSec;const r=await api.invoke({protocolVersion:'0.1.0',requestId:crypto.randomUUID(),method:'cases.list',payload:{page:{limit:1}}});if(!r.result.ok||!r.result.value.items.length)return;const c=r.result.value.items[0];await api.invoke({protocolVersion:'0.1.0',requestId:crypto.randomUUID(),method:'cases.putContext',payload:{caseId:c.id,expectedRevision:c.revision,context:{caseId:c.id,connectionId:c.scope.connectionId,agentIds:c.scope.agentIds,text:'另一人已保存的背景',sourceLabel:'合成并发操作',verification:'unverified',from:c.scope.from,to:c.scope.to}}});};bar.append(concurrent);`;
const server = localRuntime.Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url),
      origin = `http://127.0.0.1:${server.port}`;
    if (request.method === "POST") {
      if (request.headers.get("origin") !== origin)
        return new Response("Forbidden", { status: 403 });
      if (url.pathname === "/invoke") {
        try {
          return Response.json(
            await runtime.facade.invoke(
              runtime.context(),
              await request.json(),
            ),
          );
        } catch {
          return new Response("Invalid", { status: 400 });
        }
      }
      if (url.pathname === "/restart") {
        await runtime.close();
        opened = await composeRuntime(deps);
        if (!opened.ok) return Response.json(opened, { status: 500 });
        runtime = opened.value;
        return Response.json({ ok: true });
      }
      return new Response("Not found", { status: 404 });
    }
    if (url.pathname === "/fixture.js")
      return new Response(fixture, {
        headers: { "content-type": "text/javascript" },
      });
    const assets: Record<string, string> = {
      "/": "index.html",
      "/index.html": "index.html",
      "/view.js": "view.js",
      "/app.js": "app.js",
      "/api.js": "api.js",
      "/style.css": "style.css",
    };
    const asset = assets[url.pathname];
    if (!asset) return new Response("Not found", { status: 404 });
    let source = await readFile("dist/apps/desktop/renderer/" + asset, "utf8");
    if (asset === "index.html")
      source = source
        .replace("connect-src 'none'", "connect-src 'self'")
        .replace(
          '<script type="module"',
          '<script src="/fixture.js"></script><script type="module"',
        );
    return new Response(source, {
      headers: {
        "content-type": asset.endsWith(".html")
          ? "text/html"
          : asset.endsWith(".css")
            ? "text/css"
            : "text/javascript",
      },
    });
  },
});
console.log(`Synthetic workbench: http://127.0.0.1:${server.port}`);
console.log(
  "Temporary test data only. No Electron, real Wazuh or model is started.",
);
async function stop() {
  server.stop();
  await runtime.close();
  await directory.dispose();
  process.exit(0);
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
