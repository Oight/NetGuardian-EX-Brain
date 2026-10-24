import { createAuthentication } from '../../apps/desktop/main/authentication.ts';
import { createAuthController } from '../../apps/desktop/main/auth-controller.ts';
/** Bun-only browser acceptance. All upstream responses, host sessions and execution outcomes are synthetic. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { composeRuntime } from '../../apps/desktop/runtime/compose.ts';
import { serveWorkbench } from '../../apps/desktop/runtime/web-server.ts';
import { temporaryDirectory } from '../../tests/support/storage.ts';
import { FakeClock, FakeIds, SPACE, PRINCIPAL } from '@campussec/testkit';
import { ok, fail, type Result, type AnalysisRun, type ExecutionSnapshot, type OriginBinding, type JsonObject } from '@campussec/contracts';
import { createCampusProxy } from '@campussec/wazuh-adapter';
import { createChannelAuthenticator, channelSecretPurpose } from '@campussec/mcp-server/channels';
import type { ExecutionWire } from '@campussec/teleagent-bridge/execution';
if (!process.versions.bun)
    throw Error('Bun-only synthetic harness');
const localBun = globalThis as typeof globalThis & {
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
const directory = await temporaryDirectory(), clock = new FakeClock(), ids = new FakeIds();
function take<T>(r: Result<T>): T {
    if (!r.ok)
        throw Error(`${r.error.code}: ${r.error.message}`);
    return r.value;
}
let event = 1, phase: ExecutionSnapshot['phase'] = 'running', latest: AnalysisRun | undefined, channelId = '', bindingId = '', token = new Uint8Array(), hostFound = false, sends = 0;
let runtime!: Extract<Awaited<ReturnType<typeof composeRuntime>>, {
    ok: true;
}>['value'];
const snapshot = (runId: string, p: ExecutionSnapshot['phase']): ExecutionSnapshot => ({
    runId, phase: p, verification: p === 'uncertain' ? 'unverified' : 'verified', sessionId: 'synthetic-dedicated-session', userMessageId: 'synthetic-input', ...(p === 'completed' ? {
        resultMessageId: 'synthetic-result', finishReason: 'stop', usage: {
            inputTokens: 120, outputTokens: 80, estimated: false, costKnown: false
        }
    } : {}), observedAt: clock.now()
});
const wire: ExecutionWire = {
    start: async (ctx, input) => {
        latest = input.run;
        phase = 'running';
        channelId = input.channel.id;
        bindingId = ids.next();
        take(await runtime.services.channels.bindChannel(ctx, {
            channelId, runId: latest.id, trustedSessionBindingId: bindingId
        }));
        token = take(await runtime.secrets.use(input.channel.secretRef, channelSecretPurpose(channelId), async (bytes) => new Uint8Array(bytes)));
        return ok(snapshot(latest.id, phase));
    }, inspect: async (_ctx, id) => ok(snapshot(id, phase)), abort: async (_ctx, id) => {
        phase = 'cancelled';
        return ok(snapshot(id, phase));
    }
};
const originBinding: OriginBinding = {
    id: ids.next(), spaceId: SPACE, principalId: PRINCIPAL, hostId: ids.next(), hostAccountId: ids.next(), workspaceId: ids.next(), sessionId: 'synthetic-original-conversation', requestMessageId: 'synthetic-human-message', state: 'active', createdAt: clock.now(), expiresAt: '2026-10-24T01:00:00.000Z'
};
const external = createCampusProxy({ fetch: (async (url, init) => {
        if (init?.method !== 'GET' || new URL(String(url)).hostname !== '127.0.0.1')
            throw Error('Synthetic harness forbids network');
        const u = new URL(String(url));
        if (u.pathname === '/api/agents')
            return Response.json({
                status: 'ok', warnings: [], total: 1, data: [{
                        id: '001', name: '合成校园终端', status: 'active', version: 'synthetic'
                    }]
            });
        if (u.pathname.startsWith('/api/agents/001/'))
            return Response.json({
                status: 'ok', warnings: [], total: 1, data: [{
                        id: 'native-resource', name: 'synthetic-package', version: '1', architecture: 'x64', scan: { id: 1, time: clock.now() }, os: { name: 'Synthetic OS' }
                    }]
            });
        if (u.pathname === '/api/summary')
            return Response.json({ alerts: { status: 'ok', data: {
                        total: { value: 1, relation: 'eq' }, levels: [{ key: 7, doc_count: 1 }], trend: [{ time: Date.parse(clock.now()) - 3600000, count: 1 }]
                    } }, connection: { tls: 'strict' } });
        if (u.pathname === '/api/events')
            return Response.json({
                status: 'ok', warnings: [], data: { items: [{
                            index: 'wazuh-alerts-4.x-synthetic', documentId: 'event-' + event, time: Date.parse(u.searchParams.get('to') ?? clock.now()) - 1000, agentId: '001', agentName: '合成校园终端', ruleId: '100', level: 7, groups: ['synthetic'], title: '合成告警 · 无真实安全含义'
                        }], total: { value: 1, relation: 'eq' } }
            });
        return Response.json({ status: 'error', code: 'NOT_FOUND' }, { status: 404 });
    }) as typeof fetch });
let web: Awaited<ReturnType<typeof serveWorkbench>> | undefined;
const authentication = createAuthController({ authentication: await createAuthentication({ directory: resolve(directory.path, 'auth') }), open: async (account, protection, databaseProtection) => {
        originBinding.spaceId = account.spaceId;
        originBinding.principalId = account.id;
        const opened = await composeRuntime({
            dataDir: directory.path, spaceId: account.spaceId, principalId: account.id, identityEpoch: 1, clock, ids, protection, databaseProtection, http: { request: async () => fail('FORBIDDEN', '合成验收禁止真实平台') }, externalPlatform: external, executionWire: wire, backgroundEnabled: false, hostWire: {
                capabilities: async () => ok([]), resolveOrigin: async () => ok(originBinding), deliver: async () => {
                    sends++;
                    throw Error('Synthetic lost receipt');
                }, reconcileDelivery: async () => ok(hostFound ? { state: 'found', receipt: {
                        messageId: 'synthetic-visible-result', visible: true, observedAt: clock.now()
                    } } : { state: 'unknown' })
            }, saveExport: async (value) => web ? web.saveExport(value) : fail('CAPABILITY_UNAVAILABLE', 'Not started')
        });
        if (opened.ok)
            runtime = opened.value;
        return opened;
    } });
const system = () => ({ ...runtime.context(), actor: { ...runtime.context().actor, role: 'system' as const } });
web = await serveWorkbench({
    authentication, assets: resolve('dist/apps/desktop/renderer'), port: 0, label: '合成流程验收 · 真实业务核心 / SQLite · 所有 Wazuh、模型与宿主响应均为合成数据'
});
const inner = web.origin;
const requestedPort=Number(process.argv.find(value=>value.startsWith('--port='))?.slice(7)??4181);
if(!Number.isInteger(requestedPort)||requestedPort<0||requestedPort>65535)throw Error('Invalid synthetic preview port');
const server = localBun.Bun.serve({
    hostname: '127.0.0.1', port: requestedPort, async fetch(request) {
        const url = new URL(request.url), origin = `http://127.0.0.1:${server.port}`;
        if (request.method === 'POST' && url.pathname.startsWith('/qa/')) {
            if (request.headers.get('origin') !== origin)
                return new Response('Forbidden', { status: 403 });
            const p = await request.json() as {
                action?: string;
                name?: string;
                args?: JsonObject;
                request?: JsonObject;
                [key: string]: unknown;
            };
            try {
                if (url.pathname === '/qa/result') {
                    await mkdir('.local/web-acceptance', { recursive: true });
                    await writeFile('.local/web-acceptance/' + (p.kind === 'flows' ? 'flows' : 'ui') + '.json', JSON.stringify({ ...p, verifiedAt: new Date().toISOString() }, null, 2));
                    return Response.json({ ok: true });
                }
                if (url.pathname === '/qa/validate') {
                    const { parseRpcRequest } = await import('@campussec/contracts');
                    return Response.json(parseRpcRequest(p));
                }
                if (url.pathname !== '/qa/control')
                    return new Response('Not found', { status: 404 });
                if (p.action === 'tick')
                    return Response.json(await runtime.services.requests.tick(system()));
                if (p.action === 'complete') {
                    phase = 'completed';
                    return Response.json(await runtime.services.requests.tick(system()));
                }
                if (p.action === 'uncertain') {
                    phase = 'uncertain';
                    return Response.json(await runtime.services.requests.tick(system()));
                }
                if (p.action === 'poll')
                    return Response.json(await runtime.services.alerts.pollOnce(system(), String(p.connectionId)));
                if (p.action === 'advance') {
                    clock.advance(10001);
                    event++;
                    return Response.json(ok({ now: clock.now() }));
                }
                if (p.action === 'delivery') {
                    hostFound = p.found === true;
                    const result = await runtime.services.delivery.tick(system());
                    return Response.json(result.ok ? ok({ sends }) : result);
                }
                if (p.action === 'delegated') {
                    take(await runtime.services.host.resolveOrigin(system(), ids.next()));
                    const caller = { ...runtime.context(), actor: {
                            ...runtime.context().actor, role: 'delegation' as const, originBindingId: originBinding.id
                        } };
                    return Response.json(await runtime.services.requests.create(caller, {
                        origin: 'teleagent_user', originBindingId: originBinding.id, connectionId: String(p.connectionId), question: '合成宿主人类委托', requestedScope: p.scope as never, seedRefs: [], idempotencyKey: ids.next()
                    }));
                }
                if (p.action === 'tool' && latest && p.name && ['get_case_context', 'search_related_alerts', 'propose_report', 'record_investigation_step'].includes(p.name)) {
                    const auth = take(await createChannelAuthenticator({
                        db: runtime.storage.db, secrets: runtime.secrets, clock
                    }).authenticate(system(), {
                        channelId, token, trustedSessionBindingId: bindingId
                    }));
                    const callId = ids.next(), result = await runtime.services.tools.invoke(auth.context, {
                        transportBindingId: auth.transportBindingId, callId, toolName: p.name, arguments: p.args ?? {}
                    });
                    if (result.ok && !result.value.isError)
                        take(await runtime.services.tools.acknowledgeReply(auth.context, {
                            transportBindingId: auth.transportBindingId, callId, outcome: 'released'
                        }));
                    return Response.json(result.ok ? ok(JSON.parse(result.value.text)) : result);
                }
                return Response.json(fail('INVALID_INPUT', '未知合成控制'));
            }
            catch (error) {
                return Response.json(fail('INTERNAL', error instanceof Error ? error.message : '合成控制失败'));
            }
        }
        const files: Record<string, string> = { '/qa/browser-suite.js': 'dist-test/apps/desktop/renderer/tests/browser-suite.js', '/qa/workflows.js': 'dist-test/apps/desktop/renderer/tests/web-workflows.js' };
        if (files[url.pathname])
            return new Response(await readFile(files[url.pathname]!, 'utf8'), { headers: { 'content-type': 'text/javascript' } });
        if (url.pathname === '/qa/frame.html')
            return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><main id="app"></main></html>', { headers: { 'content-type': 'text/html' } });
        if (url.pathname === '/qa/' || url.pathname === '/qa/flows')
            return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>网页合成验收</title><style>body{font:15px/1.8 system-ui;margin:24px;background:#f5f7fb;color:#243148}.pass{color:#16866a}.fail{color:#c72540}iframe{height:900px;border:1px solid #ccd4df}</style><h1>${url.pathname === '/qa/' ? '界面行为' : '实际核心网页流程'}验收</h1><p>全部平台、模型和宿主响应为合成数据；不构成 Windows 或真实系统验收。</p><h2 id="qa-summary">正在执行</h2><ol id="qa-results"></ol><iframe id="qa-frame" width="1280" title="实际工作台" src="${url.pathname === '/qa/' ? '/qa/frame.html' : '/'}"></iframe><script type="module" src="/qa/${url.pathname === '/qa/' ? 'browser-suite' : 'workflows'}.js"></script></html>`, { headers: { 'content-type': 'text/html' } });
        // Proxy into the real HTTP transport while retaining its Origin/Host validation on the inner hop.
        const headers = new Headers(request.headers);
        headers.delete('host');
        if (headers.has('origin'))
            headers.set('origin', inner);
        return fetch(new URL(url.pathname + url.search, inner), {
            method: request.method, headers, body: request.method === 'GET' ? undefined : await request.arrayBuffer(), redirect: 'manual'
        });
    }
});
console.log(`Synthetic browser acceptance: http://127.0.0.1:${server.port}/qa/ and /qa/flows`);
async function stop() {
    server.stop();
    await web?.close();
    await authentication.close();
    token.fill(0);
    await directory.dispose();
    process.exit(0);
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
