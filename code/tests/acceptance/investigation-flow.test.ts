import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChannelAuthenticator, channelSecretPurpose } from '@campussec/mcp-server/channels';
import { fail, ok, type CallContext, type ExecutionSnapshot, type EvidenceToolEnvelope, type PreparedProfile, type AnalysisRun, type JsonObject, type ReportCandidate, type HttpPort } from '@campussec/contracts';
import type { ExecutionWire } from '@campussec/teleagent-bridge/execution';
import { composedFixture, take } from '../support/composed.js';
for (const changeConnection of [false, true])
    test('production scheduler + real HTTP evidence/report/review/retention; connection changed=' + changeConnection, async () => {
        let f: Awaited<ReturnType<typeof composedFixture>>, run: AnalysisRun, profile: PreparedProfile, channelId = '', token = '', binding = '', completed = false, queryCount = 0;
        const at = '2026-10-23T00:45:00.000Z';
        const http: HttpPort = { request: async (req) => {
                assert.match(req.url, /^https:\/\/synthetic-indexer\.invalid\//);
                const body = JSON.parse(req.bodyText ?? '{}');
                if (body.size === 0)
                    return ok({ status: 200, headers: {}, bodyText: JSON.stringify({ timed_out: false, _shards: { failed: 0 }, hits: { total: { value: 0, relation: 'eq' }, hits: [] } }) });
                assert.ok(body.query.bool.filter);
                queryCount++;
                const hits = [{ _index: 'wazuh-alerts-synthetic', _id: 'synthetic-event-' + queryCount, _source: { timestamp: at, agent: { id: '001', name: 'synthetic' }, rule: { id: '100', level: 7, description: queryCount === 1 ? '查到待核对线索' : '进一步核对得到关联材料' } } }];
                return ok({ status: 200, headers: {}, bodyText: JSON.stringify({ timed_out: false, _shards: { failed: 0 }, hits: { total: { value: 1, relation: 'eq' }, hits } }) });
            } };
        const observation = (phase: ExecutionSnapshot['phase']): ExecutionSnapshot => ({ runId: run.id, phase, verification: 'verified', sessionId: 'synthetic-dedicated-session', userMessageId: 'synthetic-input', ...(phase === 'completed' ? { resultMessageId: 'synthetic-result', finishReason: 'stop', usage: { inputTokens: 120, outputTokens: 80, estimated: false, costKnown: false } } : {}), observedAt: f.clock.now() });
        const wire: ExecutionWire = { start: async (ctx, input) => {
                run = input.run;
                profile = input.profile;
                channelId = input.channel.id;
                binding = f.ids.next();
                take(await f.runtime.services.channels.bindChannel(ctx, { channelId, runId: run.id, trustedSessionBindingId: binding }));
                token = take(await f.runtime.secrets.use(input.channel.secretRef, channelSecretPurpose(channelId), async (bytes) => Buffer.from(bytes).toString('utf8')));
                return ok(observation('running'));
            }, inspect: async () => ok(observation(completed ? 'completed' : 'running')), abort: async () => ok(observation('cancelled')) };
        const authenticate = async () => {
            if (!run)
                return fail('UNAUTHENTICATED', 'synthetic run not started');
            return createChannelAuthenticator({ db: f.runtime.storage.db, secrets: f.runtime.secrets, clock: f.clock }).authenticate(f.system, { channelId, token: Buffer.from(token), trustedSessionBindingId: binding });
        };
        f = await composedFixture(wire, undefined, { http, gatewayAuthentication: { authenticate: async (req) => {
                    if (req.headers.authorization !== `Bearer ${token}`)
                        return fail('UNAUTHENTICATED', 'synthetic credential mismatch');
                    const auth = await authenticate();
                    return auth.ok ? ok({ ...auth.value, allowedTools: profile.allowedTools }) : auth;
                }, recheck: async () => { const auth = await authenticate(); return auth.ok ? ok(undefined) : auth; } } });
        try {
            const connectionId = f.request('configuration').connectionId;
            const config = await f.invoke('connections.configure', { id: connectionId, expectedGeneration: 1, displayName: 'Synthetic only', platformInstanceId: f.ctx.actor.spaceId, alertsPattern: 'wazuh-alerts-*', mappingVersion: 'wazuh-alerts-v1', indexerBaseUrl: 'https://synthetic-indexer.invalid/' }) as {
                generation: number;
            };
            await f.invoke('connections.setCredential', { connectionId, endpoint: 'indexer', username: 'synthetic', password: 'synthetic-test-only', persist: false, expectedGeneration: config.generation });
            await f.invoke('connections.capabilities', { connectionId, refresh: true });
            const accepted = take(await f.runtime.services.requests.create(f.ctx, f.request('real-composition')));
            take(await f.runtime.services.requests.tick(f.system));
            assert.equal(take(await f.runtime.services.requests.status(f.ctx, accepted.request.id)).job?.state, 'running');
            const endpoint = take(await f.runtime.services.gateway.start(f.system)).endpoint!;
            async function tool(callId: string, name: string, args: JsonObject = {}) {
                const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`, 'MCP-Protocol-Version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: callId, method: 'tools/call', params: { name, arguments: args } }) });
                const rpc = await res.json();
                assert.equal(res.status, 200, JSON.stringify(rpc));
                assert.equal(rpc.result.isError, false, JSON.stringify(rpc));
                return JSON.parse(rpc.result.content[0].text);
            }
            const initial = await tool('context', 'get_case_context');
            assert.equal(initial.context.question, '检验实际调度');
            assert.equal(initial.records.length, 0);
            const first = await tool('query-1', 'search_related_alerts', { agentIds: ['001'], purpose: '从初始上下文确定需要核查的线索' }) as EvidenceToolEnvelope;
            assert.equal(first.records.length, 1);
            // The second query is constructed from the first tool reply, rather than a canned full answer in the initial prompt.
            const second = await tool('query-2', 'search_related_alerts', { agentIds: ['001'], filter: { ruleIds: [String(first.records[0]!.content['rule.id'])] }, purpose: '根据上一次返回的规则查询关联材料' }) as EvidenceToolEnvelope;
            assert.equal(second.records.length, 1);
            assert.equal(queryCount, 2);
            const candidate: ReportCandidate = { caseId: run!.caseId, runId: run!.id, question: '检验实际调度', facts: [{ text: '两次查询分别取得本轮实际返回的合成材料', evidenceRefs: [first.records[0]!.ref, second.records[0]!.ref], queryIds: [first.queryId!, second.queryId!], contextRefs: [] }], analysis: [], conflicts: [], gaps: ['Indexer 分页完整性与资产侧采集覆盖未验收'], classification: 'needs_investigation', stopReason: 'answered_with_limits', followups: [{ question: '人工核对材料', suggestedAction: '核实后决定处置' }] };
            const proposal = await tool('proposal', 'propose_report', candidate as unknown as JsonObject);
            assert.equal(proposal.status, 'ok');
            if (changeConnection) {
                const generation = take(await f.runtime.storage.db.read(f.system, tx => tx.get<{
                    generation: number;
                }>('SELECT generation FROM connections WHERE id=?', [connectionId])!.generation));
                await f.invoke('connections.configure', { id: connectionId, expectedGeneration: generation, mappingVersion: 'changed-after-evidence', displayName: 'Synthetic changed', platformInstanceId: f.ctx.actor.spaceId, alertsPattern: 'wazuh-alerts-*' });
            }
            completed = true;
            take(await f.runtime.services.requests.tick(f.system));
            const status = take(await f.runtime.services.requests.status(f.ctx, accepted.request.id));
            assert.equal(status.job?.state, changeConnection ? 'needs_review' : 'succeeded');
            const result = take(await f.runtime.services.delivery.getResult(f.ctx, { requestId: accepted.request.id }));
            assert.equal(result.runId, run!.id);
            assert.equal(result.terminalState, changeConnection ? 'needs_review' : 'succeeded');
            assert.equal(result.review, 'unreviewed');
            const counts = take(await f.runtime.storage.db.read(f.system, tx => ({ reports: tx.get<{
                    n: number;
                }>('SELECT COUNT(*) AS n FROM report_drafts')!.n, manifests: tx.get<{
                    n: number;
                }>('SELECT COUNT(*) AS n FROM case_run_manifests')!.n, attempts: tx.get<{
                    n: number;
                }>("SELECT COUNT(*) AS n FROM execution_attempts WHERE operation='start'")!.n, usage: tx.get<{
                    usage_json: string;
                }>("SELECT usage_json FROM quota_ledger WHERE kind='token_usage'")!.usage_json })));
            assert.equal(counts.reports, 1);
            assert.equal(counts.manifests, 1);
            const manifest = take(await f.runtime.storage.db.read(f.system, tx => tx.get<{
                manifest_json: string;
            }>('SELECT manifest_json FROM case_run_manifests')!.manifest_json));
            assert.equal(JSON.parse(manifest).metadata.mappingVersion, 'wazuh-alerts-v1');
            assert.equal(counts.attempts, 1);
            assert.equal(JSON.parse(counts.usage).known, true);
            take(await f.runtime.services.requests.tick(f.system));
            assert.equal(queryCount, 2);
            const revision = async () => take(await f.runtime.storage.db.read(f.system, tx => tx.get<{
                revision: number;
            }>('SELECT revision FROM cases WHERE id=?', [run!.caseId])!.revision));
            const reviewed = take(await f.runtime.services.reports.review(f.ctx, { reportId: result.reportId!, expectedCaseRevision: await revision(), disposition: 'accepted', humanConclusion: 'unknown', note: '合成材料，仅核对流程' }));
            assert.equal(take(await f.runtime.services.delivery.getResult(f.ctx, { requestId: accepted.request.id })).resultVersion, 1);
            const publish = { requestId: accepted.request.id, reportId: reviewed.id, expectedCaseRevision: await revision(), expectedResultVersion: 1 };
            const published = take(await f.runtime.services.publication.publishReview(f.ctx, publish));
            assert.equal(published.resultVersion, 2);
            assert.equal(published.review, 'accepted');
            assert.equal(take(await f.runtime.services.publication.publishReview(f.ctx, publish)).resultVersion, 2);
            assert.equal(queryCount, 2);
            f.clock.advance(1000);
            const plan = take(await f.runtime.services.retention.preview(f.ctx, { caseIds: [run!.caseId], olderThan: f.clock.now() }));
            assert.equal(plan.removableVersions, 2);
            const injection = new DatabaseSync(f.databasePath);
            try {
                injection.exec("CREATE TRIGGER synthetic_expiry_failure BEFORE UPDATE OF state ON mcp_calls WHEN NEW.state='expired' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
            }
            finally {
                injection.close();
            }
            assert.equal((await f.runtime.services.retention.apply(f.ctx, { planId: plan.id, expectedPlanHash: plan.planHash })).ok, false);
            assert.equal(take(await f.runtime.storage.db.read(f.system, tx => tx.get<{
                n: number;
            }>("SELECT COUNT(*) AS n FROM evidence_versions WHERE availability='expired'")!.n)), 0);
            const cleanup = new DatabaseSync(f.databasePath);
            try {
                cleanup.exec('DROP TRIGGER synthetic_expiry_failure');
            }
            finally {
                cleanup.close();
            }
            const cleaned = take(await f.runtime.services.retention.apply(f.ctx, { planId: plan.id, expectedPlanHash: plan.planHash }));
            assert.equal(cleaned.expiredVersions, 2);
            assert.equal(take(await f.runtime.storage.db.read(f.system, tx => tx.get<{
                n: number;
            }>("SELECT COUNT(*) AS n FROM mcp_calls WHERE state='expired'")!.n)), 2);
            assert.equal(queryCount, 2);
        }
        finally {
            token = '';
            await f.close();
        }
    });
