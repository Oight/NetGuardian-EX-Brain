import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { test } from "node:test";
import {
  createSignedClient,
  localSigner,
  observeMessages,
} from "../teleagent/index.js";

const now = "2026-10-24T13:00:00.000Z";
const runId = "11111111-1111-4111-8111-111111111111";
const text = "合成调查\n\n[campussec-run:" + runId + "]";
const user = {
  info: { id: "msg_user", sessionID: "ses_owned", role: "user" },
  parts: [{ type: "text", text }],
};
const assistant = (fields: Record<string, unknown> = {}) => ({
  info: {
    id: "msg_answer",
    sessionID: "ses_owned",
    role: "assistant",
    parentID: "msg_user",
    time: { created: 100, completed: 110 },
    finish: "stop",
    tokens: { input: 10, output: 3 },
    ...fields,
  },
  parts: [{ type: "text", text: "synthetic" }],
});
const observe = (messages: unknown) =>
  observeMessages({
    runId,
    sessionId: "ses_owned",
    messages,
    expectedText: text,
    now,
  });

test("TeleAgent completion requires the exact submitted user and correlated final assistant, not idle or text", () => {
  assert.equal(observe([]).phase, "uncertain");
  assert.equal(observe([user]).phase, "submitted");
  assert.equal(
    observe([user, assistant({ parentID: "msg_other" })]).phase,
    "submitted",
  );
  assert.equal(
    observe([user, assistant({ finish: "tool_calls" })]).phase,
    "running",
  );
  assert.equal(
    observe([user, assistant({ finish: "length" })]).phase,
    "uncertain",
  );
  const completed = observe([user, assistant()]);
  assert.equal(completed.phase, "completed");
  assert.equal(completed.userMessageId, "msg_user");
  assert.equal(completed.resultMessageId, "msg_answer");
  assert.deepEqual(completed.usage, {
    inputTokens: 10,
    outputTokens: 3,
    estimated: false,
    costKnown: false,
  });
});
test("TeleAgent ambiguous users, duplicate messages and another session cannot establish a verified run", () => {
  assert.equal(
    observe([user, { ...user, info: { ...user.info, id: "msg_duplicate" } }])
      .phase,
    "uncertain",
  );
  assert.equal(
    observe([user, assistant(), assistant()]).verification,
    "unverified",
  );
  assert.equal(
    observe([user, assistant({ sessionID: "ses_foreign" })]).verification,
    "unverified",
  );
  assert.equal(
    observe([
      { ...user, parts: [{ type: "text", text: text + " changed" }] },
      assistant(),
    ]).phase,
    "uncertain",
  );
  assert.equal(
    observe([user, assistant({ time: { created: 100, completed: 90 } })]).phase,
    "running",
  );
});
test("TeleAgent reports observed cancellation separately from an arbitrary error and sums actual tool rounds", () => {
  assert.equal(
    observe([user, assistant({ error: { name: "MessageAbortedError" } })])
      .phase,
    "cancelled",
  );
  const failed = observe([
    user,
    assistant({
      error: { name: "ProviderError", data: { message: "private-key-value" } },
    }),
  ]);
  assert.equal(failed.phase, "failed");
  assert.ok(!JSON.stringify(failed).includes("private-key-value"));
  const result = observe([
    user,
    assistant({
      id: "msg_round",
      finish: "tool_calls",
      time: { created: 50, completed: 60 },
    }),
    assistant(),
  ]);
  assert.equal(result.usage?.inputTokens, 20);
  assert.equal(
    observe([user, assistant({ tokens: undefined })]).usage,
    undefined,
  );
});

