import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, fail, type HttpPort, type HttpRequest, type HttpResponse, type PlatformCall, type Result } from '@campussec/contracts';
import { context, CONNECTION, SPACE, scope, createScriptedHttp } from '@campussec/testkit';
import { storageFixture } from '../../../tests/support/storage.js';
import { createSecretStore } from '../../../apps/desktop/main/secrets.js';
import { createWazuhAdapter } from '../src/index.js';
import { endpoint, createStrictHttp } from '../src/http.js';
function take<T>(r: Result<T>): T { assert.ok(r.ok, r.ok ? '' : r.error.code); return r.value; }
const response = (status: number, body: unknown): Result<HttpResponse> => ok({ status, headers: {}, bodyText: typeof body === 'string' ? body : JSON.stringify(body) });
const server = (items: unknown[], total = items.length, failed = 0) => ({ error: 0, data: { affected_items: items, total_affected_items: total, total_failed_items: failed } });
const index = (hits: unknown[] = [], total = hits.length) => ({ timed_out: false, _shards: { failed: 0 }, hits: { total: { value: total, relation: 'eq' }, hits } });
async function fixture(http?: HttpPort) {
    const f = await storageFixture(), script = createScriptedHttp();
    const secrets = createSecretStore({ directory: f.directory.path + '/secrets', spaceId: SPACE, protection: { available: () => false, encrypt: () => { throw new Error('No persistence'); }, decrypt: () => { throw new Error('No persistence'); } }, authorizeOwner: () => true });
    const indexer = take(await secrets.put({ owner: SPACE, purpose: `wazuh:indexer:${CONNECTION}`, value: new TextEncoder().encode(JSON.stringify({ username: 'index-user', password: 'index-synthetic' })), persist: false }));
    const apiSecret = take(await secrets.put({ owner: SPACE, purpose: `wazuh:server:${CONNECTION}`, value: new TextEncoder().encode(JSON.stringify({ username: 'server-user', password: 'server-synthetic' })), persist: false }));
    const adapter = createWazuhAdapter({ ...f, secrets, http: http ?? script.port });
    const p = take(await adapter.save(context(), { id: CONNECTION, spaceId: SPACE, platformInstanceId: SPACE, displayName: '合成 Wazuh', indexerBaseUrl: 'https://indexer.invalid/proxy/', serverBaseUrl: 'https://server.invalid/api/', indexerSecretRef: indexer, serverSecretRef: apiSecret, alertsPattern: 'wazuh-alerts-*', mappingVersion: 'wazuh-alerts-v1', principalFingerprint: 'synthetic-principal' }));
    let attempts = 0;
    const controller = new AbortController();
    const call: PlatformCall = { signal: controller.signal, beforeAttempt: async () => { attempts++; return ok(undefined); } };
    return { ...f, secrets, adapter, p, script, call, controller, attempts: () => attempts, async dispose() { secrets.close(); await f.dispose(); } };
}
test('configuration is offline, validates HTTPS and patterns, enforces generation CAS and principal switching', async () => {
    const f = await fixture();
    try {
        assert.equal(f.script.script.calls.length, 0);
        assert.equal(take(await f.adapter.list(context())).length, 1);
        const { generation, updatedAt, ...rest } = f.p;
        const bad = await f.adapter.save(context(), { ...rest, indexerBaseUrl: 'http://localhost', expectedGeneration: generation });
        assert.ok(!bad.ok && bad.error.code === 'INVALID_INPUT');
        assert.equal((await f.adapter.save(context(), { ...rest, alertsPattern: '*', expectedGeneration: generation })).ok, false);
        const second = take(await f.adapter.save(context(), { ...rest, displayName: '改名', expectedGeneration: generation }));
        assert.equal(second.generation, 2);
        const conflict = await f.adapter.save(context(), { ...rest, expectedGeneration: 1 });
        assert.ok(!conflict.ok && conflict.error.code === 'REVISION_CONFLICT');
        const changed = await f.adapter.save(context(), { ...rest, expectedGeneration: 2, principalFingerprint: 'new-principal' });
        assert.ok(!changed.ok && changed.error.code === 'IDENTITY_CHANGED');
    }
    finally {
        await f.dispose();
    }
});
test('URL joining preserves proxy prefixes and rejects traversal, userinfo and widened segments', () => {
    assert.equal(endpoint('https://example.invalid/prefix/', ['syscollector', '001', 'os']), 'https://example.invalid/prefix/syscollector/001/os');
    for (const base of ['https://u:p@example.invalid', 'https://example.invalid/a/../b', 'https://example.invalid/a%2fb', 'http://example.invalid'])
        assert.throws(() => endpoint(base, ['agents']));
    assert.throws(() => endpoint('https://example.invalid', ['..']));
});
test('Server and Indexer authenticate independently; every login/query attempt is reserved', async () => {
    const f = await fixture();
    try {
        f.script.script.push(async (req) => { assert.match(req.url, /\/api\/security\/user\/authenticate\?raw=true$/); assert.match(req.headers.authorization ?? '', /^Basic /); assert.equal(Buffer.from(req.headers.authorization!.slice(6), 'base64').toString(), 'server-user:server-synthetic'); return response(200, 'header.payload.signature'); });
        f.script.script.push(async (req) => { assert.match(req.headers.authorization ?? '', /^Bearer /); return response(200, server([{ id: '001', name: '设备' }])); });
        assert.equal(take(await f.adapter.agents(context(), { connectionId: CONNECTION, page: { limit: 20 } })).items.length, 1);
        f.script.script.push(async (req) => { assert.equal(Buffer.from(req.headers.authorization!.slice(6), 'base64').toString(), 'index-user:index-synthetic'); return response(200, index()); });
        const result = take(await f.adapter.query(context(), { kind: 'alerts', scope, filter: {}, page: { limit: 20 }, fixedUpper: scope.to }, f.call));
        assert.equal(result.coverage.queryCompleteness, 'complete');
        assert.equal(result.records.length, 0);
        assert.equal(f.attempts(), 1);
        f.script.script.assertDrained();
    }
    finally {
        await f.dispose();
    }
});
test('Server renews JWT only once after 401 and never retries a denied business endpoint', async () => {
    const f = await fixture();
    try {
        for (const reply of [response(200, 'one.payload.signature'), response(401, {}), response(200, 'two.payload.signature'), response(403, {})])
            f.script.script.push(async () => reply);
        const denied = await f.adapter.deviceDetail(context(), { connectionId: CONNECTION, agentId: '001', category: 'os', page: { limit: 20 } }, f.call);
        assert.equal(take(denied).status, 'denied');
        assert.equal(f.script.script.calls.length, 4);
        assert.equal(f.attempts(), 4);
        f.script.script.assertDrained();
    }
    finally {
        await f.dispose();
    }
});
test('Indexer 401 never sends Server credentials and 403 is not zero results', async () => {
    const f = await fixture();
    try {
        f.script.script.push(async () => response(401, {}));
        const auth = await f.adapter.query(context(), { kind: 'alerts', scope, filter: {}, page: { limit: 20 }, fixedUpper: scope.to }, f.call);
        assert.ok(!auth.ok && auth.error.code === 'UPSTREAM_AUTH');
        assert.equal(f.script.script.calls.length, 1);
        f.script.script.push(async () => response(403, {}));
        const page = take(await f.adapter.query(context(), { kind: 'alerts', scope, filter: {}, page: { limit: 20 }, fixedUpper: scope.to }, f.call));
        assert.equal(page.status, 'denied');
        assert.equal(page.coverage.queryCompleteness, 'not_executed');
        const facts = take(await f.adapter.capabilities(context(), CONNECTION, false));
        assert.equal(facts.find(c => c.name === 'alerts')?.state, 'denied');
        assert.equal(facts.find(c => c.name === 'agents')?.state, 'unverified');
    }
    finally {
        await f.dispose();
    }
});
test('fixed alert search is scoped; unstable pagination and failed shards remain partial without fabricated cursor', async () => {
    const f = await fixture();
    try {
        f.script.script.push(async (req) => { const body = JSON.parse(req.bodyText!); assert.equal(body.size, 20); assert.deepEqual(body.query.bool.filter, [{ terms: { 'agent.id': ['001'] } }, { range: { timestamp: { gte: scope.from, lt: scope.to } } }]); assert.equal(JSON.stringify(body).includes('_id'), false); return response(200, { ...index([{ _index: 'wazuh-alerts-synthetic', _id: 'one', _source: { timestamp: '2026-10-23T00:40:00+00:00', agent: { id: '001' }, rule: { id: '1', level: 5 } } }], 100), _shards: { failed: 1 } }); });
        const result = take(await f.adapter.query(context(), { kind: 'alerts', scope, filter: {}, page: { limit: 20 }, fixedUpper: scope.to }, f.call));
        assert.equal(result.status, 'partial');
        assert.equal(result.nextCursor, undefined);
        assert.equal(result.records[0]?.observedAt, '2026-10-23T00:40:00.000Z');
        assert.equal(result.records[0]?.source.documentId, 'one');
        assert.ok(result.warnings.length >= 2);
    }
    finally {
        await f.dispose();
    }
});
test('budget denial and cancellation before send perform no network request', async () => {
    const f = await fixture();
    try {
        const denied = await f.adapter.query(context(), { kind: 'alerts', scope, filter: {}, page: { limit: 20 }, fixedUpper: scope.to }, { ...f.call, beforeAttempt: async () => fail('BUDGET_EXHAUSTED', '预算耗尽') });
        assert.ok(!denied.ok && denied.error.code === 'BUDGET_EXHAUSTED');
        assert.equal(f.script.script.calls.length, 0);
        f.controller.abort();
        const cancelled = await f.adapter.query(context(), { kind: 'alerts', scope, filter: {}, page: { limit: 20 }, fixedUpper: scope.to }, f.call);
        assert.ok(!cancelled.ok && cancelled.error.code === 'CANCELLED');
        assert.equal(f.script.script.calls.length, 0);
    }
    finally {
        await f.dispose();
    }
});
test('cancellation or changed generation after response fences old successful data', async () => {
    const f = await fixture();
    try {
        f.script.script.push(async () => { const { generation, updatedAt, ...rest } = f.p; take(await f.adapter.save(context(), { ...rest, displayName: '新代次', expectedGeneration: generation })); return response(200, index()); });
        const changed = await f.adapter.query(context(), { kind: 'alerts', scope, filter: {}, page: { limit: 20 }, fixedUpper: scope.to }, f.call);
        assert.ok(!changed.ok && changed.error.code === 'IDENTITY_CHANGED');
    }
    finally {
        await f.dispose();
    }
    const g = await fixture();
    try {
        g.script.script.push(async () => { g.controller.abort(); return response(200, index()); });
        const cancelled = await g.adapter.query(context(), { kind: 'alerts', scope, filter: {}, page: { limit: 20 }, fixedUpper: scope.to }, g.call);
        assert.ok(!cancelled.ok && cancelled.error.code === 'CANCELLED');
    }
    finally {
        await g.dispose();
    }
});
test('TLS failures, redirect responses and oversized fake bodies are rejected with safe diagnostics', async () => {
    const f = await fixture();
    try {
        for (const reply of [fail('TLS_UNTRUSTED', '证书不可信'), response(302, {}), response(200, 'x'.repeat(4 * 1024 * 1024 + 1))]) {
            f.script.script.push(async () => reply);
            const result = await f.adapter.query(context(), { kind: 'alerts', scope, filter: {}, page: { limit: 20 }, fixedUpper: scope.to }, f.call);
            assert.equal(result.ok, false);
        }
        assert.equal(f.script.script.calls.length, 3);
        assert.equal((await createStrictHttp().request({ method: 'GET', url: 'http://example.invalid', headers: {}, timeoutMs: 1000, signal: new AbortController().signal })).ok, false);
    }
    finally {
        await f.dispose();
    }
});
test('Server query cursors bind scope and return stable page identities on retries; source scan time stays old', async () => {
    const f = await fixture();
    try {
        f.script.script.push(async () => response(200, 'one.payload.signature'));
        f.script.script.push(async () => response(200, server([{ id: 'row1', name: 'pkg', scan: { id: 'scan1', time: '2026-10-20T00:00:00Z' } }], 2)));
        const query = { kind: 'inventory' as const, scope, category: 'packages' as const, page: { limit: 1 } };
        const first = take(await f.adapter.query(context(), query, f.call));
        assert.ok(first.nextCursor);
        assert.equal(first.records[0]?.observedAt, '2026-10-20T00:00:00.000Z');
        assert.ok(first.warnings.some(s => s.includes('24')));
        f.script.script.push(async (req) => { assert.match(req.url, /offset=1/); return response(200, server([{ id: 'row2', name: 'pkg2', scan: { id: 'scan1', time: '2026-10-20T00:00:00Z' } }], 2)); });
        const second = take(await f.adapter.query(context(), { ...query, page: { limit: 1, cursor: first.nextCursor } }, f.call));
        assert.equal(second.pageOrdinal, 1);
        assert.equal(second.queryId, first.queryId);
        const count = f.script.script.calls.length;
        const retry = take(await f.adapter.query(context(), { ...query, page: { limit: 1, cursor: first.nextCursor } }, f.call));
        assert.equal(retry.pageId, second.pageId);
        assert.equal(retry.platformAttempts, 0);
        assert.equal(f.script.script.calls.length, count);
        const wrong = await f.adapter.query(context(), { ...query, category: 'ports', page: { limit: 1, cursor: first.nextCursor } }, f.call);
        assert.ok(!wrong.ok && wrong.error.code === 'CURSOR_INVALID');
    }
    finally {
        await f.dispose();
    }
});
test('missing native collection identity is a source limitation and never uses row position as identity', async () => {
    const f = await fixture();
    try {
        f.script.script.push(async () => response(200, 'one.payload.signature'));
        f.script.script.push(async () => response(200, server([{ name: 'without-scan' }])));
        const result = take(await f.adapter.deviceDetail(context(), { connectionId: CONNECTION, agentId: '001', category: 'packages', page: { limit: 20 } }, f.call));
        assert.equal(result.status, 'partial');
        assert.equal(result.items.length, 0);
        assert.ok(result.warnings.some(s => s.includes('源限制')));
    }
    finally {
        await f.dispose();
    }
});
test('unknown authentication/FIM mappings and multi-agent inventory are refused before network access', async () => {
    const f = await fixture();
    try {
        for (const query of [{ kind: 'authentication', scope, outcome: 'any', page: { limit: 20 } }, { kind: 'file_changes', scope, page: { limit: 20 } }, { kind: 'inventory', scope: { ...scope, agentIds: ['001', '002'] }, category: 'os', page: { limit: 20 } }] as const) {
            assert.equal((await f.adapter.query(context(), query as never, f.call)).ok, false);
        }
        assert.equal(f.script.script.calls.length, 0);
    }
    finally {
        await f.dispose();
    }
});
test('statistics uses deterministic size=0 scoped aggregations and preserves lower bounds/partial coverage', async () => {
    const f = await fixture();
    try {
        f.script.script.push(async (req) => { const body = JSON.parse(req.bodyText!); assert.equal(body.size, 0); assert.equal(body.aggs.hours.date_histogram.fixed_interval, '1h'); return response(200, { timed_out: false, _shards: { failed: 0 }, hits: { total: { value: 10, relation: 'gte' } }, aggregations: { levels: { buckets: [{ key: 5, doc_count: 10 }], sum_other_doc_count: 1, doc_count_error_upper_bound: 0 }, hours: { buckets: [{ key: Date.parse(scope.from), doc_count: 10 }] } } }); });
        const stats = take(await f.adapter.statistics(context(), { ...scope, from: '2026-10-22T01:00:00.000Z' }, f.call));
        assert.equal(stats.total.relation, 'gte');
        assert.equal(stats.coverage.queryCompleteness, 'partial');
        assert.equal(stats.byLevel[0]?.count, 10);
    }
    finally {
        await f.dispose();
    }
});
test('platform requests never exceed two concurrent slots, including independent adapter operations', async () => {
    let live = 0, max = 0;
    const f = await fixture({ request: async () => { live++; max = Math.max(max, live); await new Promise(r => setTimeout(r, 5)); live--; return response(200, index()); } });
    try {
        await Promise.all(Array.from({ length: 6 }, () => f.adapter.query(context(), { kind: 'alerts', scope, filter: {}, page: { limit: 20 }, fixedUpper: scope.to }, f.call)));
        assert.equal(max, 2);
        assert.equal(f.attempts(), 6);
    }
    finally {
        await f.dispose();
    }
});
test('concurrent Server queries share one login and transient 5xx retries reserve another attempt', async () => {
    let logins = 0, queries = 0;
    const f = await fixture({ request: async (req) => {
            if (req.url.includes('/authenticate')) {
                logins++;
                await new Promise(r => setTimeout(r, 5));
                return response(200, 'one.payload.signature');
            }
            queries++;
            if (queries === 1)
                return response(503, {});
            return response(200, server([{ id: 'item', name: 'pkg', scan: { id: 'scan', time: '2026-10-23T00:00:00Z' } }]));
        } });
    try {
        const calls = await Promise.all([f.adapter.deviceDetail(context(), { connectionId: CONNECTION, agentId: '001', category: 'packages', page: { limit: 20 } }, f.call), f.adapter.deviceDetail(context(), { connectionId: CONNECTION, agentId: '001', category: 'packages', page: { limit: 20 } }, f.call)]);
        assert.ok(calls.every(r => r.ok));
        assert.equal(logins, 1);
        assert.equal(queries, 3);
        assert.equal(f.attempts(), 4);
    }
    finally {
        await f.dispose();
    }
});
test('capability refresh probes business endpoints independently and never infers access from a root endpoint', async () => {
    const f = await fixture({ request: async (req) => {
            assert.notEqual(new URL(req.url).pathname, '/');
            if (req.url.includes('/authenticate'))
                return response(200, 'one.payload.signature');
            if (req.url.includes('wazuh-states-vulnerabilities-'))
                return response(403, {});
            if (req.url.includes('_search'))
                return response(200, index());
            if (req.url.includes('/agents?'))
                return response(200, server([{ id: '001' }]));
            return response(200, server([]));
        } });
    try {
        const facts = take(await f.adapter.capabilities(context(), CONNECTION, true));
        assert.equal(facts.find(c => c.name === 'alerts')?.state, 'available');
        assert.equal(facts.find(c => c.name === 'vulnerabilities')?.state, 'denied');
        assert.equal(facts.find(c => c.name === 'inventory_os')?.state, 'available');
        assert.equal(facts.find(c => c.name === 'stable_alert_pagination')?.state, 'unverified');
        assert.equal(facts.find(c => c.name === 'authentication_events')?.state, 'unverified');
    }
    finally {
        await f.dispose();
    }
});

