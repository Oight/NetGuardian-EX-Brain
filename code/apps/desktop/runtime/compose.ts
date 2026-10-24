import { createDeliveryRecovery } from "@campussec/core/delivery/recovery";
import { createPolicyReader } from "@campussec/core/alerts/policy-reader";
import { createInvestigationHistory, createReportAnchors } from "@campussec/core/requests/read-model";
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
import {
  createReportService,
  createResultPackageReader,
} from "@campussec/core/reports";
import { createDeliveryService } from "@campussec/core/delivery";
import { createRequestService } from "@campussec/core/requests";
import { createRunBudget } from "@campussec/core/requests/budgets";
import {
  createInvestigationTools,
  createToolReplyAtomic,
} from "@campussec/core/investigations/tools";
import { createRetentionService } from "@campussec/core/investigations/retention";
import { createReviewPublication } from "@campussec/core/investigations/publication";
import { createAlertService } from "@campussec/core/alerts";
import {
  createMcpGateway,
  type GatewayAuthentication,
} from "@campussec/mcp-server/gateway";
import { createEvidenceChannels } from "@campussec/mcp-server/channels";
import {
  createHostAccess,
  type HostWire,
} from "@campussec/teleagent-bridge/host-access";
import {
  createExecutionDriver,
  type ExecutionWire,
} from "@campussec/teleagent-bridge/execution";
import { PROFILE_MANIFEST } from "@campussec/investigation-profile";
import { createWazuhAdapter, type AdapterDependencies } from "@campussec/wazuh-adapter";
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
  databaseProtection?: {encrypt(text:string):Uint8Array;decrypt(bytes:Uint8Array):string};
  clock?: ClockPort;
  ids?: IdPort;
  services?: RuntimeServices;
  http?: HttpPort;
  externalPlatform?: AdapterDependencies["external"];
  deliveryRetrySafety?: import("@campussec/contracts").DeliveryRetrySafetyPort;
  hostWire?: HostWire;
  executionWire?: ExecutionWire;
  gatewayAuthentication?: GatewayAuthentication;
  notification?: import("@campussec/contracts").NotificationPort;
  backgroundEnabled?: boolean;
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
  const storage = await createStorage({ ...input, clock, ids,encryption:input.databaseProtection });
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
  const cases = createCaseService({ ...storage.value, clock, ids });
  const reports = createReportService({
    ...storage.value,
    clock,
    ids,
    cases: cases.service,
    casesAtomic: cases.atomic,
    anchors: createReportAnchors(),
  });
  const systemCtx = (): CallContext => ({
    traceId: ids.next(),
    actor: {
      spaceId: input.spaceId,
      principalId: input.principalId,
      identityEpoch: input.identityEpoch,
      role: "system",
    },
  });
  const connections = createWazuhAdapter({
    db: storage.value.db,
    secrets,
    clock,
    ids,
    http: input.http,
    external: input.externalPlatform,
  });
  const results = createResultPackageReader({ anchors: createReportAnchors() });
  const host = createHostAccess({
    db: storage.value.db,
    clock,
    wire: input.hostWire,
  });
  const execution = createExecutionDriver({
    db: storage.value.db,
    clock,
    ids,
    wire: input.executionWire,
  });
  const channels = createEvidenceChannels({
    db: storage.value.db,
    secrets,
    clock,
    ids,
  });
  const delivery = createDeliveryService({
    ...storage.value,
    clock,
    ids,
    hostDelivery: host,
    results,
  });
  const budget = createRunBudget({ db: storage.value.db, clock, ids });
  const requests = createRequestService({
    ...storage.value,
    clock,
    ids,
    cases: cases.atomic,
    connections,
    execution,
    channels,
    profiles: reports,
    reports,
    delivery: delivery.service,
    subscriptions: delivery.atomic,
    budget: budget.atomic,
    profileVersion: PROFILE_MANIFEST.version,
  });
  const tools = createInvestigationTools({
    ...storage.value,
    clock,
    ids,
    budget: budget.budget,
    budgetAtomic: budget.atomic,
    query: connections,
    casesAtomic: cases.atomic,
    proposals: reports,
  });
  const alerts = createAlertService({
    ...storage.value,
    clock,
    ids,
    cases: cases.atomic,
    connections,
    query: connections,
    requests: requests.atomic,
    notification: input.notification ?? {
      show: async () => fail("CAPABILITY_UNAVAILABLE", "未配置本地通知提供者"),
    },
    revokeRun: (ctx, runId) => channels.revoke(ctx, runId),
  });
  const gateway = createMcpGateway({
    clock,
    channels,
    delegationCommands: requests.service,
    delegationReads: requests.service,
    scope: connections,
    results: delivery.service,
    origins: host,
    tools,
    authentication: input.gatewayAuthentication ?? {
      authenticate: async () => fail("UNAUTHENTICATED", "缺少可信宿主传输"),
      recheck: async () => fail("FORBIDDEN", "缺少可信宿主传输"),
    },
  });
  const retention = createRetentionService({
    db: storage.value.db,
    cases: cases.atomic,
    replies: createToolReplyAtomic(),
  });
  const publication = createReviewPublication({
    db: storage.value.db,
    reports,
    results,
    delivery: delivery.service,
    subscriptions: delivery.atomic,
  });
  const facade = createDesktopFacade({
    ...input,
    ...storage.value,
    secrets,
    clock,
    ids,
    services: {
      cases: cases.service,
      reports,
      connections,
      requests: requests.service,
      delivery: delivery.service,
      alerts,
      retention,
      publication,
      deliveryRecovery: createDeliveryRecovery({...storage.value, clock, host, results, retrySafety: input.deliveryRetrySafety ?? {canRetryAbsent: async () => fail("CAPABILITY_UNAVAILABLE", "宿主未提供相同投递键安全重试保证")}}),
      policies: createPolicyReader(storage.value),
      history: createInvestigationHistory({db: storage.value.db, casesAtomic: cases.atomic}),
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
  const recoveryActions: RecoveryActions = input.recovery ?? {
    revokeGrants: () => channels.revokeAll(systemCtx()),
    verifyIdentity: async () => {
      const checked = await storage.value.db.read(systemCtx(), (tx) =>
        tx.get<{
          space_id: string;
          principal_id: string;
          identity_epoch: number;
        }>("SELECT * FROM space_metadata"),
      );
      if (!checked.ok) return checked;
      return checked.value?.space_id === input.spaceId &&
        checked.value.principal_id === input.principalId &&
        checked.value.identity_epoch === input.identityEpoch
        ? ok(undefined)
        : fail("IDENTITY_CHANGED", "恢复时主体元数据不一致");
    },
    reconcileRequests: () => requests.recover(systemCtx()),
    reconcileDeliveries: () => delivery.recover(systemCtx()),
    startGateway: async () => {
      if (!input.gatewayAuthentication)
        return fail(
          "CAPABILITY_UNAVAILABLE",
          "宿主可信通道尚未配置，MCP 网络入口保持关闭",
        );
      const started = await gateway.start(systemCtx());
      return started.ok ? ok(undefined) : started;
    },
    stopGateway: () => gateway.stop(systemCtx()),
  };
  const recovery = await recoverRuntime(recoveryActions);
  if (!recovery.ok) {
    const stopped = await deactivateRuntime(recoveryActions);
    if (!stopped.ok) {
      secrets.close();
      await storage.value.close();
      return stopped;
    }
  }
  if (recovery.ok) state = "ready";
  if (input.backgroundEnabled !== false) {
    scheduler.start("requests", 1000, () => requests.service.tick(systemCtx()));
    scheduler.start("delivery", 5000, () => delivery.service.tick(systemCtx()));
    scheduler.start("alerts", 10000, async () => {
      const listed = await connections.list(systemCtx());
      if (!listed.ok) return listed;
      for (const p of listed.value) {
        if (!p.indexerSecretRef && !input.externalPlatform?.matches(p)) continue;
        const polled = await alerts.pollOnce(systemCtx(), p.id);
        if (!polled.ok) return polled;
      }
      return alerts.flushCandidates(systemCtx());
    });
    if (recovery.ok)
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
    services: {
      requests: requests.service,
      delivery: delivery.service,
      alerts,
      tools,
      channels,
      reports,
      retention,
      publication,
      host,
      gateway,
    },
    async lockIdentity(): Promise<Result<void>> {
      identityLocked = true;
      state = "degraded";
      // Stop admitting new work before awaiting transport shutdown. Do not alter JobState.
      const idle = scheduler.stop();
      try {
        if (recoveryActions) {
          const stopped = await deactivateRuntime(recoveryActions);
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
        if (recoveryActions) {
          const stopped = await deactivateRuntime(recoveryActions);
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
