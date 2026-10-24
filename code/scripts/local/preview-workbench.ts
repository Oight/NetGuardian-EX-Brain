/** Bun-only synthetic browser harness. It is never imported by product code or the standard build. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { composeRuntime } from "../../apps/desktop/runtime/compose.ts";
import { temporaryDirectory } from "../../tests/support/storage.ts";
import { fail, parseRpcRequest } from "@campussec/contracts";
if (!process.versions.bun) throw new Error("Run this local harness with Bun");
// Never load another project's environment or silently retain a former live-integration option.
if (process.argv.includes("--live-mui"))
  throw new Error(
    "Live integration tooling has been removed; use the production DesktopApi connection settings",
  );
const portOption = process.argv.find((value) => value.startsWith("--port="));
const requestedPort = portOption ? Number(portOption.slice(7)) : 0;
if (
  !Number.isInteger(requestedPort) ||
  requestedPort < 0 ||
  requestedPort > 65535
)
  throw new Error("Invalid local preview port");
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
const bar=document.createElement('aside');bar.className='fixture-banner';bar.textContent='合成验收环境 · 本地临时 SQLite · 禁止真实平台连接 ';document.body.prepend(bar);
const restart=document.createElement('button');restart.textContent='重启本地测试核心';restart.onclick=async()=>{await fetch('/restart',{method:'POST'});location.reload();};bar.append(restart);
const concurrent=document.createElement('button');concurrent.textContent='模拟另一人保存背景';concurrent.onclick=async()=>{const api=window.campusSec;const r=await api.invoke({protocolVersion:'0.1.0',requestId:crypto.randomUUID(),method:'cases.list',payload:{page:{limit:1}}});if(!r.result.ok||!r.result.value.items.length)return;const c=r.result.value.items[0];await api.invoke({protocolVersion:'0.1.0',requestId:crypto.randomUUID(),method:'cases.putContext',payload:{caseId:c.id,expectedRevision:c.revision,context:{caseId:c.id,connectionId:c.scope.connectionId,agentIds:c.scope.agentIds,text:'另一人已保存的背景',sourceLabel:'合成并发操作',verification:'unverified',from:c.scope.from,to:c.scope.to}}});};bar.append(concurrent);`;
const server = localRuntime.Bun.serve({
  hostname: "127.0.0.1",
  port: requestedPort,
  async fetch(request) {
    const url = new URL(request.url),
      origin = `http://127.0.0.1:${server.port}`;
    if (request.method === "POST") {
      if (request.headers.get("origin") !== origin)
        return new Response("Forbidden", { status: 403 });
      if (url.pathname === "/qa/validate") {
        const result = parseRpcRequest(await request.json());
        return result.ok
          ? Response.json({ ok: true })
          : Response.json(result.error, { status: 400 });
      }
      if (url.pathname === "/qa/result") {
        const result = (await request.json()) as {
          passed: number;
          total: number;
          failures: string[];
        };
        if (
          !Number.isSafeInteger(result.passed) ||
          !Number.isSafeInteger(result.total) ||
          !Array.isArray(result.failures)
        )
          return new Response("Invalid report", { status: 400 });
        await mkdir(".local/frontend-integration", { recursive: true });
        await writeFile(
          ".local/frontend-integration/browser-result.json",
          JSON.stringify(
            { ...result, verifiedAt: new Date().toISOString() },
            null,
            2,
          ),
        );
        console.log(`Browser acceptance: ${result.passed}/${result.total}`);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/invoke") {
        try {
          const input = await request.json();
          return Response.json(
            await runtime.facade.invoke(runtime.context(), input),
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
    if (url.pathname === "/qa/")
      return new Response(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'"><title>前端合成验收</title><link rel="stylesheet" href="/qa/style.css"><h1>前端合成验收</h1><p>真实页面与 CSS · 合成 DesktopApi · 每次请求经过 S01 校验 · 不访问平台</p><h2 id="qa-summary">正在执行…</h2><ol id="qa-results"></ol><iframe id="qa-frame" width="1280" height="950" src="/qa/frame.html" title="隔离的界面验收"></iframe><script type="module" src="/qa/browser-suite.js"></script></html>`,
        { headers: { "content-type": "text/html" } },
      );
    if (url.pathname === "/qa/frame.html")
      return new Response(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'"><link rel="stylesheet" href="/style.css"><main id="app"></main></html>`,
        { headers: { "content-type": "text/html" } },
      );
    if (url.pathname === "/qa/style.css")
      return new Response(
        "body{font:14px/1.8 system-ui;margin:24px;color:#243148;background:#f5f7fb}h1{font-size:25px}.pass{color:#16866a}.fail{color:#ce4658}iframe{border:1px solid #e6ebf2;background:white;display:block;margin-top:24px}",
        { headers: { "content-type": "text/css" } },
      );
    if (url.pathname === "/qa/browser-suite.js")
      return new Response(
        await readFile(
          "dist-test/apps/desktop/renderer/tests/browser-suite.js",
          "utf8",
        ),
        { headers: { "content-type": "text/javascript" } },
      );
    if (url.pathname === "/qa/showcase.js")
      return new Response(
        await readFile(
          "dist-test/apps/desktop/renderer/tests/showcase.js",
          "utf8",
        ),
        { headers: { "content-type": "text/javascript" } },
      );
    if (url.pathname === "/showcase/")
      return new Response(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'"><title>融合工作台 · 合成界面预览</title><link rel="stylesheet" href="/style.css"><aside class="fixture-banner">合成界面示例 · 全部数据为合成数据 · 不连接平台、不执行真实调查 <button id="show-synthetic-chart" type="button">展示合成统计</button></aside><main id="app"></main><script type="module" src="/qa/showcase.js"></script></html>`,
        { headers: { "content-type": "text/html" } },
      );
    if (url.pathname === "/fixture.js")
      return new Response(fixture, {
        headers: { "content-type": "text/javascript" },
      });
    const assets: Record<string, string> = {
      "/": "index.html",
      "/index.html": "index.html",
      "/view.js": "view.js",
      "/style.css": "style.css",
    };
    for (const name of [
      "app",
      "api",
      "model",
      "ui",
      "context",
      "charts",
      "platform",
      "reports",
      "investigations",
      "settings",
    ])
      assets[`/${name}.js`] = `${name}.js`;
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