test('vulnerability denial stays denied; unverified successful row mappings never become zero findings',async()=>{
 const f=await fixture();try{const query={kind:'findings' as const,category:'vulnerabilities' as const,scope,page:{limit:20}};f.script.script.push(async()=>response(403,{}));assert.equal(take(await f.adapter.query(context(),query,f.call)).status,'denied');f.script.script.push(async()=>response(200,index()));const unknown=await f.adapter.query(context(),query,f.call);assert.ok(!unknown.ok&&unknown.error.code==='CAPABILITY_UNAVAILABLE');}finally{await f.dispose();}
});
test('out-of-pattern index records and malformed statistics are rejected without leaking raw responses or throwing',async()=>{
 const f=await fixture();try{f.script.script.push(async()=>response(200,index([{_index:'unrelated-index',_id:'one',_source:{timestamp:'2026-10-23T00:45:00Z',agent:{id:'001'}}}])));const outside=await f.adapter.query(context(),{kind:'alerts',scope,filter:{},fixedUpper:scope.to,page:{limit:20}},f.call);assert.ok(!outside.ok&&outside.error.code==='SCOPE_EXCEEDED');f.script.script.push(async()=>response(200,{...index(),aggregations:{levels:{buckets:[],sum_other_doc_count:0,doc_count_error_upper_bound:0},hours:{buckets:[{key:'invalid-date',doc_count:0}]}}}));const bad=await f.adapter.statistics(context(),scope,f.call);assert.ok(!bad.ok&&bad.error.code==='UPSTREAM_UNAVAILABLE');}finally{await f.dispose();}
});

