import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createStorage } from "@campussec/storage";
import {
  canonicalJson,
  fail,
  ok,
  type ReadTx,
  type Result,
  type WriteTx,
} from "@campussec/contracts";
import {
  CASE,
  CONNECTION,
  context,
  PRINCIPAL,
  scope,
  SPACE,
} from "@campussec/testkit";
import {
  storageFixture,
  seedCase as seed,
} from "../../../tests/support/storage.js";
test("49-table SQLite schema survives close/reopen with WAL, FK and migration checks", async () => {
  const f = await storageFixture();
  try {
    const saved = await f.db.write(context(), (tx) => {
      seed(tx);
      return ok(undefined);
    });
    assert.ok(saved.ok);
    const tables = await f.db.read(context(), (tx) =>
      tx.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      ),
    );
    assert.ok(tables.ok);
    assert.equal(tables.value?.count, 49);
    const mode = await f.db.read(context(), (tx) =>
      tx.get<{ journal_mode: string }>(
        "SELECT journal_mode FROM pragma_journal_mode",
      ),
    );
    assert.ok(mode.ok);
    assert.equal(mode.value?.journal_mode, "wal");
    await f.close();
    const reopened = await createStorage(f.deps);
    assert.ok(reopened.ok);
    try {
      const row = await reopened.value.db.read(context(), (tx) =>
        tx.get<{ title: string }>("SELECT title FROM cases WHERE id=?", [CASE]),
      );
      assert.ok(row.ok);
      assert.equal(row.value?.title, "合成案件");
    } finally {
      await reopened.value.close();
    }
  } finally {
    await f.dispose();
  }
});
test("failed callback rolls back business records AND domain events", async () => {
  const f = await storageFixture();
  try {
    const ctx = context();
    const result = await f.db.write(ctx, (tx) => {
      seed(tx);
      f.events.appendInTx(tx, ctx, {
        type: "case.changed",
        aggregateId: CASE,
        revision: 1,
        payload: { caseId: CASE, revision: 1, reason: "synthetic" },
      });
      return fail("CONFLICT", "模拟后续失败");
    });
    assert.equal(result.ok, false);
    const rows = await f.db.read(ctx, (tx) => ({
      cases: tx.get<{ count: number }>("SELECT COUNT(*) AS count FROM cases")!
        .count,
      events: tx.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM domain_events",
      )!.count,
    }));
    assert.ok(rows.ok);
    assert.deepEqual(rows.value, { cases: 0, events: 0 });
  } finally {
    await f.dispose();
  }
});
test("async/thenable transaction callbacks and expired read/write handles are rejected", async () => {
  const f = await storageFixture();
  try {
    let escaped: ReadTx | undefined;
    assert.equal(
      (
        await f.db.read(context(), (tx) => {
          escaped = tx;
          return 1;
        })
      ).ok,
      true,
    );
    assert.throws(() => escaped!.get("SELECT 1"));
    const callback = async (tx: WriteTx) => {
      seed(tx);
      await Promise.resolve();
      tx.run("UPDATE cases SET title=?", ["late"]);
      return ok(undefined);
    };
    assert.equal(
      (
        await f.db.write(
          context(),
          callback as unknown as (tx: WriteTx) => Result<void>,
        )
      ).ok,
      false,
    );
    await Promise.resolve();
    const count = await f.db.read(
      context(),
      (tx) =>
        tx.get<{ count: number }>("SELECT COUNT(*) AS count FROM cases")!.count,
    );
    assert.ok(count.ok);
    assert.equal(count.value, 0);
    assert.equal((await f.db.read(context(), async () => 1)).ok, false);
    assert.equal(
      (
        await f.db.read(context(), (tx) =>
          tx.get("DELETE FROM cases RETURNING id"),
        )
      ).ok,
      false,
    );
  } finally {
    await f.dispose();
  }
});
test("space/principal/epoch mismatches deny access without exposing stored values", async () => {
  const f = await storageFixture();
  try {
    for (const patch of [
      { spaceId: CASE },
      { principalId: CASE },
      { identityEpoch: 2 },
    ]) {
      const ctx = context();
      ctx.actor = { ...ctx.actor, ...patch };
      const read = await f.db.read(ctx, (tx) =>
        tx.all("SELECT * FROM connections"),
      );
      assert.equal(read.ok, false);
      if (!read.ok) assert.equal(read.error.code, "FORBIDDEN");
    }
    await f.close();
    const wrong = await createStorage({ ...f.deps, principalId: CASE });
    assert.equal(wrong.ok, false);
    const good = await createStorage(f.deps);
    assert.ok(good.ok);
    await good.value.close();
  } finally {
    await f.dispose();
  }
});
test("source identity, foreign keys, request keys, active jobs and CAS enforce real SQLite constraints", async () => {
  const f = await storageFixture();
  try {
    assert.ok(
      (
        await f.db.write(context(), (tx) => {
          seed(tx);
          return ok(undefined);
        })
      ).ok,
    );
    assert.equal(
      (
        await f.db.write(context(), (tx) => {
          tx.run(
            "INSERT INTO evidence_links(case_id,evidence_id,evidence_version,attached_revision) VALUES(?,?,?,?)",
            [CASE, CASE, 1, 1],
          );
          return ok(undefined);
        })
      ).ok,
      false,
    );
    const source = () =>
      f.db.write(context(), (tx) => {
        tx.run(
          "INSERT INTO evidence_sources(source_key,evidence_id,connection_id,locator_json) VALUES(?,?,?,?)",
          ["source", CASE, CONNECTION, "{}"],
        );
        return ok(undefined);
      });
    assert.equal((await source()).ok, true);
    assert.equal((await source()).ok, false);
    const job = (state: string) =>
      f.db.write(context(), (tx) => {
        const requestId = randomUUID(),
          jobId = randomUUID();
        tx.run(
          "INSERT INTO investigation_requests(id,origin,state,principal_id,connection_id,question,seed_refs_json,missing_fields_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
          [
            requestId,
            "client_user",
            "accepted",
            PRINCIPAL,
            CONNECTION,
            "q",
            "[]",
            "[]",
            scope.to,
            scope.to,
          ],
        );
        tx.run(
          "INSERT INTO jobs(id,request_id,case_id,origin,state,revision,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
          [
            jobId,
            requestId,
            CASE,
            "client_user",
            state,
            1,
            scope.to,
            scope.to,
            scope.to,
          ],
        );
        return ok({ jobId, requestId });
      });
    const first = await job("uncertain");
    assert.ok(first.ok);
    assert.equal((await job("running")).ok, false);
    const cancelled = await f.db.write(context(), (tx) => {
      tx.run("UPDATE jobs SET state=? WHERE id=?", [
        "needs_review",
        first.value.jobId,
      ]);
      return ok(undefined);
    });
    assert.ok(cancelled.ok);
    assert.equal((await job("running")).ok, true);
    const cas = () =>
      f.db.write(context(), (tx) =>
        tx.run(
          "UPDATE cases SET revision=revision+1 WHERE id=? AND revision=?",
          [CASE, 1],
        ).changes === 1
          ? ok(undefined)
          : fail("REVISION_CONFLICT", "conflict"),
      );
    const results = await Promise.all([cas(), cas()]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    const key = () =>
      f.db.write(context(), (tx) => {
        tx.run(
          "INSERT INTO request_keys(principal_id,origin_key,idempotency_key,request_hash,request_id) VALUES(?,?,?,?,?)",
          [PRINCIPAL, "client", "key", "hash", first.value.requestId],
        );
        return ok(undefined);
      });
    assert.equal((await key()).ok, true);
    assert.equal((await key()).ok, false);
  } finally {
    await f.dispose();
  }
});
test("event sequencing is committed with state, resetRequired survives complete event cleanup", async () => {
  const f = await storageFixture();
  try {
    const ctx = context();
    for (let i = 1; i <= 3; i++)
      assert.ok(
        (
          await f.db.write(ctx, (tx) =>
            ok(
              f.events.appendInTx(tx, ctx, {
                type: "runtime.changed",
                aggregateId: SPACE,
                revision: i,
                payload: { state: "degraded" },
              }),
            ),
          )
        ).ok,
      );
    const batch = await f.events.read(ctx, { afterSeq: 0, limit: 2 });
    assert.ok(batch.ok);
    assert.deepEqual(
      batch.value.events.map((e) => e.seq),
      [1, 2],
    );
    assert.equal(batch.value.lastSeq, 3);
    await f.db.write(ctx, (tx) => {
      tx.run("DELETE FROM domain_events WHERE seq<?", [3]);
      return ok(undefined);
    });
    const pruned = await f.events.read(ctx, { afterSeq: 0, limit: 2 });
    assert.ok(pruned.ok);
    assert.equal(pruned.value.resetRequired, true);
    await f.db.write(ctx, (tx) => {
      tx.run("DELETE FROM domain_events");
      return ok(undefined);
    });
    const empty = await f.events.read(ctx, { afterSeq: 0, limit: 2 });
    assert.ok(empty.ok);
    assert.equal(empty.value.resetRequired, true);
    assert.equal(empty.value.lastSeq, 3);
    assert.equal(
      (await f.events.read(ctx, { afterSeq: 0, limit: 201 })).ok,
      false,
    );
  } finally {
    await f.dispose();
  }
});
test("migration checksum conflicts preserve the existing database and reject startup", async () => {
  const f = await storageFixture();
  try {
    await f.close();
    const file = join(f.directory.path, "spaces", SPACE, "state.sqlite");
    const db = new DatabaseSync(file);
    db.prepare("UPDATE schema_migrations SET checksum=?").run("tampered");
    db.close();
    const opened = await createStorage(f.deps);
    assert.equal(opened.ok, false);
    const verify = new DatabaseSync(file);
    assert.equal(
      (
        verify
          .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type=?")
          .get("table") as { count: number }
      ).count,
      50,
    );
    assert.equal(
      (
        verify.prepare("SELECT checksum FROM schema_migrations").get() as {
          checksum: string;
        }
      ).checksum,
      "tampered",
    );
    verify.close();
  } finally {
    await f.dispose();
  }
});
