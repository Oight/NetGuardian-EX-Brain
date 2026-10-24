import {
  fail,
  ok,
  type AppError,
  type CallContext,
  type ClockPort,
  type EvidenceChannelBindingPort,
  type ExecutionPort,
  type ExecutionSnapshot,
  type HostCapability,
  type IdPort,
  type Result,
} from "@campussec/contracts";
import type { ExecutionControl, ExecutionWire } from "../index.js";
import {
  launchOwnedBackend,
  TELEAGENT_270,
  type OwnedBackend,
  type OwnedBackendOptions,
} from "./launcher.js";
import { backendSessionId, observeMessages, runMarker } from "./messages.js";
import { setTimeout as delay } from "node:timers/promises";
export { createSignedClient, localSigner } from "./client.js";
export { observeMessages, runMarker } from "./messages.js";
export { TELEAGENT_270, launchOwnedBackend } from "./launcher.js";
export type { OwnedBackendOptions } from "./launcher.js";

type StartInput = Parameters<ExecutionPort["start"]>[1];
export interface OwnedWireDependencies {
  options: OwnedBackendOptions;
  clock: ClockPort;
  ids: IdPort;
  channels: EvidenceChannelBindingPort;
  prepareChannel(
    ctx: CallContext,
    channel: StartInput["channel"],
  ): Promise<Result<{ endpoint: string; bearer: string }>>;
  activateChannel(
    ctx: CallContext,
    input: {
      run: StartInput["run"];
      channel: StartInput["channel"];
      sessionId: string;
      bindingId: string;
      allowedTools: string[];
    },
  ): Promise<Result<{ endpoint: string; bearer: string }>>;
  deactivateChannel(bindingId: string): void;
}
type Active = {
  backend: OwnedBackend;
  sessionId: string;
  bindingId: string;
  owner: string;
  epoch: number;
  expectedText: string;
  snapshot?: ExecutionSnapshot;
  timer?: ReturnType<typeof setTimeout>;
};
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
export function createOwnedExecutionWire(d: OwnedWireDependencies) {
  const active = new Map<string, Active>();
  let verified = false,
    closed = false;
  const base = (id: string, sessionId?: string): ExecutionSnapshot => ({
    runId: id,
    ...(sessionId ? { sessionId } : {}),
    phase: "uncertain",
    verification: "unverified",
    observedAt: d.clock.now(),
  });
  const owner = (ctx: CallContext) =>
    ctx.actor.spaceId + ":" + ctx.actor.principalId;
  const notSubmitted = (id: string, error: AppError, sessionId?: string) =>
    ok({
      ...base(id, sessionId),
      phase: "not_submitted" as const,
      verification: "verified" as const,
      error,
    });
  async function read(
    ctx: CallContext,
    id: string,
    known: ExecutionSnapshot,
    control?: ExecutionControl,
  ) {
    const item = active.get(id);
    if (
      !item ||
      item.owner !== owner(ctx) ||
      item.epoch !== ctx.actor.identityEpoch ||
      (known.sessionId && known.sessionId !== item.sessionId)
    )
      return ok({ ...known, ...base(id, known.sessionId) });
    if (item.snapshot) return ok(item.snapshot);
    const response = await item.backend.client.request(
      "GET",
      "/session/" + item.sessionId + "/message",
      undefined,
      control?.signal,
    );
    if (!response.ok) return ok({ ...known, ...base(id, item.sessionId) });
    const snapshot = observeMessages({
      runId: id,
      sessionId: item.sessionId,
      userMessageId: known.userMessageId,
      expectedText: item.expectedText,
      messages: response.value.value,
      now: d.clock.now(),
    });
    if (["completed", "failed", "cancelled"].includes(snapshot.phase)) {
      item.snapshot = snapshot;
      clearTimeout(item.timer);
      d.deactivateChannel(item.bindingId);
      await item.backend.close();
    }
    return ok(snapshot);
  }
  const wire: ExecutionWire = {
    async start(ctx, input, control) {
      if (closed || ctx.actor.role !== "system" || !control)
        return fail(
          "CAPABILITY_UNAVAILABLE",
          "隔离后端需要执行账本与有效系统上下文",
        );
      if (active.has(input.run.id))
        return read(ctx, input.run.id, base(input.run.id), control);
      const pending = await d.prepareChannel(ctx, input.channel);
      if (!pending.ok) return notSubmitted(input.run.id, pending.error);
      const started = await launchOwnedBackend(
        d.options,
        input.profile,
        control.signal,
        pending.value,
      );
      if (!started.ok) return notSubmitted(input.run.id, started.error);
      const backend = started.value;
      let item: Active | undefined;
      let mayHaveSubmitted = false;
      try {
        const config = await backend.client.request(
          "GET",
          "/config",
          undefined,
          control.signal,
        );
        const value = config.ok ? object(config.value.value) : undefined;
        const agent = object(object(value?.agent)?.[TELEAGENT_270.agent]);
        const permission = { "*": "deny", "campussec*": "allow" };
        const mcpConfig = object(value?.mcp);
        const evidenceConfig = object(mcpConfig?.[TELEAGENT_270.server]);
        if (
          !value ||
          agent?.prompt !== input.profile.systemText ||
          JSON.stringify(agent?.permission) !== JSON.stringify(permission) ||
          JSON.stringify(value.permission) !== JSON.stringify(permission) ||
          (value.instructions !== undefined &&
            (!Array.isArray(value.instructions) ||
              value.instructions.length !== 0)) ||
          Object.keys(mcpConfig ?? {}).join(",") !== TELEAGENT_270.server ||
          evidenceConfig?.enabled !== false ||
          evidenceConfig?.url !== pending.value.endpoint
        )
          return notSubmitted(input.run.id, {
            code: "CAPABILITY_UNAVAILABLE",
            message: "后端未确认本轮专用配置与默认拒绝规则",
            retryable: false,
          });
        const session = await backend.client.request(
          "POST",
          "/session",
          {
            title: "campussec " + input.run.id,
          },
          control.signal,
        );
        const data = session.ok
          ? (session.value.value as Record<string, unknown>)
          : undefined;
        if (
          !data ||
          !backendSessionId(data.id) ||
          data.directory !== backend.directory
        )
          return notSubmitted(input.run.id, {
            code: "UNCERTAIN",
            message: "未核实隔离调查会话；本适配器尚未提交模型任务",
            retryable: false,
          });
        const sessionId = data.id;
        const checkpoint = await control.checkpoint({
          ...base(input.run.id, sessionId),
          phase: "not_submitted",
          verification: "verified",
        });
        if (!checkpoint.ok)
          return notSubmitted(input.run.id, checkpoint.error, sessionId);
        const bindingId = d.ids.next();
        const bound = await d.channels.bindChannel(ctx, {
          channelId: input.channel.id,
          runId: input.run.id,
          trustedSessionBindingId: bindingId,
        });
        if (!bound.ok)
          return notSubmitted(input.run.id, bound.error, sessionId);
        const admitted = await d.activateChannel(ctx, {
          run: input.run,
          channel: input.channel,
          sessionId,
          bindingId,
          allowedTools: input.profile.allowedTools,
        });
        if (!admitted.ok)
          return notSubmitted(input.run.id, admitted.error, sessionId);
        if (
          admitted.value.bearer !== pending.value.bearer ||
          admitted.value.endpoint !== pending.value.endpoint
        )
          return notSubmitted(
            input.run.id,
            {
              code: "IDENTITY_CHANGED",
              message: "准备与激活的证据通道不一致",
              retryable: false,
            },
            sessionId,
          );
        const expectedText =
          input.profile.userText + "\n\n" + runMarker(input.run.id);
        item = {
          backend,
          sessionId,
          bindingId,
          owner: owner(ctx),
          epoch: ctx.actor.identityEpoch,
          expectedText,
        };
        item.timer = setTimeout(
          () => {
            d.deactivateChannel(bindingId);
            void backend.close();
          },
          Math.max(
            1,
            Date.parse(input.run.expiresAt) - Date.parse(d.clock.now()),
          ),
        );
        item.timer.unref();
        active.set(input.run.id, item);
        const connected = await backend.client.request(
          "POST",
          "/mcp/" + TELEAGENT_270.server + "/connect",
          undefined,
          control.signal,
        );
        let mcpConnected = false;
        for (
          let attempt = 0;
          connected.ok && attempt < 30 && !control.signal.aborted;
          attempt++
        ) {
          const listed = await backend.client.request(
            "GET",
            "/mcp",
            undefined,
            control.signal,
          );
          const mcp = listed.ok ? object(listed.value.value) : undefined;
          if (
            !mcp ||
            Object.keys(mcp).some((key) => key !== TELEAGENT_270.server)
          )
            break;
          const status = object(mcp[TELEAGENT_270.server])?.status;
          if (status === "connected") {
            mcpConnected = true;
            break;
          }
          if (status === "failed") break;
          await delay(50);
        }
        if (!mcpConnected)
          return notSubmitted(
            input.run.id,
            {
              code: "CAPABILITY_UNAVAILABLE",
              message: "专用证据 MCP 未连接或出现其他工具通道",
              retryable: false,
            },
            sessionId,
          );
        const fenced = await control.checkpoint(base(input.run.id, sessionId));
        if (!fenced.ok)
          return notSubmitted(input.run.id, fenced.error, sessionId);
        verified = true;
        // From this point even a lost HTTP response can mean a real submission.
        mayHaveSubmitted = true;
        await backend.client.request(
          "POST",
          "/session/" + sessionId + "/prompt_async",
          {
            agent: TELEAGENT_270.agent,
            model: {
              providerID: "campussec-model",
              modelID: d.options.model.modelId,
            },
            parts: [{ type: "text", text: expectedText }],
          },
          control.signal,
        );
        let observed = await read(
          ctx,
          input.run.id,
          base(input.run.id, sessionId),
          control,
        );
        for (
          let attempt = 0;
          observed.ok &&
          !observed.value.userMessageId &&
          attempt < 20 &&
          !control.signal.aborted;
          attempt++
        ) {
          await delay(50);
          observed = await read(
            ctx,
            input.run.id,
            base(input.run.id, sessionId),
            control,
          );
        }
        if (observed.ok && observed.value.userMessageId) {
          const saved = await control.checkpoint(observed.value);
          if (!saved.ok)
            return ok({
              ...observed.value,
              phase: "uncertain",
              verification: "unverified",
            });
        }
        return observed;
      } finally {
        if (!mayHaveSubmitted) {
          if (item) {
            clearTimeout(item.timer);
            active.delete(input.run.id);
            d.deactivateChannel(item.bindingId);
          }
          await backend.close();
        }
      }
    },
    inspect: read,
    async abort(ctx, id, known, control) {
      const item = active.get(id);
      if (
        !item ||
        item.owner !== owner(ctx) ||
        item.epoch !== ctx.actor.identityEpoch ||
        (known.sessionId && known.sessionId !== item.sessionId)
      )
        return ok({ ...known, ...base(id, known.sessionId) });
      if (!item.snapshot)
        await item.backend.client.request(
          "POST",
          "/session/" + item.sessionId + "/abort",
          undefined,
          control?.signal,
        );
      // An accepted abort is not an observed cancellation.
      return read(ctx, id, known, control);
    },
  };
  return {
    wire,
    capabilities(): HostCapability[] {
      return ["signedApi", "dedicatedProfile", "isolatedEvidenceChannel"].map(
        (name) => ({
          name: name as HostCapability["name"],
          state: verified && !closed ? "available" : "unverified",
          version: "TeleAgent/" + TELEAGENT_270.version + "/owned",
          checkedAt: d.clock.now(),
          evidence: verified
            ? "本应用独占后端已核实签名、专用配置与受限 MCP 连接"
            : "尚未运行本机独占后端核实",
        }),
      );
    },
    async close() {
      closed = true;
      for (const item of active.values()) {
        clearTimeout(item.timer);
        d.deactivateChannel(item.bindingId);
      }
      await Promise.all(
        [...active.values()].map((item) => item.backend.close()),
      );
      active.clear();
    },
  };
}
