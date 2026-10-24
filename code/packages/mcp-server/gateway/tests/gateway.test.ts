import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpGateway, type TrustedAdmission } from '../index.js';
import { context, FakeClock, FakeIds } from '@campussec/testkit';
import { ok, fail, type CallContext, type JsonObject, type ToolInvocation } from '@campussec/contracts';
async function fixture() {
    const ids = new FakeIds(), ctx = context(), system: CallContext = { ...ctx, actor: { ...ctx.actor, role: 'system' } }, evidence: CallContext = { ...ctx, actor: { ...ctx.actor, role: 'evidence', runId: ids.next() } };
    const admission: TrustedAdmission = { context: evidence, transportBindingId: ids.next(), allowedTools: ['get_case_context', 'request_investigation'] };
    let permitted = true, invocations = 0, revoked = 0;
    const acknowledgements: string[] = [], calls: ToolInvocation[] = [];
    const unavailable = async () => fail('CAPABILITY_UNAVAILABLE', 'unused synthetic port');
    const gateway = createMcpGateway({ clock: new FakeClock(), channels: { revokeAll: async () => { revoked++; return ok(undefined); } }, delegationCommands: { create: unavailable, provideInput: unavailable, cancel: unavailable }, delegationReads: { status: unavailable }, scope: { list: unavailable, capabilities: unavailable, agents: unavailable }, origins: { resolveOrigin: unavailable }, results: { getResult: unavailable }, tools: { invoke: async (c, input) => { assert.equal(c.actor.role, 'evidence'); assert.equal(c.actor.runId, evidence.actor.runId); calls.push(input); invocations++; return ok({ isError: false, text: '{"synthetic":true}', structured: { synthetic: true }, preparedProjectionIds: [] }); }, acknowledgeReply: async (_ctx, input) => { acknowledgements.push(input.outcome); return ok(undefined); } }, authentication: { authenticate: async (req) => req.headers.authorization === 'Bearer synthetic-test-only' ? ok(admission) : fail('UNAUTHENTICATED', 'synthetic credential required'), recheck: async () => permitted ? ok(undefined) : fail('FORBIDDEN', 'synthetic revocation') } });
    const started = await gateway.start(system);
    assert.ok(started.ok);
    assert.ok(started.value.endpoint);
    const endpoint = started.value.endpoint;
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer synthetic-test-only', 'MCP-Protocol-Version': '2025-06-18' };
    const call = (method: string, params?: unknown, extra: Record<string, string> = {}) => fetch(endpoint, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify({ jsonrpc: '2.0', id: ids.next(), method, ...(params ? { params } : {}) }) });
    return { gateway, system, endpoint, headers, call, admission, acknowledgements, calls, invocations: () => invocations, setPermitted: (v: boolean) => { permitted = v; }, revoked: () => revoked, async close() { const stopped = await gateway.stop(system); assert.ok(stopped.ok); } };
}
test('actual loopback MCP initializes, separates tools by role, validates request params and acknowledges only sent evidence', async () => {
    const f = await fixture();
    try {
        const initialized = await f.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } });
        assert.equal(initialized.status, 200);
        assert.equal((await initialized.json()).result.protocolVersion, '2025-06-18');
        const listed = await f.call('tools/list');
        const tools = (await listed.json()).result.tools;
        assert.deepEqual(tools.map((t: {
            name: string;
        }) => t.name), ['get_case_context']);
        const forged = await f.call('tools/call', { name: 'get_case_context', arguments: { actor: { role: 'system' }, sessionId: 'claimed' } });
        assert.equal((await forged.json()).result.isError, true);
        assert.equal(f.invocations(), 0);
        const recursive = await f.call('tools/call', { name: 'request_investigation', arguments: {} });
        assert.equal((await recursive.json()).result.isError, true);
        assert.equal(f.invocations(), 0);
        const called = await f.call('tools/call', { name: 'get_case_context', arguments: {} });
        const reply = (await called.json()).result;
        assert.equal(reply.isError, false);
        assert.deepEqual(JSON.parse(reply.content[0].text), reply.structuredContent);
        assert.equal(f.invocations(), 1);
        assert.equal(f.calls[0]?.transportBindingId, f.admission.transportBindingId);
        assert.deepEqual(f.acknowledgements, ['released']);
    }
    finally {
        await f.close();
    }
    assert.equal(f.revoked(), 1);
});
test('MCP rejects missing auth, hostile Origin/Host, malformed JSON, unsupported version and absent Accept', async () => {
    const f = await fixture();
    try {
        assert.equal((await f.call('tools/list', {}, { Authorization: '' })).status, 401);
        assert.equal((await f.call('tools/list', {}, { Origin: 'https://malicious.example' })).status, 403);
        const hostile = await new Promise<number>(resolve => { const req = httpRequest(f.endpoint, { method: 'POST', headers: { ...f.headers, Host: 'malicious.example' } }, res => { res.resume(); resolve(res.statusCode!); }); req.end('{}'); });
        assert.equal(hostile, 403);
        assert.equal((await f.call('tools/list', {}, { 'MCP-Protocol-Version': '1900-01-01' })).status, 400);
        assert.equal((await f.call('tools/list', {}, { Accept: 'application/json' })).status, 406);
        assert.equal((await fetch(f.endpoint, { method: 'POST', headers: f.headers, body: '{broken' })).status, 400);
        assert.equal((await fetch(f.endpoint, { headers: f.headers })).status, 405);
        const notification = await fetch(f.endpoint, { method: 'POST', headers: f.headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
        assert.equal(notification.status, 202);
        assert.equal(f.invocations(), 0);
    }
    finally {
        await f.close();
    }
});
test('authorization revoked while a reply is being prepared fences delivery and marks projections uncertain', async () => {
    const f = await fixture();
    try {
        f.setPermitted(false);
        const reply = await f.call('tools/call', { name: 'get_case_context', arguments: {} });
        assert.equal(reply.status, 403);
        assert.equal(f.invocations(), 1);
        assert.deepEqual(f.acknowledgements, ['uncertain']);
        assert.equal((await f.gateway.start({ ...f.system, actor: { ...f.system.actor, role: 'ui' } })).ok, false);
    }
    finally {
        await f.close();
    }
});
