import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, ok } from "@campussec/contracts";
import { CONNECTION, context, foundationSamples } from "@campussec/testkit";
import { createPolicyReader } from "@campussec/core/alerts/policy-reader";
import { createStorage } from "@campussec/storage";
import { storageFixture, seedCase } from "../../../../tests/support/storage.js";
import { take, error, system } from "../../reports/tests/fixtures.js";

test("policy reads distinguish absent configuration, persist across reopen and refuse inconsistent snapshots or actors", async () => {
  const f = await storageFixture();
  let opened: Awaited<ReturnType<typeof createStorage>> | undefined;
  try {
    take(
      await f.db.write(context(), (tx) => {
        seedCase(tx);
        return ok(undefined);
      }),
    );
    assert.deepEqual(
      take(await createPolicyReader(f).getPolicy(context(), CONNECTION)),
      { configured: false },
    );
    const policy = foundationSamples().desktop["alerts.setPolicy"].output;
    take(
      await f.db.write(context(), (tx) => {
        tx.run(
          "INSERT INTO trigger_policies(id,connection_id,revision,epoch,enabled,enabled_after_receive_seq,policy_json) VALUES(?,?,?,?,?,?,?)",
          [
            policy.id,
            CONNECTION,
            policy.revision,
            policy.epoch,
            Number(policy.enabled),
            policy.enabledAfterReceiveSeq,
            canonicalJson(policy),
          ],
        );
        return ok(undefined);
      }),
    );
    await f.close();
    opened = await createStorage(f.deps);
    const storage = take(opened),
      reader = createPolicyReader(storage);
    assert.deepEqual(take(await reader.getPolicy(context(), CONNECTION)), {
      configured: true,
      policy,
    });
    error(await reader.getPolicy(system(), CONNECTION), "FORBIDDEN");
    take(
      await storage.db.write(context(), (tx) => {
        tx.run("UPDATE trigger_policies SET revision=revision+1");
        return ok(undefined);
      }),
    );
    error(await reader.getPolicy(context(), CONNECTION), "VALIDATION_FAILED");
  } finally {
    if (opened?.ok) await opened.value.close();
    await f.dispose();
  }
});
