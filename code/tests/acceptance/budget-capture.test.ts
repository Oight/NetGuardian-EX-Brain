import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok } from '@campussec/contracts';
import { context } from '@campussec/testkit';
import { createRunBudget } from '@campussec/core/requests/budgets';
import { fixture, runFixture, captureInput, take } from '../../packages/core/cases/tests/fixtures.js';
test('S07 event reservation and real S06 capture roll back together at the 301st event', async () => {
    const f = await fixture();
    try {
        const c = await f.create(), run = await runFixture(f, c.id), budget = createRunBudget(f);
        take(await f.db.write(context(), tx => budget.atomic.recordEventsInTx(tx, context(), { runId: run.id, sourceKeys: Array.from({ length: 299 }, (_, i) => `synthetic:${i}`) })));
        const input = captureInput(f, undefined);
        const result = await f.db.write(context(), tx => {
            const reserved = budget.atomic.recordEventsInTx(tx, context(), { runId: run.id, sourceKeys: ['synthetic:300'] });
            if (!reserved.ok)
                return reserved;
            const captured = f.atomic.captureInTx(tx, context(), { ...input, runId: run.id });
            if (!captured.ok)
                return captured;
            return budget.atomic.recordEventsInTx(tx, context(), { runId: run.id, sourceKeys: ['synthetic:301'] });
        });
        assert.ok(!result.ok && result.error.code === 'BUDGET_EXHAUSTED');
        const rows = take(await f.db.read(context(), tx => ({ keys: tx.get<{
                n: number;
            }>('SELECT COUNT(*) AS n FROM run_event_keys WHERE run_id=?', [run.id])!.n, evidence: tx.get<{
                n: number;
            }>('SELECT COUNT(*) AS n FROM evidence_versions')!.n, pages: tx.get<{
                n: number;
            }>('SELECT COUNT(*) AS n FROM query_pages')!.n })));
        assert.deepEqual(rows, { keys: 299, evidence: 0, pages: 0 });
    }
    finally {
        await f.dispose();
    }
});
