import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ok,
  fail,
  type CallContext,
  type OriginBinding,
  type HostReceipt,
} from "@campussec/contracts";
import type { HostWire } from "@campussec/teleagent-bridge/host-access";
import { composedFixture, take } from "../support/composed.js";
const syntheticReceipt: HostReceipt = {
  messageId: "synthetic-output",
  visible: true,
  observedAt: "2026-10-23T01:00:00.000Z",
};
async function deliveryFixture() {
  let sends = 0,
    reconciles = 0,
    mode: "lost" | "visible" | "redirect" = "lost",
    state: "found" | "absent" | "unknown" = "unknown",
    binding: OriginBinding;
  const messages: {
    session: string;
    text: string;
    key: string;
  }[] = [];
  const wire: HostWire = {
    capabilities: async () => ok([]),
    resolveOrigin: async () =>
      ok(
        mode === "redirect"
          ? { ...binding, sessionId: "different-session" }
          : binding,
      ),
    deliver: async (_ctx, input) => {
      sends++;
      messages.push({
        session: input.binding.sessionId,
        text: input.message.text,
        key: input.deliveryKey,
      });
      if (mode === "lost") throw new Error("synthetic response loss");
      return ok(syntheticReceipt);
    },
    reconcileDelivery: async () => {
      reconciles++;
      return ok({
        state,
        ...(state === "found" ? { receipt: syntheticReceipt } : {}),
      });
    },
  };
  const f = await composedFixture(undefined, wire);
  binding = {
    id: f.ids.next(),
    spaceId: f.ctx.actor.spaceId,
    principalId: f.ctx.actor.principalId,
    hostId: f.ids.next(),
    hostAccountId: f.ids.next(),
    workspaceId: f.ids.next(),
    sessionId: "original-conversation",
    requestMessageId: "original-message",
    state: "active",
    createdAt: f.clock.now(),
    expiresAt: "2026-10-24T01:00:00.000Z",
  };
  take(await f.runtime.services.host.resolveOrigin(f.system, f.ids.next()));
  const caller: CallContext = {
    ...f.ctx,
    actor: { ...f.ctx.actor, role: "delegation", originBindingId: binding.id },
  };
  const request = take(
    await f.runtime.services.requests.create(caller, {
      ...f.request("origin-request"),
      origin: "teleagent_user",
      originBindingId: binding.id,
    }),
  );
  const cancelled = take(
    await f.runtime.services.requests.cancel(caller, {
      requestId: request.request.id,
      reason: "无需提交",
    }),
  );
  assert.equal(cancelled.job?.state, "cancelled");
  return {
    ...f,
    get runtime() {
      return f.runtime;
    },
    caller,
    binding,
    request,
    messages,
    sends: () => sends,
    reconciles: () => reconciles,
    setMode: (value: typeof mode) => {
      mode = value;
    },
    setState: (value: typeof state) => {
      state = value;
    },
  };
}
test("final result and outbox persist together; lost receipt stays uncertain and never blindly resends, including reopen", async () => {
  const f = await deliveryFixture();
  try {
    let records = take(
      await f.runtime.services.delivery.status(f.caller, f.request.request.id),
    );
    assert.equal(records.length, 1);
    assert.equal(records[0]?.state, "pending");
    assert.equal(records[0]?.result.terminalState, "cancelled");
    take(await f.runtime.services.delivery.tick(f.system));
    assert.equal(f.sends(), 1);
    records = take(
      await f.runtime.services.delivery.status(f.caller, f.request.request.id),
    );
    assert.equal(records[0]?.state, "uncertain");
    assert.equal(f.messages[0]?.session, "original-conversation");
    assert.equal(JSON.parse(f.messages[0]!.text).terminalState, "cancelled");
    await f.reopen();
    f.clock.advance(60000);
    f.setState("found");
    take(await f.runtime.services.delivery.tick(f.system));
    records = take(
      await f.runtime.services.delivery.status(f.caller, f.request.request.id),
    );
    assert.equal(records[0]?.state, "delivered");
    assert.equal(records[0]?.receipt?.visible, true);
    assert.equal(f.sends(), 1);
    take(await f.runtime.services.delivery.tick(f.system));
    assert.equal(f.sends(), 1);
  } finally {
    await f.close();
  }
});
test("only verified absent delivery may retry; stable delivery key prevents a new logical message", async () => {
  const f = await deliveryFixture();
  try {
    take(await f.runtime.services.delivery.tick(f.system));
    f.clock.advance(60000);
    f.setState("absent");
    take(await f.runtime.services.delivery.tick(f.system));
    assert.equal(f.sends(), 1);
    assert.equal(
      take(
        await f.runtime.services.delivery.status(
          f.caller,
          f.request.request.id,
        ),
      )[0]?.state,
      "pending",
    );
    f.setMode("visible");
    take(await f.runtime.services.delivery.tick(f.system));
    assert.equal(f.sends(), 1);
    f.clock.advance(5000);
    take(await f.runtime.services.delivery.tick(f.system));
    assert.equal(f.sends(), 2);
    assert.equal(f.messages[0]?.key, f.messages[1]?.key);
    assert.equal(
      take(
        await f.runtime.services.delivery.status(
          f.caller,
          f.request.request.id,
        ),
      )[0]?.state,
      "delivered",
    );
  } finally {
    await f.close();
  }
});
test("foreign origin and evidence role cannot read results; trusted binding cannot redirect to another conversation", async () => {
  const f = await deliveryFixture();
  try {
    const other = {
      ...f.caller,
      actor: { ...f.caller.actor, originBindingId: f.ids.next() },
    };
    assert.equal(
      (
        await f.runtime.services.delivery.getResult(other, {
          requestId: f.request.request.id,
        })
      ).ok,
      false,
    );
    const evidence = {
      ...f.ctx,
      actor: { ...f.ctx.actor, role: "evidence" as const },
    };
    assert.equal(
      (await f.runtime.services.delivery.status(evidence, f.request.request.id))
        .ok,
      false,
    );
    f.setMode("redirect");
    const changed = await f.runtime.services.host.resolveOrigin(
      f.system,
      f.ids.next(),
    );
    assert.equal(changed.ok, false);
    if (!changed.ok) assert.equal(changed.error.code, "CONFLICT");
    assert.equal(
      take(await f.runtime.services.host.binding(f.system, f.binding.id))
        .sessionId,
      "original-conversation",
    );
  } finally {
    await f.close();
  }
});
test("terminal job mutation failure rolls back the preceding ResultPackage", async () => {
  const f = await composedFixture();
  try {
    const accepted = take(
      await f.runtime.services.requests.create(f.ctx, f.request("atomic")),
    );
    // A SQLite failure at the final job mutation must roll back the preceding ResultPackage write.
    const injection = new DatabaseSync(f.databasePath);
    try {
      injection.exec(
        "CREATE TRIGGER synthetic_finalization_failure BEFORE UPDATE OF state ON jobs WHEN NEW.state='cancelled' BEGIN SELECT RAISE(ABORT,'synthetic'); END",
      );
    } finally {
      injection.close();
    }
    const failed = await f.runtime.services.requests.cancel(f.ctx, {
      requestId: accepted.request.id,
      reason: "rollback",
    });
    assert.equal(failed.ok, false);
    assert.equal(
      take(await f.runtime.services.requests.status(f.ctx, accepted.request.id))
        .job?.state,
      "queued",
    );
    const result = await f.runtime.services.delivery.getResult(f.ctx, {
      requestId: accepted.request.id,
    });
    assert.equal(result.ok, false);
  } finally {
    await f.close();
  }
});
test("outbox write failure rolls back request terminal state and the result package in the same transaction", async () => {
  const f = await deliveryFixture();
  try {
    const existing = f.request.request;
    const accepted = take(
      await f.runtime.services.requests.create(f.caller, {
        origin: "teleagent_user",
        originBindingId: f.binding.id,
        connectionId: existing.connectionId,
        question: "原子投递验证",
        requestedScope: existing.effectiveScope!,
        seedRefs: [],
        idempotencyKey: "atomic-outbox",
      }),
    );
    const injection = new DatabaseSync(f.databasePath);
    try {
      injection.exec(
        "CREATE TRIGGER synthetic_outbox_failure BEFORE INSERT ON result_deliveries BEGIN SELECT RAISE(ABORT,'synthetic'); END",
      );
    } finally {
      injection.close();
    }
    assert.equal(
      (
        await f.runtime.services.requests.cancel(f.caller, {
          requestId: accepted.request.id,
          reason: "验证最终事务",
        })
      ).ok,
      false,
    );
    assert.equal(
      take(
        await f.runtime.services.requests.status(f.caller, accepted.request.id),
      ).job?.state,
      "queued",
    );
    assert.equal(
      (
        await f.runtime.services.delivery.getResult(f.caller, {
          requestId: accepted.request.id,
        })
      ).ok,
      false,
    );
    const cleanup = new DatabaseSync(f.databasePath);
    try {
      cleanup.exec("DROP TRIGGER synthetic_outbox_failure");
    } finally {
      cleanup.close();
    }
    assert.equal(
      take(
        await f.runtime.services.requests.cancel(f.caller, {
          requestId: accepted.request.id,
          reason: "重试未提交事务",
        }),
      ).job?.state,
      "cancelled",
    );
    assert.equal(
      take(
        await f.runtime.services.delivery.status(f.caller, accepted.request.id),
      ).length,
      1,
    );
  } finally {
    await f.close();
  }
});
test("trusted delegation uses actual production scope and request ports and rejects model-supplied origin routing", async () => {
  const f = await deliveryFixture();
  try {
    const input = (
      callId: string,
      toolName: string,
      args: import("@campussec/contracts").JsonObject,
    ) => ({
      callId,
      toolName,
      arguments: args,
      transportBindingId: f.binding.id,
    });
    const scope = take(
      await f.runtime.services.gateway.invoke(
        f.caller,
        input("scope", "list_investigation_scope", { page: { limit: 10 } }),
      ),
    );
    assert.equal(scope.isError, false);
    const connections = JSON.parse(scope.text).data.result.connections;
    assert.equal(connections.length, 1);
    assert.deepEqual(Object.keys(connections[0]).sort(), [
      "displayName",
      "generation",
      "id",
    ]);
    const result = take(
      await f.runtime.services.gateway.invoke(
        f.caller,
        input("result", "get_investigation_result", {
          requestId: f.request.request.id,
        }),
      ),
    );
    assert.equal(
      JSON.parse(result.text).data.result.terminalState,
      "cancelled",
    );
    const forged = await f.runtime.services.gateway.invoke(
      f.caller,
      input("forged", "request_investigation", {
        connectionId: f.request.request.connectionId,
        originBindingId: f.binding.id,
        question: "forged",
        seedRefs: [],
        idempotencyKey: "forged",
      }),
    );
    assert.equal(forged.ok, false);
    const accepted = take(
      await f.runtime.services.gateway.invoke(
        f.caller,
        input("new", "request_investigation", {
          connectionId: f.request.request.connectionId,
          question: "可信来源受理",
          seedRefs: [],
          idempotencyKey: "trusted-gateway",
        }),
      ),
    );
    assert.equal(accepted.isError, false);
    assert.equal(
      JSON.parse(accepted.text).data.result.request.originBindingId,
      f.binding.id,
    );
    assert.equal(
      JSON.parse(accepted.text).data.result.request.state,
      "awaiting_scope",
    );
  } finally {
    await f.close();
  }
});
test("unknown delivery reconciliation blocks automatic sends but preserves local result retrieval", async () => {
  const f = await deliveryFixture();
  try {
    take(await f.runtime.services.delivery.tick(f.system));
    f.clock.advance(5000);
    take(await f.runtime.services.delivery.tick(f.system));
    assert.equal(f.sends(), 1);
    assert.equal(f.reconciles(), 1);
    assert.equal(
      take(
        await f.runtime.services.delivery.status(
          f.caller,
          f.request.request.id,
        ),
      )[0]?.state,
      "blocked",
    );
    f.clock.advance(60000);
    take(await f.runtime.services.delivery.tick(f.system));
    assert.equal(f.sends(), 1);
    assert.equal(f.reconciles(), 1);
    assert.equal(
      take(
        await f.runtime.services.delivery.getResult(f.caller, {
          requestId: f.request.request.id,
        }),
      ).terminalState,
      "cancelled",
    );
  } finally {
    await f.close();
  }
});
