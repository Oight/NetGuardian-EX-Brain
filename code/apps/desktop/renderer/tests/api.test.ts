import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../api.js";
import { createScriptedDesktop } from "@campussec/testkit";
import { fail, type DesktopApi } from "@campussec/contracts";
test("typed renderer client preserves actionable revision conflicts", async () => {
  const fake = createScriptedDesktop();
  fake.push("cases.list", async () =>
    fail("REVISION_CONFLICT", "案件有新版本"),
  );
  await assert.rejects(
    createClient(fake.port)("cases.list", { page: { limit: 20 } }),
    (e) => e instanceof Error && "code" in e && e.code === "REVISION_CONFLICT",
  );
  assert.equal(fake.calls[0]?.method, "cases.list");
});
test("renderer rejects a mismatched IPC response correlation", async () => {
  const api: DesktopApi = {
    invoke: async (request) => ({
      protocolVersion: "0.1.0",
      requestId: "10000000-0000-4000-8000-000000000099",
      result: fail("INTERNAL", "mismatch"),
    }),
  };
  await assert.rejects(
    createClient(api)("runtime.status", {}),
    /响应无效或与请求不匹配/,
  );
});
