import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, fail, ok, type WriteTx } from '@campussec/contracts';
import { CASE, CONNECTION, PRINCIPAL, context, scope } from '@campussec/testkit';
import { createRunBudget } from '@campussec/core/requests/budgets';
import { createStorage } from '@campussec/storage';
import { seedCase, storageFixture } from '../../../../tests/support/storage.js';

async function setup() {
  const fixture = await storageFixture();
  const expires = '2026-10-23T01:05:00.000Z';
  const saved = await fixture.db.write(context(), tx => {
    seedCase(tx);
    tx.run('INSERT INTO investigation_requests(id,origin,state,principal_id,connection_id,question,requested_scope_json,effective_scope_json,seed_refs_json,case_id,job_id,missing_fields_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [CASE, 'client_user', 'accepted', PRINCIPAL, CONNECTION, '合成预算', canonicalJson(scope), canonicalJson(scope), '[]', CASE, CASE, '[]', scope.to, expires]);
    tx.run('INSERT INTO jobs(id,request_id,case_id,run_id,origin,state,revision,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', [CASE, CASE, CASE, CASE, 'client_user', 'running', 1, expires, scope.to, scope.to]);
    tx.run('INSERT INTO analysis_runs(id,job_id,case_id,base_revision,scope_json,connection_generation,identity_epoch,profile_version,tool_epoch,expires_at,initial_input_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [CASE, CASE, CASE, 1, canonicalJson(scope), 1, 1, 'v1', 1, expires, canonicalJson({ question: '合成预算', scope, seedRefs: [], contexts: [], capabilities: [] })]);
    return ok(undefined);
  }); assert.ok(saved.ok);
  return { ...fixture, ...createRunBudget({ db: fixture.db, clock: fixture.clock, ids: fixture.ids }) };
}
const count = async (f: Awaited<ReturnType<typeof setup>>, table: string) => {
  const read = await f.db.read(context(), tx => tx.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)!.count);
  assert.ok(read.ok); return read.value;
};
test('last-tool/read reservations serialize; failures never refund prior committed quota', async () => {
  const f = await setup(); try {
    const results = await Promise.all(Array.from({ length: 11 }, () => f.db.write(context(), tx => f.atomic.reserveToolInTx(tx, context(), { runId: CASE, toolName: 'query', isRead: true }))));
    assert.equal(results.filter(r => r.ok).length, 10); assert.equal(await count(f, 'tool_reservations'), 10);
    for (let i = 0; i < 2; i++) assert.ok((await f.db.write(context(), tx => f.atomic.reserveToolInTx(tx, context(), { runId: CASE, toolName: 'step', isRead: false }))).ok);
    const exhausted = await f.db.write(context(), tx => f.atomic.reserveToolInTx(tx, context(), { runId: CASE, toolName: 'step', isRead: false }));
    assert.equal(exhausted.ok, false); assert.equal(await count(f, 'tool_reservations'), 12);
  } finally { await f.dispose(); }
});
test('platform attempts remain spent after failure; cancellation and old epochs stop late network work', async () => {
  const f = await setup(); try {
    const reserved = await f.db.write(context(), tx => f.atomic.reserveToolInTx(tx, context(), { runId: CASE, toolName: 'query', isRead: true })); assert.ok(reserved.ok);
    const attempts = await Promise.all(Array.from({ length: 21 }, () => f.budget.reservePlatformAttempt(context(), reserved.value.id)));
    assert.equal(attempts.filter(r => r.ok).length, 20); assert.equal(await count(f, 'platform_attempts'), 20);
    assert.ok((await f.db.write(context(), tx => { tx.run('UPDATE analysis_runs SET tool_epoch=2 WHERE id=?', [CASE]); return ok(undefined); })).ok);
    const old = await f.budget.reservePlatformAttempt(context(), reserved.value.id); assert.ok(!old.ok); assert.equal(old.error.code, 'IDENTITY_CHANGED');
    await f.db.write(context(), tx => { tx.run("UPDATE jobs SET state='cancel_requested' WHERE id=?", [CASE]); return ok(undefined); });
    const cancelled = await f.budget.assertRunOpen(context(), CASE); assert.ok(!cancelled.ok); assert.equal(cancelled.error.code, 'CANCELLED');
    assert.equal(await count(f, 'platform_attempts'), 20);
  } finally { await f.dispose(); }
});
test('source identities deduplicate at 300 and participate in the caller transaction rollback', async () => {
  const f = await setup(); try {
    const keys = Array.from({ length: 300 }, (_, i) => `synthetic:${i}`);
    assert.ok((await f.db.write(context(), tx => f.atomic.recordEventsInTx(tx, context(), { runId: CASE, sourceKeys: [...keys, keys[0]!] }))).ok);
    assert.equal(await count(f, 'run_event_keys'), 300);
    assert.ok((await f.db.write(context(), tx => f.atomic.recordEventsInTx(tx, context(), { runId: CASE, sourceKeys: keys }))).ok);
    assert.equal((await f.db.write(context(), tx => f.atomic.recordEventsInTx(tx, context(), { runId: CASE, sourceKeys: ['synthetic:301'] }))).ok, false);
    assert.equal(await count(f, 'run_event_keys'), 300);
  } finally { await f.dispose(); }
  const rollback = await setup(); try {
    const result = await rollback.db.write(context(), tx => { const stored = rollback.atomic.recordEventsInTx(tx, context(), { runId: CASE, sourceKeys: ['synthetic:rollback'] }); if (!stored.ok) return stored; return fail('CONFLICT', '合成后续证据保存失败'); });
    assert.equal(result.ok, false); assert.equal(await count(rollback, 'run_event_keys'), 0);
    const result2 = await rollback.db.write(context(), tx => { const stored = rollback.atomic.reserveToolInTx(tx, context(), { runId: CASE, toolName: 'query', isRead: true }); if (!stored.ok) return stored; return fail('CONFLICT', '合成同事务失败'); });
    assert.equal(result2.ok, false); assert.equal(await count(rollback, 'tool_reservations'), 0);
  } finally { await rollback.dispose(); }
});
test('fences reject expired, recovery-held, wrong identity and changed connection generations', async () => {
  const f = await setup(); try {
    assert.ok((await f.budget.assertRunOpen(context(), CASE)).ok);
    const wrongRun = context(); wrongRun.actor.role = 'evidence';
    assert.equal((await f.budget.assertRunOpen(wrongRun, CASE)).ok, false);
    await f.db.write(context(), tx => { tx.run('UPDATE connections SET generation=2 WHERE id=?', [CONNECTION]); return ok(undefined); });
    const changed = await f.budget.assertRunOpen(context(), CASE); assert.ok(!changed.ok); assert.equal(changed.error.code, 'IDENTITY_CHANGED');
    await f.db.write(context(), tx => { tx.run('UPDATE connections SET generation=1 WHERE id=?', [CONNECTION]); tx.run('UPDATE jobs SET recovery_hold=1 WHERE id=?', [CASE]); return ok(undefined); });
    const held = await f.budget.assertRunOpen(context(), CASE); assert.ok(!held.ok); assert.equal(held.error.code, 'UNCERTAIN');
    await f.db.write(context(), tx => { tx.run('UPDATE jobs SET recovery_hold=0 WHERE id=?', [CASE]); return ok(undefined); });
    f.clock.advance(300000);
    const expired = await f.budget.assertRunOpen(context(), CASE); assert.ok(!expired.ok); assert.equal(expired.error.code, 'EXPIRED');
    const wrongEpoch = context(); wrongEpoch.actor.identityEpoch = 2;
    assert.equal((await f.budget.assertRunOpen(wrongEpoch, CASE)).ok, false);
  } finally { await f.dispose(); }
});


test('committed tool, platform and event budgets survive database reopen without refund', async () => {
  const f = await setup();
  try {
    const reservation = await f.db.write(context(), tx => f.atomic.reserveToolInTx(tx, context(), { runId: CASE, toolName: 'query', isRead: true })); assert.ok(reservation.ok);
    assert.ok((await f.budget.reservePlatformAttempt(context(), reservation.value.id)).ok);
    assert.ok((await f.db.write(context(), tx => f.atomic.recordEventsInTx(tx, context(), { runId: CASE, sourceKeys: ['synthetic:persisted'] }))).ok);
    await f.close();
    const reopened = await createStorage(f.deps); assert.ok(reopened.ok);
    try {
      const budgets = createRunBudget({ db: reopened.value.db, clock: f.clock, ids: f.ids });
      assert.ok((await budgets.budget.reservePlatformAttempt(context(), reservation.value.id)).ok);
      const rows = await reopened.value.db.read(context(), tx => ({ tools: tx.get<{ n: number }>('SELECT COUNT(*) AS n FROM tool_reservations')!.n, attempts: tx.get<{ n: number }>('SELECT COUNT(*) AS n FROM platform_attempts')!.n, events: tx.get<{ n: number }>('SELECT COUNT(*) AS n FROM run_event_keys')!.n }));
      assert.ok(rows.ok); assert.deepEqual(rows.value, { tools: 1, attempts: 2, events: 1 });
    } finally { await reopened.value.close(); }
  } finally { await f.dispose(); }
});
