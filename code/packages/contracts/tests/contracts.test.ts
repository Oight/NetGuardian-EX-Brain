import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  canonicalJson,
  decodeCursor,
  desktopSchemas,
  dtoSchemas,
  encodeCursor,
  normalizedRequest,
  parseCreateRequest,
  parseDesktopInput,
  parseDesktopOutput,
  parseDomainEvent,
  parseEvidenceToolEnvelope,
  parseInstant,
  parseRpcRequest,
  parseScope,
  sha256,
  utf8Bytes,
  DEFAULT_LIMITS,
} from "@campussec/contracts";
import { CASE, CONNECTION, context, scope, SPACE } from "@campussec/testkit";

test("scope limits normalize offsets and preserve native device identity", () => {
  const parsed = parseScope({
    ...scope,
    agentIds: ["003", "001", "001"],
    from: "2026-10-23T08:30:00+08:00",
    to: "2026-10-23T09:00:00+08:00",
  });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.agentIds, ["001", "003"]);
  assert.equal(parsed.value.from, scope.from);
  assert.equal(
    parseScope({ ...scope, agentIds: ["1", "2", "3", "4", "5"] }).ok,
    true,
  );
  assert.equal(
    parseScope({ ...scope, agentIds: ["1", "2", "3", "4", "5", "6"] }).ok,
    false,
  );
  assert.equal(parseScope({ ...scope, agentIds: [] }).ok, false);
  assert.equal(parseScope({ ...scope, to: scope.from }).ok, false);
  assert.equal(parseScope({ ...scope, to: "2026-10-23T02:00:00Z" }).ok, false);
  assert.equal(
    parseScope({ ...scope, timeZone: "invalid/time-zone" }).ok,
    false,
  );
  assert.equal(parseInstant("2026-02-30T00:00:00Z").ok, false);
  assert.equal(parseInstant("2026-10-23T01:00:00").ok, false);
});
test("all Desktop methods have strict input/output boundaries and unknown methods/actors are rejected", () => {
  assert.equal(Object.keys(desktopSchemas).length, 47);
  for (const [name, schemas] of Object.entries(desktopSchemas)) {
    assert.equal(
      schemas.input.safeParse({ __unexpected: true }).success,
      false,
      name,
    );
    assert.equal(
      schemas.output.safeParse({ __unexpected: true }).success,
      false,
      name,
    );
  }
  assert.equal(
    parseRpcRequest({
      protocolVersion: "0.1.0",
      requestId: CASE,
      method: "runtime.status",
      payload: { actor: context().actor },
    }).ok,
    false,
  );
  assert.equal(
    parseRpcRequest({
      protocolVersion: "0.2.0",
      requestId: CASE,
      method: "runtime.status",
      payload: {},
    }).ok,
    false,
  );
  assert.equal(
    parseRpcRequest({
      protocolVersion: "0.1.0",
      requestId: CASE,
      method: "arbitrary.sql",
      payload: {},
    }).ok,
    false,
  );
  assert.equal(
    parseDesktopInput("connections.configure", {
      displayName: "demo",
      platformInstanceId: CASE,
      alertsPattern: "alerts-*",
      mappingVersion: "v1",
      indexerBaseUrl: "https://user:password@example.com",
    }).ok,
    false,
  );
  assert.equal(
    parseDesktopOutput("runtime.settings", {
      revision: 1,
      trayEnabled: false,
      budgetTimeZone: "Asia/Shanghai",
      password: "secret",
    }).ok,
    false,
  );
});
test("canonical JSON uses code point ordering and rejects non-JSON/cyclic/accessor inputs", async () => {
  assert.equal(
    canonicalJson({ "\u{10000}": 2, "\ue000": 1 }),
    '{"\ue000":1,"\u{10000}":2}',
  );
  for (const value of [
    NaN,
    Infinity,
    1n,
    undefined,
    () => true,
    new Date(),
    [undefined],
    new Array(2),
  ])
    assert.throws(() => canonicalJson(value));
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(() => canonicalJson(circular));
  assert.throws(() =>
    canonicalJson({
      get credential() {
        throw new Error("must not invoke");
      },
    }),
  );
  const digest = async (bytes: Uint8Array) =>
    new Uint8Array(createHash("sha256").update(bytes).digest());
  const a = {
    origin: "client_user" as const,
    connectionId: CONNECTION,
    question: " 问题 ",
    requestedScope: { ...scope, agentIds: ["002", "001"] },
    seedRefs: [],
    idempotencyKey: "a",
  };
  const b = {
    ...a,
    requestedScope: { ...scope, agentIds: ["001", "002"] },
    idempotencyKey: "b",
  };
  assert.equal(
    await sha256(normalizedRequest(a), digest),
    await sha256(normalizedRequest(b), digest),
  );
  assert.notEqual(
    await sha256(normalizedRequest(a), digest),
    await sha256(normalizedRequest({ ...b, question: "另一个问题" }), digest),
  );
  assert.equal(Object.isFrozen(DEFAULT_LIMITS), true);
});
test("local cursors bind query and space and reject altered sort keys", () => {
  const hash = "a".repeat(64);
  const cursor = encodeCursor({
    version: "0.1.0",
    spaceId: SPACE,
    queryHash: hash,
    lastKeys: [scope.to, CASE],
  });
  assert.equal(
    decodeCursor(cursor, { spaceId: SPACE, queryHash: hash }).ok,
    true,
  );
  assert.equal(
    decodeCursor(cursor, { spaceId: CASE, queryHash: hash }).ok,
    false,
  );
  assert.equal(
    decodeCursor(cursor, { spaceId: SPACE, queryHash: "b".repeat(64) }).ok,
    false,
  );
  const invalid = encodeCursor({
    version: "0.1.0",
    spaceId: SPACE,
    queryHash: hash,
    lastKeys: [{}],
  });
  assert.equal(
    decodeCursor(invalid, { spaceId: SPACE, queryHash: hash }).ok,
    false,
  );
});
test("synthetic empty/denied/partial remain distinct and 16 KiB is a UTF-8 limit", async () => {
  const vectors = JSON.parse(
    await readFile("spec/contract-vectors.json", "utf8"),
  );
  for (const name of ["emptyComplete", "denied", "partial"])
    assert.equal(parseEvidenceToolEnvelope(vectors[name]).ok, true, name);
  assert.equal(vectors.emptyComplete.coverage.queryCompleteness, "complete");
  assert.equal(vectors.denied.coverage.queryCompleteness, "not_executed");
  assert.equal(vectors.partial.coverage.queryCompleteness, "partial");
  const schema = dtoSchemas.ControlToolEnvelope;
  const base = {
    schemaVersion: "0.1.0",
    status: "ok",
    data: { text: "" },
    warnings: [],
  };
  const overhead = utf8Bytes(canonicalJson(base));
  const inside = {
    ...base,
    data: { text: "中".repeat(Math.floor((16384 - overhead) / 3)) },
  };
  assert.equal(schema.safeParse(inside).success, true);
  assert.equal(
    schema.safeParse({ ...inside, data: { text: inside.data.text + "中" } })
      .success,
    false,
  );
});
test("internal snapshots and events reject forged fields and unknown enums", () => {
  assert.equal(
    dtoSchemas.CompletionDecision.safeParse({
      terminalState: "pretend_success",
      reason: "x",
    }).success,
    false,
  );
  assert.equal(
    dtoSchemas.FrozenRunInput.safeParse({
      question: "q",
      scope,
      seedRefs: [],
      contexts: [],
      capabilities: [],
      privateToken: "x",
    }).success,
    false,
  );
  assert.equal(
    parseDomainEvent({
      seq: 1,
      type: "case.changed",
      spaceId: SPACE,
      aggregateId: CASE,
      revision: 1,
      traceId: CASE,
      occurredAt: scope.to,
      payload: {
        caseId: CASE,
        revision: 1,
        reason: "change",
        rawLog: "secret",
      },
    }).ok,
    false,
  );
  assert.equal(
    parseCreateRequest({
      origin: "client_user",
      connectionId: CONNECTION,
      question: "q",
      seedRefs: [],
      idempotencyKey: "\n",
    }).ok,
    false,
  );
});
