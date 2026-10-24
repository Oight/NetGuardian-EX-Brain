import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { createOwnedGatewayAuthentication } from "../index.js";
import { setup, system, take, SESSION } from "../../channels/tests/fixtures.js";

test("owned backend authentication binds its bearer to an existing active channel and survives no model-supplied routing", async () => {
  const f = await setup();
  try {
    const channel = take(await f.channels.openChannel(system(), f.run));
    const registry = createOwnedGatewayAuthentication(f.deps);
    const register = () =>
      registry.register({
        ctx: system(),
        channelId: channel.id,
        secretRef: channel.secretRef,
        bindingId: SESSION,
        allowedTools: ["get_case_context"],
      });
    assert.equal((await register()).ok, false);
    take(
      await f.channels.bindChannel(system(), {
        channelId: channel.id,
        runId: f.run.id,
        trustedSessionBindingId: SESSION,
      }),
    );
    const token = take(await register());
    assert.equal((await register()).ok, false);
    const request = {
      headers: {
        authorization: "Bearer " + token,
        "x-session-id": "model-forged-session",
        "x-role": "system",
      },
    } as unknown as IncomingMessage;
    const admitted = take(await registry.authentication.authenticate(request));
    assert.equal(admitted.context.actor.role, "evidence");
    assert.equal(admitted.context.actor.runId, f.run.id);
    assert.equal(admitted.transportBindingId, SESSION);
    take(await registry.authentication.recheck(admitted));
    assert.equal(
      (
        await registry.authentication.recheck({
          ...admitted,
          allowedTools: ["request_investigation"],
        })
      ).ok,
      false,
    );
    take(await f.channels.revoke(system(), f.run.id));
    assert.equal((await registry.authentication.recheck(admitted)).ok, false);
    assert.equal(
      (await registry.authentication.authenticate(request)).ok,
      false,
    );
  } finally {
    await f.dispose();
  }
});
test("owned gateway registrations cannot be redirected by mutating caller inputs or survive explicit removal", async () => {
  const f = await setup();
  try {
    const channel = take(await f.channels.openChannel(system(), f.run));
    take(
      await f.channels.bindChannel(system(), {
        channelId: channel.id,
        runId: f.run.id,
        trustedSessionBindingId: SESSION,
      }),
    );
    const registry = createOwnedGatewayAuthentication(f.deps);
    const input = {
      ctx: system(),
      channelId: channel.id,
      secretRef: channel.secretRef,
      bindingId: SESSION,
      allowedTools: ["get_case_context"],
    };
    const token = take(await registry.register(input));
    input.allowedTools.push("request_investigation");
    input.ctx.actor.principalId = "00000000-0000-4000-8000-000000000001";
    const req = {
      headers: { authorization: "Bearer " + token },
    } as IncomingMessage;
    const admitted = take(await registry.authentication.authenticate(req));
    assert.deepEqual(admitted.allowedTools, ["get_case_context"]);
    registry.unregister(SESSION);
    assert.equal((await registry.authentication.recheck(admitted)).ok, false);
    assert.equal((await registry.authentication.authenticate(req)).ok, false);
  } finally {
    await f.dispose();
  }
});
