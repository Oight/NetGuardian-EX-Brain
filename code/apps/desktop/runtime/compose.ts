import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  fail,
  ok,
  type CallContext,
  type ClockPort,
  type HostCapability,
  type HttpPort,
  type IdPort,
  type Result,
} from "@campussec/contracts";
import { createStorage } from "@campussec/storage";
import { createCaseService } from "@campussec/core/cases";
import { createWazuhAdapter } from "@campussec/wazuh-adapter";
import { createSecretStore, type SecretProtection } from "../main/secrets.js";
import {
  createDesktopFacade,
  type FacadeDependencies,
  type RuntimeServices,
} from "./facade.js";
import {
  createBackgroundScheduler,
  deactivateRuntime,
  recoverRuntime,
  type RecoveryActions,
} from "./recovery.js";
export async function composeRuntime(input: {
  dataDir: string;
  spaceId: string;
  principalId: string;
  identityEpoch: number;
  protection: SecretProtection;
  clock?: ClockPort;
  ids?: IdPort;
  services?: RuntimeServices;
  http?: HttpPort;
  recovery?: RecoveryActions;
  background?: {
    name: string;
    intervalMs: number;
    run(): Promise<Result<unknown>>;
  }[];
  setTray?: FacadeDependencies["setTray"];
  saveExport?: FacadeDependencies["saveExport"];
  invalidateConnection?: FacadeDependencies["invalidateConnection"];
}) {
  const clock = input.clock ?? {
    now: () => new Date().toISOString(),
    monotonicMs: () => performance.now(),
  };
  const ids = input.ids ?? { next: () => randomUUID() };
  const storage = await createStorage({ ...input, clock, ids });
  if (!storage.ok) return storage;
  const secrets = createSecretStore({
    directory: join(input.dataDir, "secrets"),
    spaceId: input.spaceId,
    protection: input.protection,
    authorizeOwner: (owner) => owner === input.principalId,
  });
  const ctx = (): CallContext => ({
    actor: {
      spaceId: input.spaceId,
      principalId: input.principalId,
      identityEpoch: input.identityEpoch,
      role: "ui",
    },
    traceId: ids.next(),
  });
  let state: "ready" | "degraded" | "stopping" = "degraded";
  let identityLocked = false;
  const checkedAt = clock.now();
  const hostCapabilities = (): HostCapability[] =>
    [
      "signedApi",
      "dedicatedProfile",
      "isolatedEvidenceChannel",
      "trustedOrigin",
      "asyncDelivery",
      "deliveryReconcile",
    ].map((name) => ({
      name: name as HostCapability["name"],
      state: "unverified",
      version: "unverified",
      checkedAt,
      evidence: "未连接或验收真实宿主",
    }));
  const facade = createDesktopFacade({
    ...input,
    ...storage.value,
    secrets,
    clock,
    ids,
    services: {
      cases: createCaseService({ ...storage.value, clock, ids }).service,
      connections: createWazuhAdapter({
        db: storage.value.db,
        secrets,
        clock,
        ids,
        http: input.http,
      }),
      ...input.services,
    },
    // Every adapter request checks the persisted generation before and after I/O.
    // Background execution is gated by recovery; no transport is started here.
    invalidateConnection:
      input.invalidateConnection ??
      (async (connectionId) =>
        storage.value.db.write(ctx(), (tx) => {
          const connection = tx.get<{
            generation: number;
          }>("SELECT generation FROM connections WHERE id=?", [connectionId]);
          if (!connection) return fail("NOT_FOUND", "连接不存在");
          storage.value.events.appendInTx(tx, ctx(), {
            type: "connection.changed",
            aggregateId: connectionId,
            revision: connection.generation,
            payload: { connectionId, generation: connection.generation },
          });
          return ok(undefined);
        })),
    state: () => state,
    hostCapabilities,
    identityLocked: () => identityLocked,
  });
  const initialized = await facade.initialize(ctx());
  if (!initialized.ok) {
    secrets.close();
    await storage.value.close();
    return initialized;
  }
  const scheduler = createBackgroundScheduler(() => {
    state = "degraded";
  });
  const recovery = input.recovery
    ? await recoverRuntime(input.recovery)
    : fail(
        "CAPABILITY_UNAVAILABLE",
        "S07/S08/S09/S11 尚未装配，后台调查保持关闭",
      );
  if (!recovery.ok && input.recovery) {
    // A failed start may have partially opened a transport. Close it before exposing UI.
    const stopped = await deactivateRuntime(input.recovery);
    if (!stopped.ok) {
      secrets.close();
      await storage.value.close();
      return stopped;
    }
  }
  if (recovery.ok) {
    state = "ready";
    for (const task of input.background ?? [])
      scheduler.start(task.name, task.intervalMs, task.run);
  }
  let closed = false;
  return ok({
    facade,
    context: ctx,
    storage: storage.value,
    secrets,
    recovery,
    async lockIdentity(): Promise<Result<void>> {
      identityLocked = true;
      state = "degraded";
      // Stop admitting new work before awaiting transport shutdown. Do not alter JobState.
      const idle = scheduler.stop();
      try {
        if (input.recovery) {
          const stopped = await deactivateRuntime(input.recovery);
          if (!stopped.ok) return stopped;
        }
      } finally {
        await idle;
      }
      return ok(undefined);
    },
    async close() {
      if (closed) return;
      closed = true;
      state = "stopping";
      const idle = scheduler.stop();
      // Revoke before waiting for in-flight work, so waiting cannot extend tool access.
      try {
        if (input.recovery) {
          const stopped = await deactivateRuntime(input.recovery);
          if (!stopped.ok) throw new Error("Runtime transport shutdown failed");
        }
      } finally {
        await idle;
        secrets.close();
        await storage.value.close();
      }
    },
  });
}