async function server(handler: (url: string, res: ServerResponse) => void) {
  const instance = createServer((req, res) => handler(req.url!, res));
  await new Promise<void>((resolve) =>
    instance.listen(0, "127.0.0.1", resolve),
  );
  const address = instance.address();
  assert.ok(address && typeof address !== "string");
  return {
    instance,
    endpoint: "http://127.0.0.1:" + address.port,
    close: () =>
      new Promise<void>((resolve) => {
        instance.close(() => resolve());
        instance.closeAllConnections();
      }),
  };
}
test("signed client signs the final encoded Chinese/space directory and refreshes nonces without inheriting proxies", async () => {
  const key = "synthetic_UTF8-key-not-base64-decoded-0123456789";
  const seen: string[] = [];
  const instance = createServer((req, res) => {
    const canonical = [
      "local-v1",
      req.method,
      req.url,
      req.headers["x-sa-timestamp"],
      req.headers["x-sa-nonce"],
    ].join("\n");
    assert.equal(
      req.headers["x-sa-signature"],
      createHmac("sha256", key).update(canonical).digest("base64url"),
    );
    assert.equal(
      new URL(req.url!, "http://127.0.0.1").searchParams.get("directory"),
      process.cwd() + "/中文 空格",
    );
    seen.push(String(req.headers["x-sa-nonce"]));
    res.setHeader("Content-Type", "application/json");
    res.end("{}");
  });
  await new Promise<void>((resolve) =>
    instance.listen(0, "127.0.0.1", resolve),
  );
  const address = instance.address();
  assert.ok(address && typeof address !== "string");
  try {
    const client = createSignedClient({
      endpoint: "http://127.0.0.1:" + address.port,
      directory: process.cwd() + "/中文 空格",
      sign: localSigner(key),
    });
    assert.equal((await client.request("GET", "/session/status")).ok, true);
    assert.equal((await client.request("GET", "/session/status")).ok, true);
    assert.notEqual(seen[0], seen[1]);
    assert.equal((await client.request("POST", "/session/")).ok, false);
    assert.equal(seen.length, 2);
  } finally {
    await new Promise<void>((resolve) => instance.close(() => resolve()));
  }
});
test("signed client refuses remote targets, redirects, oversized/malformed bodies and secrets in error diagnostics", async () => {
  for (const endpoint of [
    "http://example.invalid:123",
    "http://localhost:123",
    "http://127.0.0.1:123/prefix",
    "http://user:secret@127.0.0.1:123",
    "https://127.0.0.1:123",
  ])
    assert.throws(() =>
      createSignedClient({
        endpoint,
        directory: process.cwd(),
        sign: () => "x",
      }),
    );
  const f = await server((url, res) => {
    if (url.startsWith("/redirect")) {
      res.writeHead(302, { Location: "http://example.invalid/private" });
      res.end("secret");
    } else if (url.startsWith("/denied")) {
      res.writeHead(401);
      res.end("sensitive-credential");
    } else if (url.startsWith("/large"))
      res.end(JSON.stringify("x".repeat(1000)));
    else res.end("invalid-json sensitive-credential");
  });
  try {
    const client = createSignedClient({
      endpoint: f.endpoint,
      directory: process.cwd(),
      sign: () => "synthetic",
      maxBytes: 100,
    });
    for (const path of ["/redirect", "/denied", "/large", "/malformed"]) {
      const result = await client.request("GET", path);
      assert.equal(result.ok, false);
      assert.ok(!JSON.stringify(result).includes("sensitive-credential"));
    }
  } finally {
    await f.close();
  }
});
test("signed client bounds stalled requests and respects cancellation without resubmitting writes", async () => {
  let calls = 0;
  const f = await server(() => {
    calls++;
  });
  try {
    const client = createSignedClient({
      endpoint: f.endpoint,
      directory: process.cwd(),
      sign: () => "synthetic",
      timeoutMs: 30,
    });
    const result = await client.request("POST", "/session", {});
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "UPSTREAM_TIMEOUT");
    assert.equal(calls, 1);
    const controller = new AbortController();
    controller.abort();
    assert.equal(
      (await client.request("POST", "/session", {}, controller.signal)).ok,
      false,
    );
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});
