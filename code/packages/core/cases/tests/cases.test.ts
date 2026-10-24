import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fail, ok, type EvidenceRef } from '@campussec/contracts';
import { context, scope, CASE, CONNECTION, PRINCIPAL } from '@campussec/testkit';
import { createStorage } from '@campussec/storage';
import { createCaseService } from '../index.js';
import { fixture, captureInput, runFixture, take } from './fixtures.js';
const background = (caseId: string) => ({ caseId, connectionId: CONNECTION, agentIds: ['001'], text: '维护窗口，人工提供', from: scope.from, to: scope.to, sourceLabel: '值班员', verification: 'unverified' as const });
test('real cases and versioned human context survive close/reopen; CAS preserves edits and actor authorship', async () => {
    const f = await fixture();
    try {
        const c = await f.create('需要持久化的案件');
        assert.equal(c.revision, 1);
        assert.equal(c.status, 'pending');
        const first = take(await f.service.putContext(context(), { caseId: c.id, expectedRevision: 1, context: background(c.id) }));
        assert.equal(first.authorId, PRINCIPAL);
        const conflict = await f.service.putContext(context(), { caseId: c.id, expectedRevision: 1, context: { ...background(c.id), text: '过时修改' } });
        assert.ok(!conflict.ok && conflict.error.code === 'REVISION_CONFLICT');
        const second = take(await f.service.putContext(context(), { caseId: c.id, contextId: first.id, expectedRevision: 2, context: { ...background(c.id), text: '第二版说明', verification: 'verified' } }));
        assert.equal(second.version, 2);
        await f.close();
        const storage = take(await createStorage(f.deps));
        try {
            const service = createCaseService({ ...storage, clock: f.clock, ids: f.ids }).service;
            const restored = take(await service.snapshot(context(), { caseId: c.id, evidencePage: { limit: 20 } }));
            assert.equal(restored.case.revision, 3);
            assert.equal(restored.contexts[0]?.text, '第二版说明');
            assert.equal(take(await storage.db.read(context(), tx => tx.get<{
                n: number;
            }>('SELECT COUNT(*) AS n FROM context_versions')))?.n, 2);
        }
        finally {
            await storage.close();
        }
    }
    finally {
        await f.dispose();
    }
});
test('case search escapes LIKE wildcards; pagination binds filters and identity', async () => {
    const f = await fixture();
    try {
        await f.create('100%_确认');
        await f.create('ordinary');
        await f.create('第三案');
        const result = take(await f.service.list(context(), { text: '%_', page: { limit: 20 } }));
        assert.equal(result.items.length, 1);
        const first = take(await f.service.list(context(), { page: { limit: 1 } }));
        assert.ok(first.nextCursor);
        const second = take(await f.service.list(context(), { page: { limit: 1, cursor: first.nextCursor } }));
        assert.notEqual(second.items[0]?.id, first.items[0]?.id);
        const wrong = await f.service.list(context(), { text: 'different', page: { limit: 1, cursor: first.nextCursor } });
        assert.ok(!wrong.ok && wrong.error.code === 'CURSOR_INVALID');
        const ctx = context();
        ctx.actor.principalId = CASE;
        assert.equal((await f.service.list(ctx, { page: { limit: 20 } })).ok, false);
    }
    finally {
        await f.dispose();
    }
});
test('case transitions require reasons; creation cannot attach guessed or expired evidence', async () => {
    const f = await fixture();
    try {
        const c = await f.create();
        assert.equal((await f.service.setStatus(context(), { caseId: c.id, expectedRevision: 1, status: 'resolved', reason: '关闭' })).ok, false);
        assert.equal((await f.service.setStatus(context(), { caseId: c.id, expectedRevision: 1, status: 'investigating', reason: ' ' })).ok, false);
        const running = take(await f.service.setStatus(context(), { caseId: c.id, expectedRevision: 1, status: 'investigating', reason: '人工调查' }));
        const closed = take(await f.service.setStatus(context(), { caseId: c.id, expectedRevision: running.revision, status: 'resolved', reason: '人工核实完成' }));
        assert.equal(closed.status, 'resolved');
        const reopened = take(await f.service.setStatus(context(), { caseId: c.id, expectedRevision: closed.revision, status: 'reopened', reason: '发现新材料' }));
        assert.equal(reopened.status, 'reopened');
        assert.equal((await f.service.create(context(), { title: '坏种子', scope, seedRefs: [{ evidenceId: CASE, version: 1 }] })).ok, false);
    }
    finally {
        await f.dispose();
    }
});
test('capture preserves source identity, immutable versions, retrievals and same-page conflicts', async () => {
    const f = await fixture();
    try {
        const c = await f.create(), input = captureInput(f, c.id);
        const capture = (i: typeof input) => f.db.write(context(), tx => f.atomic.captureInTx(tx, context(), i));
        const first = take(await capture(input));
        assert.equal(first.length, 1);
        assert.deepEqual(take(await capture(input)), first);
        const changed = structuredClone(input);
        changed.page.records[0]!.fields.text = '改变';
        const denied = await capture(changed);
        assert.ok(!denied.ok && denied.error.code === 'CONFLICT');
        const another = captureInput(f, c.id);
        assert.deepEqual(take(await capture(another)), first);
        const next = captureInput(f, c.id);
        next.page.records[0]!.fields.text = '新正文';
        const updated = take(await capture(next));
        assert.equal(updated[0]?.evidenceId, first[0]?.evidenceId);
        assert.equal(updated[0]?.version, 2);
        const other = captureInput(f, c.id);
        other.page.records[0]!.source.documentId = 'event-2';
        const separate = take(await capture(other));
        assert.notEqual(separate[0]?.evidenceId, first[0]?.evidenceId);
        const snapshot = take(await f.service.snapshot(context(), { caseId: c.id, evidencePage: { limit: 50 } }));
        assert.equal(snapshot.evidence.length, 3);
        assert.equal(snapshot.evidence.find(e => e.version === 1 && e.id === first[0]?.evidenceId)?.fields.text, '合成材料');
        const bad = captureInput(f, c.id);
        bad.page.records[0]!.source.documentId = undefined;
        assert.equal((await capture(bad)).ok, false);
    }
    finally {
        await f.dispose();
    }
});
test('empty final page cannot complete a query with missing prior pages; scope and page identity are checked', async () => {
    const f = await fixture();
    try {
        const c = await f.create();
        const input = captureInput(f, c.id, { pageOrdinal: 1, records: [] });
        take(await f.db.write(context(), tx => f.atomic.captureInTx(tx, context(), input)));
        const snap = take(await f.service.snapshot(context(), { caseId: c.id, evidencePage: { limit: 20 } }));
        assert.equal(snap.queries[0]?.coverage.queryCompleteness, 'partial');
        const outside = captureInput(f, c.id);
        outside.page.records[0]!.agentId = '999';
        assert.equal((await f.db.write(context(), tx => f.atomic.captureInTx(tx, context(), outside))).ok, false);
    }
    finally {
        await f.dispose();
    }
});
test('moving evidence validates both revisions and keeps run history; failed movement rolls back events', async () => {
    const f = await fixture();
    try {
        const a = await f.create('源案'), b = await f.create('目标');
        const refs = take(await f.db.write(context(), tx => f.atomic.captureInTx(tx, context(), captureInput(f, a.id))));
        const run = await runFixture(f, a.id);
        take(await f.db.write(context(), tx => f.atomic.initializeRunInTx(tx, context(), { run, seedRefs: refs, question: '为什么', capabilities: [] })));
        const before = take(await f.service.snapshot(context(), { caseId: a.id, evidencePage: { limit: 20 } }));
        const bad = await f.service.moveEvidence(context(), { sourceCaseId: a.id, targetCaseId: b.id, sourceRevision: before.case.revision, targetRevision: 99, refs, reason: '人工拆案' });
        assert.ok(!bad.ok && bad.error.code === 'REVISION_CONFLICT');
        take(await f.service.moveEvidence(context(), { sourceCaseId: a.id, targetCaseId: b.id, sourceRevision: before.case.revision, targetRevision: 1, refs, reason: '人工拆案' }));
        assert.equal(take(await f.service.snapshot(context(), { caseId: a.id, evidencePage: { limit: 20 } })).evidence.length, 0);
        assert.equal(take(await f.service.snapshot(context(), { caseId: b.id, evidencePage: { limit: 20 } })).evidence.length, 1);
        assert.ok((await f.service.evidence(context(), { caseId: a.id, ref: refs[0]! })).ok);
        const outsider = await f.create('无权案');
        const denied = await f.service.evidence(context(), { caseId: outsider.id, ref: refs[0]! });
        assert.ok(!denied.ok && denied.error.code === 'FORBIDDEN');
    }
    finally {
        await f.dispose();
    }
});
test('capture and caller failure roll back evidence, queries and case audit together', async () => {
    const f = await fixture();
    try {
        const c = await f.create();
        const result = await f.db.write(context(), tx => { const captured = f.atomic.captureInTx(tx, context(), captureInput(f, c.id)); return captured.ok ? fail('BUDGET_EXHAUSTED', '模拟调用方后续失败') : captured; });
        assert.equal(result.ok, false);
        const snap = take(await f.service.snapshot(context(), { caseId: c.id, evidencePage: { limit: 20 } }));
        assert.equal(snap.case.revision, 1);
        assert.equal(snap.evidence.length, 0);
        assert.equal(snap.queries.length, 0);
        assert.equal(take(await f.events.read(context(), { afterSeq: 0, limit: 200 })).events.length, 1);
    }
    finally {
        await f.dispose();
    }
});
test('run projections require membership; prepared is not a delivered reference; manifests are persisted and immutable', async () => {
    const f = await fixture();
    try {
        const c = await f.create();
        const refs = take(await f.db.write(context(), tx => f.atomic.captureInTx(tx, context(), captureInput(f, c.id))));
        const run = await runFixture(f, c.id);
        const frozen = take(await f.db.write(context(), tx => f.atomic.initializeRunInTx(tx, context(), { run, seedRefs: refs, question: '核实', capabilities: [] })));
        const projected = take(await f.db.write(context(), tx => f.atomic.projectInTx(tx, context(), { runId: run.id, refs, fieldNames: ['rule.level', 'text'] })));
        assert.equal(projected[0]?.state, 'prepared');
        const metadata = { initialInput: frozen, profileVersion: 'v1', mappingVersion: 'v1', steps: [] };
        take(await f.db.write(context(), tx => f.atomic.releaseInTx(tx, context(), { runId: run.id, projectionIds: [projected[0]!.id], outcome: 'released' })));
        const seal = take(await f.db.write(context(), tx => f.atomic.sealInTx(tx, context(), { runId: run.id, metadata })));
        assert.equal(seal.refs.length, 1);
        assert.deepEqual(take(await f.db.write(context(), tx => f.atomic.sealInTx(tx, context(), { runId: run.id, metadata }))), seal);
        const bad = await f.db.write(context(), tx => f.atomic.sealInTx(tx, context(), { runId: run.id, metadata: { ...metadata, mappingVersion: 'changed' } }));
        assert.ok(!bad.ok && bad.error.code === 'CONFLICT');
        const late = captureInput(f, undefined);
        assert.equal((await f.db.write(context(), tx => f.atomic.captureInTx(tx, context(), { ...late, runId: run.id }))).ok, false);
        assert.equal((await f.db.write(context(), tx => f.atomic.projectInTx(tx, context(), { runId: run.id, refs, fieldNames: ['text'] }))).ok, false);
    }
    finally {
        await f.dispose();
    }
});
test('cleanup checks current protected runs, revisions and cross-case references; caller failure restores bodies', async () => {
    const f = await fixture();
    try {
        const c = await f.create();
        const refs = take(await f.db.write(context(), tx => f.atomic.captureInTx(tx, context(), captureInput(f, c.id))));
        const run = await runFixture(f, c.id);
        take(await f.db.write(context(), tx => f.atomic.initializeRunInTx(tx, context(), { run, seedRefs: refs, question: '核实', capabilities: [] })));
        const input = { caseIds: [c.id], olderThan: '2026-10-24T00:00:00.000Z', protectedRunIds: [] };
        const plan = take(await f.db.write(context(), tx => f.atomic.previewCleanupInTx(tx, context(), input)));
        assert.equal(plan.removableVersions, 1);
        const changed = await f.db.write(context(), tx => f.atomic.applyCleanupInTx(tx, context(), { planId: plan.id, expectedPlanHash: plan.planHash, protectedRunIds: [run.id] }));
        assert.ok(!changed.ok && changed.error.code === 'CONFLICT');
        const blocked = take(await f.db.write(context(), tx => f.atomic.previewCleanupInTx(tx, context(), { ...input, protectedRunIds: [run.id] })));
        assert.equal(blocked.blockedVersions, 1);
        const rollback = await f.db.write(context(), tx => { const applied = f.atomic.applyCleanupInTx(tx, context(), { planId: plan.id, expectedPlanHash: plan.planHash, protectedRunIds: [] }); return applied.ok ? fail('INTERNAL', '模拟缓存过期失败') : applied; });
        assert.equal(rollback.ok, false);
        assert.equal(take(await f.service.evidence(context(), { caseId: c.id, ref: refs[0]! })).evidence.availability, 'available');
        const applied = take(await f.db.write(context(), tx => f.atomic.applyCleanupInTx(tx, context(), { planId: plan.id, expectedPlanHash: plan.planHash, protectedRunIds: [] })));
        assert.equal(applied.expiredVersions, 1);
        const expired = take(await f.service.evidence(context(), { caseId: c.id, ref: refs[0]! })).evidence;
        assert.equal(expired.availability, 'expired');
        assert.deepEqual(expired.fields, {});
        assert.ok(expired.contentHash);
        const newInput = captureInput(f, c.id);
        const renewed = take(await f.db.write(context(), tx => f.atomic.captureInTx(tx, context(), newInput)));
        assert.equal(renewed[0]?.version, 2);
    }
    finally {
        await f.dispose();
    }
});
test('multi-page retries return exact page refs; continuous successful pages combine coverage', async () => {
    const f = await fixture();
    try {
        const c = await f.create(), first = captureInput(f, c.id, { status: 'partial', nextCursor: 'opaque-next' });
        first.page.coverage.queryCompleteness = 'partial';
        first.page.coverage.reasons = ['more_pages'];
        const a = take(await f.db.write(context(), tx => f.atomic.captureInTx(tx, context(), first)));
        const second = captureInput(f, c.id, { queryId: first.page.queryId, pageOrdinal: 1 });
        second.query.page.cursor = 'opaque-next';
        second.page.records[0]!.source.documentId = 'second-page';
        const b = take(await f.db.write(context(), tx => f.atomic.captureInTx(tx, context(), second)));
        assert.notEqual(a[0]?.evidenceId, b[0]?.evidenceId);
        assert.deepEqual(take(await f.db.write(context(), tx => f.atomic.captureInTx(tx, context(), first))), a);
        const saved = take(await f.service.snapshot(context(), { caseId: c.id, evidencePage: { limit: 20 } }));
        assert.equal(saved.queries[0]?.coverage.queryCompleteness, 'complete');
        assert.equal(saved.queries[0]?.coverage.returned, 2);
    }
    finally {
        await f.dispose();
    }
});
test('prepared projections are excluded from sealed refs; manifests keep hashes without retaining projection bodies', async () => {
    const f = await fixture();
    try {
        const c = await f.create();
        const refs = take(await f.db.write(context(), tx => f.atomic.captureInTx(tx, context(), captureInput(f, c.id))));
        const run = await runFixture(f, c.id);
        const frozen = take(await f.db.write(context(), tx => f.atomic.initializeRunInTx(tx, context(), { run, seedRefs: refs, question: '核实', capabilities: [] })));
        take(await f.db.write(context(), tx => f.atomic.projectInTx(tx, context(), { runId: run.id, refs, fieldNames: ['text'] })));
        const sealed = take(await f.db.write(context(), tx => f.atomic.sealInTx(tx, context(), { runId: run.id, metadata: { initialInput: frozen, profileVersion: 'v1', mappingVersion: 'v1', steps: [] } })));
        assert.equal(sealed.refs.length, 0);
        const stored = take(await f.db.read(context(), tx => tx.get<{
            manifest_json: string;
        }>('SELECT manifest_json FROM case_run_manifests WHERE run_id=?', [run.id])));
        assert.equal(stored?.manifest_json.includes('合成材料'), false);
    }
    finally {
        await f.dispose();
    }
});
test('applyRun preserves a late report as history and never overwrites current input; same application is idempotent', async () => {
    const f = await fixture();
    try {
        const c = await f.create(), run = await runFixture(f, c.id);
        const initial = take(await f.db.write(context(), tx => f.atomic.initializeRunInTx(tx, context(), { run, seedRefs: [], question: '核实', capabilities: [] })));
        take(await f.db.write(context(), tx => f.atomic.sealInTx(tx, context(), { runId: run.id, metadata: { initialInput: initial, profileVersion: 'v1', mappingVersion: 'v1', steps: [] } })));
        const reportId = f.ids.next();
        take(await f.db.write(context(), tx => { tx.run('INSERT INTO report_drafts(id,case_id,run_id,version,base_revision,candidate_json,validation,review,validation_issues_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', [reportId, c.id, run.id, 1, run.baseRevision, '{}', 'needs_review', 'unreviewed', '[]', f.clock.now()]); return ok(undefined); }));
        take(await f.service.putContext(context(), { caseId: c.id, expectedRevision: run.baseRevision, context: background(c.id) }));
        const result = take(await f.db.write(context(), tx => f.atomic.applyRunInTx(tx, context(), { run, reportId })));
        assert.equal(result.applied, false);
        const snapshot = take(await f.service.snapshot(context(), { caseId: c.id, evidencePage: { limit: 20 } }));
        assert.equal(snapshot.case.latestReportId, reportId);
        assert.equal(snapshot.case.currentReportId, undefined);
        assert.equal(snapshot.case.revision, run.baseRevision + 1);
    }
    finally {
        await f.dispose();
    }
    const g = await fixture();
    try {
        const c = await g.create(), run = await runFixture(g, c.id), reportId = g.ids.next();
        const initial = take(await g.db.write(context(), tx => g.atomic.initializeRunInTx(tx, context(), { run, seedRefs: [], question: '核实', capabilities: [] })));
        take(await g.db.write(context(), tx => g.atomic.sealInTx(tx, context(), { runId: run.id, metadata: { initialInput: initial, profileVersion: 'v1', mappingVersion: 'v1', steps: [] } })));
        take(await g.db.write(context(), tx => { tx.run('INSERT INTO report_drafts(id,case_id,run_id,version,base_revision,candidate_json,validation,review,validation_issues_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', [reportId, c.id, run.id, 1, run.baseRevision, '{}', 'needs_review', 'unreviewed', '[]', g.clock.now()]); return ok(undefined); }));
        const first = take(await g.db.write(context(), tx => g.atomic.applyRunInTx(tx, context(), { run, reportId })));
        assert.equal(first.applied, true);
        assert.deepEqual(take(await g.db.write(context(), tx => g.atomic.applyRunInTx(tx, context(), { run, reportId }))), first);
    }
    finally {
        await g.dispose();
    }
});
test('global context only advances intersecting cases; cleanup protects other case references and rejects expired plans', async () => {
    const f = await fixture();
    try {
        const a = await f.create('相交一'), b = await f.create('相交二'), other = take(await f.service.create(context(), { title: '不相交', scope: { ...scope, agentIds: ['002'] }, seedRefs: [] }));
        const { caseId: _id, ...global } = background(a.id);
        take(await f.service.putContext(context(), { caseId: a.id, expectedRevision: 1, context: global }));
        assert.equal(take(await f.service.snapshot(context(), { caseId: b.id, evidencePage: { limit: 20 } })).case.revision, 2);
        assert.equal(take(await f.service.snapshot(context(), { caseId: other.id, evidencePage: { limit: 20 } })).case.revision, 1);
        const refs = take(await f.db.write(context(), tx => f.atomic.captureInTx(tx, context(), captureInput(f, a.id))));
        take(await f.service.create(context(), { title: '共享材料', scope, seedRefs: refs }));
        const plan = take(await f.db.write(context(), tx => f.atomic.previewCleanupInTx(tx, context(), { caseIds: [a.id], olderThan: '2026-10-24T00:00:00.000Z', protectedRunIds: [] })));
        assert.equal(plan.blockedVersions, 1);
        f.clock.advance(600001);
        const expired = await f.db.write(context(), tx => f.atomic.applyCleanupInTx(tx, context(), { planId: plan.id, expectedPlanHash: plan.planHash, protectedRunIds: [] }));
        assert.ok(!expired.ok && expired.error.code === 'EXPIRED');
        const changed = context();
        changed.actor.identityEpoch = 2;
        assert.equal((await f.db.write(context(), tx => f.atomic.getInTx(tx, changed, a.id))).ok, false);
    }
    finally {
        await f.dispose();
    }
});

