import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  canonicalJson,
  type EvidenceProjection,
  type InvestigationProfileInput,
  type Result,
} from "@campussec/contracts";
import { CASE, context, foundationSamples } from "@campussec/testkit";
import {
  createInvestigationProfile,
  PROFILE_MANIFEST,
} from "@campussec/investigation-profile";
const system = () => {
  const value = context();
  return { ...value, actor: { ...value.actor, role: "system" as const } };
};
function take<T>(r: Result<T>) {
  assert.ok(r.ok, r.ok ? "" : r.error.code);
  return r.value;
}
function input(): InvestigationProfileInput {
  const sample = foundationSamples();
  return {
    run: { ...sample.run, profileVersion: PROFILE_MANIFEST.version },
    initialInput: {
      question: "合成调查",
      scope: sample.run.scope,
      seedRefs: [],
      contexts: [],
      capabilities: [],
    },
    seedProjections: [],
  };
}
test("profile preparation is deterministic, has explicit tool allowlist and never fabricates seed evidence", async () => {
  const profile = createInvestigationProfile(),
    source = input();
  const first = take(await profile.prepare(system(), source));
  assert.deepEqual(first, take(await profile.prepare(system(), source)));
  assert.deepEqual(first.seedProjectionIds, []);
  assert.deepEqual(first.contextRefs, []);
  assert.ok(!first.allowedTools.includes("search_related_alerts"));
  assert.ok(first.allowedTools.includes("propose_report"));
  assert.match(first.systemText, /禁止通用 Shell/);
  assert.match(PROFILE_MANIFEST.skillSha256, /^[a-f0-9]{64}$/);
  source.initialInput.capabilities = [
    {
      name: "alerts",
      state: "available",
      checkedAt: source.run.scope.to,
      endpointKind: "indexer",
      evidence: "synthetic",
    },
  ];
  assert.ok(
    take(await profile.prepare(system(), source)).allowedTools.includes(
      "search_related_alerts",
    ),
  );
  source.initialInput.capabilities.push({
    ...source.initialInput.capabilities[0]!,
    state: "denied",
  });
  assert.equal((await profile.prepare(system(), source)).ok, false);
});
test("profile rejects untrusted role, unsupported versions and oversized initialization", async () => {
  const profile = createInvestigationProfile(),
    source = input();
  assert.equal((await profile.prepare(context(), source)).ok, false);
  assert.equal(
    (
      await profile.prepare(system(), {
        ...source,
        run: { ...source.run, profileVersion: "unknown" },
      })
    ).ok,
    false,
  );
  const sample = foundationSamples().context;
  source.initialInput.contexts = Array.from({ length: 10 }, (_, i) => ({
    ...sample,
    id: `40000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    text: "大".repeat(5000),
  }));
  assert.equal((await profile.prepare(system(), source)).ok, false);
});
test("only correctly hashed prepared seed projections from the frozen set are included", async () => {
  const profile = createInvestigationProfile(),
    source = input(),
    content = { text: "合成种子" };
  const seed: EvidenceProjection = {
    id: CASE,
    runId: source.run.id,
    ref: { evidenceId: CASE, version: 1 },
    content,
    contentHash: createHash("sha256")
      .update(canonicalJson(content))
      .digest("hex"),
    state: "prepared",
    preparedAt: source.run.scope.to,
    availability: "available",
  };
  source.initialInput.seedRefs = [seed.ref];
  source.seedProjections = [seed];
  assert.deepEqual(
    take(await profile.prepare(system(), source)).seedProjectionIds,
    [CASE],
  );
  assert.equal(
    (
      await profile.prepare(system(), {
        ...source,
        seedProjections: [{ ...seed, state: "released" }],
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await profile.prepare(system(), {
        ...source,
        seedProjections: [{ ...seed, contentHash: "a".repeat(64) }],
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await profile.prepare(system(), {
        ...source,
        seedProjections: [{ ...seed, content: { password: "synthetic" } }],
      })
    ).ok,
    false,
  );
  const outside = { "agent.id": "outside" };
  assert.equal(
    (
      await profile.prepare(system(), {
        ...source,
        seedProjections: [
          {
            ...seed,
            content: outside,
            contentHash: createHash("sha256")
              .update(canonicalJson(outside))
              .digest("hex"),
          },
        ],
      })
    ).ok,
    false,
  );
  assert.equal(
    (await profile.prepare(system(), { ...source, seedProjections: [] })).ok,
    false,
  );
});
