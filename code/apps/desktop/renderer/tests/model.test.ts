import { test } from "node:test";
import assert from "node:assert/strict";
import {
  absoluteWindow,
  canResume,
  parseScope,
  scopeForAlerts,
  submissionKey,
} from "../model.js";
import { foundationSamples } from "@campussec/testkit";

test("scope inputs normalize offsets and duplicates, reject unbounded or ambiguous investigation ranges", () => {
  const input = {
    connectionId: "connection",
    agents: "001，002 001",
    from: "2026-10-24T08:00:00+08:00",
    to: "2026-10-24T08:30:00+08:00",
    timeZone: "Asia/Shanghai",
  };
  const parsed = parseScope(input);
  assert.deepEqual(parsed.agentIds, ["001", "002"]);
  assert.equal(parsed.from, "2026-10-24T00:00:00.000Z");
  assert.throws(
    () => parseScope({ ...input, from: "2026-10-24T08:00:00" }),
    /时区/,
  );
  assert.throws(
    () => parseScope({ ...input, to: "2026-10-24T10:00:00+08:00" }),
    /60 分钟/,
  );
  assert.throws(
    () => parseScope({ ...input, timeZone: "missing-zone" }),
    /时区/,
  );
  assert.throws(() => parseScope({ ...input, agents: "1,2,3,4,5,6" }), /1—5/);
});
test("relative presets freeze absolute UTC bounds and statistics do not widen an investigation limit", () => {
  const fixed = absoluteWindow(1440, "2026-10-24T08:00:00+08:00");
  assert.deepEqual(fixed, {
    from: "2026-10-23T00:00:00.000Z",
    to: "2026-10-24T00:00:00.000Z",
  });
  const input = {
    connectionId: "connection",
    agents: "001",
    timeZone: "Asia/Shanghai",
    ...fixed,
  };
  assert.throws(() => parseScope(input));
  assert.equal(parseScope(input, 1440).from, fixed.from);
});
test("a retried business submission reuses its key while a changed scope, question or evidence creates a new key", () => {
  const key = submissionKey(),
    payload = {
      question: "调查",
      scope: absoluteWindow(30, "2026-10-24T00:00:00Z"),
      refs: [] as string[],
    };
  const first = key(payload);
  assert.equal(key(structuredClone(payload)), first);
  const changed = key({ ...payload, question: "调查另一个问题" });
  assert.notEqual(changed, first);
  assert.notEqual(key({ ...payload, refs: ["evidence"] }), changed);
});
test("recovery UI only offers resume for a held task that has not created a run", () => {
  const job = foundationSamples().job;
  assert.equal(
    canResume({
      ...job,
      state: "queued",
      recoveryHold: true,
      runId: undefined,
    }),
    true,
  );
  assert.equal(
    canResume({ ...job, state: "running", recoveryHold: true }),
    false,
  );
  assert.equal(
    canResume({
      ...job,
      state: "queued",
      recoveryHold: false,
      runId: undefined,
    }),
    false,
  );
  assert.equal(
    canResume({
      ...job,
      state: "queued",
      recoveryHold: true,
      runId: "existing-run",
    }),
    false,
  );
});
test("selected historical alerts prefill their actual device/time range; unknown or over-wide selections require explicit scope", () => {
  const observedAt = "2026-10-23T00:00:00.000Z";
  const scope = scopeForAlerts(
    [{ agentId: "001", observedAt }],
    "connection",
    undefined,
    Date.parse("2026-10-24T00:00:00.000Z"),
  )!;
  assert.deepEqual(scope.agentIds, ["001"]);
  assert.equal(scope.from, "2026-10-22T23:55:00.000Z");
  assert.equal(scope.to, "2026-10-23T00:05:00.000Z");
  assert.equal(scopeForAlerts([{ agentId: "001" }], "connection"), undefined);
  assert.equal(
    scopeForAlerts(
      [
        { agentId: "001", observedAt },
        { agentId: "002", observedAt: "2026-10-23T02:00:00.000Z" },
      ],
      "connection",
    ),
    undefined,
  );
});