test('editing a global context advances both its former scope and its new scope',async()=>{
 const f=await fixture();try{
  const a=await f.create('原范围'),b=take(await f.service.create(context(),{title:'新范围',scope:{...scope,agentIds:['002']},seedRefs:[]}));
  const {caseId:_id,...global}=background(a.id);
  const original=take(await f.service.putContext(context(),{caseId:a.id,expectedRevision:1,context:global}));
  take(await f.service.putContext(context(),{caseId:b.id,expectedRevision:1,contextId:original.id,context:{...global,agentIds:['002']}}));
  const old=take(await f.service.snapshot(context(),{caseId:a.id,evidencePage:{limit:20}})),next=take(await f.service.snapshot(context(),{caseId:b.id,evidencePage:{limit:20}}));
  assert.equal(old.case.revision,3);assert.equal(old.contexts.length,0);assert.equal(next.case.revision,2);assert.equal(next.contexts[0]?.version,2);
 }finally{await f.dispose();}
});
test('public case operations use normalized UTC and deduplicated scope values after schema validation',async()=>{
 const f=await fixture();try{
  const offsetScope={...scope,agentIds:['001','001'],from:'2026-10-23T08:30:00+08:00',to:'2026-10-23T09:00:00+08:00'};
  const c=take(await f.service.create(context(),{title:'偏移时间',scope:offsetScope,seedRefs:[]}));
  assert.equal(c.scope.from,scope.from);assert.deepEqual(c.scope.agentIds,['001']);
  const result=take(await f.service.putContext(context(),{caseId:c.id,expectedRevision:1,context:{...background(c.id),from:offsetScope.from,to:offsetScope.to}}));assert.equal(result.from,scope.from);
 }finally{await f.dispose();}
});
test('expanding an existing global context cannot overflow another case context limit',async()=>{
 const f=await fixture();try{
  const a=await f.create('原范围'),b=take(await f.service.create(context(),{title:'已有一百条背景',scope:{...scope,agentIds:['002']},seedRefs:[]}));
  const {caseId:_id,...global}=background(a.id);const original=take(await f.service.putContext(context(),{caseId:a.id,expectedRevision:1,context:global}));
  for(let i=0;i<100;i++)take(await f.service.putContext(context(),{caseId:b.id,expectedRevision:i+1,context:{...background(b.id),agentIds:['002'],text:`背景 ${i}`}}));
  const result=await f.service.putContext(context(),{caseId:b.id,expectedRevision:101,contextId:original.id,context:{...global,agentIds:['001','002']}});
  assert.ok(!result.ok&&result.error.code==='SCOPE_EXCEEDED');
  const saved=take(await f.service.snapshot(context(),{caseId:b.id,evidencePage:{limit:20}}));assert.equal(saved.contexts.length,100);assert.equal(saved.case.revision,101);
 }finally{await f.dispose();}
});
