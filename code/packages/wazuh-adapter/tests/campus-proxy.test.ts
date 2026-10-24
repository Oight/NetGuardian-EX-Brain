import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCampusProxy } from '../src/campus-proxy.js';
const at = Date.parse('2026-10-23T01:00:00.000Z');
const event = {
    index: 'wazuh-alerts-4.x-synthetic', documentId: 'native-1', time: at - 1000, agentId: '001', agentName: '合成设备', ruleId: '100', level: 7, groups: ['test'], title: '合成告警'
};
function fixture(result: unknown, status = 200) {
    const calls: {
        url: URL;
        init?: RequestInit;
    }[] = [];
    const proxy = createCampusProxy({ fetch: (async (url, init) => {
            calls.push({ url: new URL(String(url)), init });
            return new Response(JSON.stringify(result), { status });
        }) as typeof fetch });
    const request = (body: unknown, signal = new AbortController().signal) => proxy.request({
        kind: 'indexer', segments: ['wazuh-alerts-4.x-*', '_search'], parameters: {}, body, signal
    });
    return {
        proxy, calls, request
    };
}
const query = { size: 50, query: { bool: { filter: [{ terms: { 'agent.id': ['001'] } }, { range: { timestamp: { gte: new Date(at - 60000).toISOString(), lt: new Date(at).toISOString() } } }] } } };
test('campus proxy preserves native index/id, exact half-open scope, required header and explicit partial coverage', async () => {
    const f = fixture({ status: 'ok', data: { items: [event], total: { value: 1, relation: 'eq' } } });
    const r = await f.request(query);
    assert.ok(r.ok);
    assert.equal(f.calls[0]!.url.searchParams.get('to'), new Date(at - 1).toISOString());
    assert.equal(new Headers(f.calls[0]!.init?.headers).get('X-Campus-SOC'), '1');
    assert.equal(f.calls[0]!.init?.redirect, 'error');
    const hit = (r.value.hits as {
        hits: {
            _index: string;
            _id: string;
        }[];
    }).hits[0]!;
    assert.equal(hit._id, 'native-1');
    assert.equal(hit._index, event.index);
    assert.ok(Array.isArray(r.value._campusWarnings));
});
test('proxy rejects scope expansion, upper boundary, missing native identity and unsupported queries', async () => {
    for (const bad of [{ ...event, agentId: '002' }, { ...event, time: at }, { ...event, documentId: null }]) {
        const f = fixture({ status: 'ok', data: { items: [bad], total: { value: 1, relation: 'eq' } } });
        const r = await f.request(query);
        assert.ok(!r.ok && r.error.code === 'SCOPE_EXCEEDED');
    }
    const f = fixture({});
    const multi = structuredClone(query);
    multi.query.bool.filter[0] = { terms: { 'agent.id': ['001', '002'] } };
    assert.equal((await f.request(multi)).ok, false);
    assert.equal(f.calls.length, 0);
    assert.throws(() => createCampusProxy({ baseUrl: 'http://10.0.0.1:4173' }));
    assert.throws(() => createCampusProxy({ baseUrl: 'https://127.0.0.1:4173' }));
});
test('proxy maps denied/auth/config/malformed responses without copying upstream secrets or reporting zero', async () => {
    for (const [status, body, code] of [[403, { status: 'error', message: 'secret' }, 'UPSTREAM_DENIED'], [401, { status: 'error' }, 'UPSTREAM_AUTH'], [503, { status: 'error', code: 'CONFIG' }, 'CAPABILITY_UNAVAILABLE'], [200, { status: 'ok', data: {} }, 'PARTIAL_RESULT']] as const) {
        const f = fixture(body, status), r = await f.request(query);
        assert.ok(!r.ok && r.error.code === code);
        assert.ok(!JSON.stringify(r).includes('secret'));
    }
});
test('proxy performs a real read for a capability probe and keeps unavailable statistics explicit', async () => {
    const f = fixture({ status: 'ok', data: { items: [], total: { value: 0, relation: 'eq' } } });
    assert.ok((await f.request({ size: 0, query: { match_none: {} } })).ok);
    assert.equal(f.calls.length, 1);
    const s = fixture({ alerts: { status: 'error', code: 'AUTH' } });
    const r = await s.request({ ...query, aggs: {} });
    assert.ok(!r.ok && r.error.code === 'UPSTREAM_UNAVAILABLE');
});
test('proxy filters rule IDs within the bounded native page without calling it a complete result', async () => {
    const f = fixture({ status: 'ok', data: { items: [event, {
                    ...event, documentId: 'native-2', ruleId: '200'
                }], total: { value: 1000, relation: 'gte' } } });
    const q = structuredClone(query);
    q.query.bool.filter.push({ terms: { 'rule.id': ['100'] } } as never);
    const r = await f.request(q);
    assert.ok(r.ok);
    assert.deepEqual((r.value.hits as {
        total: unknown;
    }).total, { value: 1, relation: 'gte' });
});
