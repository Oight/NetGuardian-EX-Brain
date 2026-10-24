import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fail, ok } from '@campussec/contracts';
import { context, createScriptedRequestAtomic, foundationSamples } from '@campussec/testkit';
import { storageFixture } from '../support/storage.js';

test('scripted InTx failure after an actual SQL write rolls back in real storage', async () => {
  const fixture = await storageFixture(); const requests = createScriptedRequestAtomic();
  try {
    requests.createAutoInTx.push(({ tx }) => { tx.run('INSERT INTO runtime_settings(key,revision,value_json) VALUES(?,?,?)', ['synthetic-rollback', 1, '{}']); return fail('BUDGET_EXHAUSTED', '合成预算拒绝'); });
    const result = await fixture.db.write(context(), tx => requests.port.createAutoInTx(tx, context(), foundationSamples().autoCandidate));
    assert.equal(result.ok, false);
    const found = await fixture.db.read(context(), tx => tx.get('SELECT key FROM runtime_settings WHERE key=?', ['synthetic-rollback']));
    assert.ok(found.ok); assert.equal(found.value, undefined);
    const retry = await fixture.db.write(context(), tx => { tx.run('INSERT INTO runtime_settings(key,revision,value_json) VALUES(?,?,?)', ['synthetic-rollback', 1, '{}']); return ok(undefined); });
    assert.ok(retry.ok);
  } finally { await fixture.dispose(); }
});