test('resource mapping refuses incomplete composite identities and ambiguous duplicated native keys',async()=>{
 const {resourceRecords}=await import('../src/mapping.js');const f=await fixture();try{
  const incomplete=resourceRecords(f.p,'001','packages',[{name:'pkg',scan:{id:'scan'}},{name:'pkg',description:'different row',scan:{id:'scan'}}],f.clock.now(),'inventory');
  assert.equal(incomplete.records.length,0);assert.ok(incomplete.warnings.some(message=>message.includes('源限制')));
  const duplicate=resourceRecords(f.p,'001','packages',[{id:'ambiguous',name:'a',scan:{id:'scan'}},{id:'ambiguous',name:'b',scan:{id:'scan'}}],f.clock.now(),'inventory');
  assert.equal(duplicate.records.length,0);assert.ok(duplicate.warnings.some(message=>message.includes('身份重复')));
  const numeric=resourceRecords(f.p,'001','packages',[{id:'native',name:'a',scan:{id:42}}],f.clock.now(),'inventory');assert.equal(numeric.records.length,1);assert.equal(numeric.records[0]?.timeQuality,'unknown');
 }finally{await f.dispose();}
});

test('a fixed upper bound earlier than the requested end is reflected in effective coverage',async()=>{
 const f=await fixture();try{f.script.script.push(async()=>response(200,index()));const upper='2026-10-23T00:45:00.000Z';const result=take(await f.adapter.query(context(),{kind:'alerts',scope,filter:{},fixedUpper:upper,page:{limit:20}},f.call));assert.equal(result.coverage.requestedScope.to,scope.to);assert.equal(result.coverage.effectiveScope.to,upper);assert.equal(result.coverage.queryCompleteness,'partial');}finally{await f.dispose();}
});
test('device records identifying a different agent are refused instead of being relabelled',async()=>{
 const f=await fixture();try{f.script.script.push(async()=>response(200,'one.payload.signature'));f.script.script.push(async()=>response(200,server([{id:'native',agent:{id:'999'},name:'pkg',scan:{id:'scan'}}])));const result=await f.adapter.deviceDetail(context(),{connectionId:CONNECTION,agentId:'001',category:'packages',page:{limit:20}},f.call);assert.ok(!result.ok&&result.error.code==='SCOPE_EXCEEDED');}finally{await f.dispose();}
});
test('statistics normalizes validated scope before building queries and returning the public DTO',async()=>{
 const f=await fixture();try{f.script.script.push(async()=>response(200,{...index(),aggregations:{levels:{buckets:[],sum_other_doc_count:0,doc_count_error_upper_bound:0},hours:{buckets:[]}}}));const result=take(await f.adapter.statistics(context(),{...scope,from:'2026-10-23T08:30:00+08:00',to:'2026-10-23T09:00:00+08:00'},f.call));assert.equal(result.scope.from,scope.from);assert.equal(result.scope.to,scope.to);}finally{await f.dispose();}
});
