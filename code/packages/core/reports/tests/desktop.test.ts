import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ok } from "@campussec/contracts";
import { CASE, CONNECTION } from "@campussec/testkit";
import { composeRuntime } from "../../../../apps/desktop/runtime/compose.js";
import { setup, take } from "./fixtures.js";

test("production composition exposes persisted reports, maintenance reads, manual review and export through strict DesktopApi", async () => {
  const f = await setup();
  let runtime: Awaited<ReturnType<typeof composeRuntime>> | undefined;
  try {
    const { candidate } = await f.capture(),
      report = take(await f.propose(candidate)),
      revision = await f.caseRevision();
    await f.close();
    runtime = await composeRuntime({
      ...f.storeDeps,
      protection: {
        available: () => false,
        encrypt() {
          throw new Error("disabled");
        },
        decrypt() {
          throw new Error("disabled");
        },
      },
      async saveExport(value) {
        await writeFile(
          join(f.directory.path, value.filename),
          value.text,
          "utf8",
        );
        return ok(undefined);
      },
    });
    const value = take(runtime),
      ctx = value.context();
    const response = await value.facade.invoke(ctx, {
      protocolVersion: "0.1.0",
      requestId: f.ids.next(),
      method: "reports.list",
      payload: { caseId: CASE },
    });
    assert.equal(take(response.result)[0]!.id, report.id);
    const policy = await value.facade.invoke(ctx, {protocolVersion:"0.1.0", requestId:f.ids.next(), method:"alerts.getPolicy", payload:{connectionId:CONNECTION}});
    assert.deepEqual(take(policy.result), {configured:false});
    const history = await value.facade.invoke(ctx, {protocolVersion:"0.1.0", requestId:f.ids.next(), method:"investigations.history", payload:{caseId:CASE,page:{limit:20}}});
    assert.equal(take(history.result).items[0]!.run!.id, f.run.id);
    const inputs = await value.facade.invoke(ctx, {protocolVersion:"0.1.0", requestId:f.ids.next(), method:"investigations.input", payload:{runId:f.run.id,page:{limit:50}}});
    assert.deepEqual(take(inputs.result).initialInput, f.initialInput);
    const recover = await value.facade.invoke(ctx, {protocolVersion:"0.1.0", requestId:f.ids.next(), method:"deliveries.recover", payload:{deliveryId:f.ids.next(),expectedState:"blocked",expectedAttempts:3,reason:"未装配宿主时拒绝恢复"}});
    assert.equal(recover.result.ok, false);
    if (!recover.result.ok) assert.equal(recover.result.error.code, "NOT_FOUND");
    const reviewed = await value.facade.invoke(ctx, {
      protocolVersion: "0.1.0",
      requestId: f.ids.next(),
      method: "reports.review",
      payload: {
        reportId: report.id,
        expectedCaseRevision: revision,
        disposition: "accepted",
        humanConclusion: "unknown",
        note: "真实本地核查，尚需补充依据",
      },
    });
    assert.equal(take(reviewed.result).review, "accepted");
    const exported = await value.facade.invoke(ctx, {
      protocolVersion: "0.1.0",
      requestId: f.ids.next(),
      method: "cases.export",
      payload: { caseId: CASE, caseRevision: revision + 1, format: "json" },
    });
    const file = take(exported.result),
      payload = JSON.parse(
        await readFile(join(f.directory.path, file.filename), "utf8"),
      );
    assert.equal(payload.reports[0].review, "accepted");
    assert.equal(payload.reviews.length, 1);
    const status = await value.facade.invoke(ctx, {
      protocolVersion: "0.1.0",
      requestId: f.ids.next(),
      method: "runtime.status",
      payload: {},
    });
    assert.equal(take(status.result).state, "degraded");
  } finally {
    if (runtime?.ok) await runtime.value.close();
    await f.dispose();
  }
});
