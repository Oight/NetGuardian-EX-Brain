import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, type HttpPort, type TriggerPolicy } from '@campussec/contracts';
import { composedFixture, take } from '../support/composed.js';
test('production alert poll + real Wazuh mapping + S06 capture + S07 atomic admission preserve seeds and daily automatic reservation', async () => {
    let document = 0, observed = '2026-10-23T00:59:59.000Z';
    const http: HttpPort = { request: async (req) => {
            if (req.url.includes('/security/user/authenticate'))
                return ok({ status: 200, headers: {}, bodyText: 'synthetic.payload.signature' });
            if (req.url.includes('/agents'))
                return ok({ status: 200, headers: {}, bodyText: JSON.stringify({ error: 0, data: { affected_items: [{ id: '001', name: 'synthetic-agent', status: 'active' }], total_affected_items: 1, total_failed_items: 0 } }) });
            assert.match(req.url, /https:\/\/synthetic-indexer\.invalid\//);
            const hits = [{ _index: 'wazuh-alerts-synthetic', _id: 'synthetic-' + document, _source: { timestamp: observed, agent: { id: '001' }, rule: { id: '100', level: 7 } } }];
            return ok({ status: 200, headers: {}, bodyText: JSON.stringify({ timed_out: false, _shards: { failed: 0 }, hits: { total: { value: 1, relation: 'eq' }, hits } }) });
        } };
    const f = await composedFixture(undefined, undefined, { http });
    try {
        const connectionId = f.request('config').connectionId;
        const configured = await f.invoke('connections.configure', { id: connectionId, expectedGeneration: 1, displayName: 'Synthetic', platformInstanceId: f.ctx.actor.spaceId, alertsPattern: 'wazuh-alerts-*', mappingVersion: 'wazuh-alerts-v1', indexerBaseUrl: 'https://synthetic-indexer.invalid/', serverBaseUrl: 'https://synthetic-server.invalid/' }) as {
            generation: number;
        };
        const first = await f.invoke('connections.setCredential', { connectionId, endpoint: 'indexer', username: 'synthetic', password: 'synthetic-test-only', persist: false, expectedGeneration: configured.generation }) as {
            generation: number;
        };
        await f.invoke('connections.setCredential', { connectionId, endpoint: 'server', username: 'synthetic', password: 'synthetic-test-only', persist: false, expectedGeneration: first.generation });
        take(await f.runtime.services.alerts.pollOnce(f.system, connectionId));
        const policy: TriggerPolicy = { id: f.ids.next(), connectionId, enabled: true, revision: 1, epoch: 1, agentIds: ['001'], filter: { minLevel: 5 }, enabledAfterReceiveSeq: 0, dailyAttemptLimit: 10, timeZone: 'Asia/Shanghai' };
        take(await f.runtime.services.alerts.setPolicy(f.ctx, { expectedRevision: 0, policy }));
        document++;
        f.clock.advance(10000);
        observed = new Date(Date.parse(f.clock.now()) - 1000).toISOString();
        take(await f.runtime.services.alerts.pollOnce(f.system, connectionId));
        f.clock.advance(10001);
        assert.equal(take(await f.runtime.services.alerts.flushCandidates(f.system)), 1);
        const queued = take(await f.runtime.storage.db.read(f.system, tx => tx.get<{
            request_id: string;
        }>("SELECT request_id FROM jobs WHERE origin='alert_auto'")));
        assert.ok(queued);
        const request = take(await f.runtime.services.requests.status(f.ctx, queued.request_id));
        assert.equal(request.request.seedRefs.length, 1);
        assert.equal(request.job?.state, 'queued');
        take(await f.runtime.services.requests.tick(f.system));
        const failed = take(await f.runtime.services.requests.status(f.ctx, queued.request_id));
        assert.equal(failed.job?.state, 'failed');
        assert.ok(failed.job.runId);
        assert.equal(failed.budget?.distinctEvents, 1);
        const result = take(await f.runtime.services.delivery.getResult(f.ctx, { requestId: queued.request_id }));
        assert.equal(result.error?.code, 'CAPABILITY_UNAVAILABLE');
        const counts = take(await f.runtime.storage.db.read(f.system, tx => ({ quota: tx.get<{
                n: number;
            }>("SELECT COUNT(*) AS n FROM quota_ledger WHERE kind='automatic_attempt'")!.n, inbox: tx.get<{
                n: number;
            }>('SELECT COUNT(*) AS n FROM alerts_inbox')!.n })));
        assert.equal(counts.quota, 1);
        assert.equal(counts.inbox, 2);
        assert.equal(take(await f.runtime.services.alerts.flushCandidates(f.system)), 0);
    }
    finally {
        await f.close();
    }
});
