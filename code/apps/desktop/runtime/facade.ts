import { X509Certificate } from "node:crypto";
import { fail, idSchema, internalError, ok, parseDesktopOutput, parseRpcRequest, parseRpcResponse, type AlertService, type CallContext, type CaseService, type ClockPort, type ConnectionProfile, type ConnectionService, type DatabasePort, type DeliveryService, type DesktopMethodMap, type EventPort, type HostCapability, type IdPort, type ReportService, type RequestService, type Result, type RetentionService, type ReviewPublicationPort, type RpcRequest, type RpcResponse, type SecretPort, } from "@campussec/contracts";
import { createSettings } from "./settings.js";
import { readWorkspace } from "./workspace.js";
export interface RuntimeServices {
    connections?: ConnectionService;
    cases?: CaseService;
    requests?: RequestService;
    reports?: ReportService;
    delivery?: DeliveryService;
    alerts?: AlertService;
    retention?: RetentionService;
    publication?: ReviewPublicationPort;
}
export interface FacadeDependencies {
    db: DatabasePort;
    events: EventPort;
    secrets: SecretPort;
    clock: ClockPort;
    ids: IdPort;
    services: RuntimeServices;
    state(): "ready" | "degraded" | "stopping";
    hostCapabilities(): HostCapability[];
    identityLocked?(): boolean;
    setTray?(enabled: boolean): Promise<Result<void>>;
    invalidateConnection?(connectionId: string): Promise<Result<void>>;
    saveExport?(value: {
        filename: string;
        mediaType: string;
        text: string;
    }): Promise<Result<void>>;
}
type Handlers = {
    [K in keyof DesktopMethodMap]: (ctx: CallContext, input: DesktopMethodMap[K]["input"]) => Promise<Result<DesktopMethodMap[K]["output"]>>;
};
const unavailable = <T>(): Promise<Result<T>> => Promise.resolve(fail("CAPABILITY_UNAVAILABLE", "所需业务模块尚未实现或未装配"));
export function createDesktopFacade(deps: FacadeDependencies) {
    const settings = createSettings(deps);
    const services = deps.services;
    async function profile(ctx: CallContext, id: string, generation: number): Promise<Result<ConnectionProfile>> {
        if (!services.connections)
            return unavailable();
        const all = await services.connections.list(ctx);
        if (!all.ok)
            return all;
        const value = all.value.find((p) => p.id === id && p.spaceId === ctx.actor.spaceId);
        if (!value)
            return fail("NOT_FOUND", "连接不存在");
        return value.generation === generation
            ? ok(value)
            : fail("REVISION_CONFLICT", "连接已改变");
    }
    async function replaceSecret(ctx: CallContext, input: {
        connectionId: string;
        expectedGeneration: number;
        purpose: string;
        value: Uint8Array;
        persist: boolean;
        field: "indexerSecretRef" | "serverSecretRef" | "caRef";
    }): Promise<Result<{
        generation: number;
    }>> {
        if (!services.connections || !deps.invalidateConnection)
            return unavailable();
        const original = await profile(ctx, input.connectionId, input.expectedGeneration);
        if (!original.ok)
            return original;
        const created = await deps.secrets.put({
            owner: ctx.actor.principalId,
            purpose: input.purpose,
            value: input.value,
            persist: input.persist,
        });
        if (!created.ok)
            return created;
        const { generation, updatedAt: _updatedAt, ...rest } = original.value;
        let saved: Result<ConnectionProfile>;
        try {
            saved = await services.connections.save(ctx, {
                ...rest,
                [input.field]: created.value,
                expectedGeneration: generation,
            });
        }
        catch {
            await deps.secrets.remove(created.value);
            return { ok: false, error: internalError() };
        }
        if (!saved.ok) {
            await deps.secrets.remove(created.value);
            return saved;
        }
        const invalidated = await deps.invalidateConnection(input.connectionId);
        if (!invalidated.ok)
            return invalidated;
        const oldRef = original.value[input.field];
        if (oldRef) {
            const removed = await deps.secrets.remove(oldRef);
            if (!removed.ok)
                return removed;
        }
        return ok({ generation: saved.value.generation });
    }
    const handlers: Handlers = {
        "runtime.status": async (ctx) => {
            const value = await settings.read(ctx);
            return value.ok
                ? ok({
                    state: deps.state(),
                    spaceId: ctx.actor.spaceId,
                    hostCapabilities: deps.hostCapabilities(),
                    trayEnabled: value.value.trayEnabled,
                })
                : value;
        },
        "runtime.settings": (ctx) => settings.read(ctx),
        "runtime.configure": async (ctx, input) => {
            const result = await settings.configure(ctx, input);
            if (!result.ok)
                return result;
            if (deps.setTray) {
                const tray = await deps.setTray(result.value.trayEnabled);
                if (!tray.ok)
                    return tray;
            }
            return result;
        },
        "runtime.setTray": async (ctx, input) => {
            const existing = await settings.read(ctx);
            if (!existing.ok)
                return existing;
            const { revision, ...rest } = existing.value;
            const result = await settings.configure(ctx, {
                expectedRevision: revision,
                settings: { ...rest, trayEnabled: input.enabled },
            });
            if (!result.ok)
                return result;
            if (deps.setTray) {
                const tray = await deps.setTray(input.enabled);
                if (!tray.ok)
                    return tray;
            }
            return ok({ enabled: result.value.trayEnabled });
        },
        "workspace.snapshot": (ctx, input) => readWorkspace(deps.db, deps.clock, ctx, input.connectionId),
        "events.read": (ctx, input) => deps.events.read(ctx, input),
        "connections.list": async (ctx) => {
            if (!services.connections)
                return unavailable();
            const result = await services.connections.list(ctx);
            return result.ok
                ? ok(result.value.map(({ id, displayName, generation }) => ({
                    id,
                    displayName,
                    generation,
                })))
                : result;
        },
        "connections.capabilities": (ctx, input) => services.connections
            ? services.connections.capabilities(ctx, input.connectionId, input.refresh)
            : unavailable(),
        "connections.agents": (ctx, input) => services.connections
            ? services.connections.agents(ctx, input)
            : unavailable(),
        "devices.detail": (ctx, input) => {
            if (!services.connections)
                return unavailable();
            let attempts = 0;
            return services.connections.deviceDetail(ctx, input, {
                signal: AbortSignal.timeout(10000),
                beforeAttempt: async () => ++attempts <= 20
                    ? ok(undefined)
                    : fail("BUDGET_EXHAUSTED", "后台请求预算耗尽"),
            });
        },
        "connections.configure": async (ctx, input) => {
            if (!services.connections || !deps.invalidateConnection)
                return unavailable();
            const previous = input.id
                ? await profile(ctx, input.id, input.expectedGeneration ?? 0)
                : undefined;
            if (previous && !previous.ok)
                return previous;
            const id = input.id ?? deps.ids.next();
            const { generation: _generation, updatedAt: _updatedAt, ...old } = previous?.ok ? previous.value : { generation: 0, updatedAt: "" };
            const result = await services.connections.save(ctx, {
                ...old,
                ...input,
                id,
                spaceId: ctx.actor.spaceId,
                principalFingerprint: previous?.ok
                    ? previous.value.principalFingerprint
                    : `unverified:${id}`,
            });
            if (!result.ok)
                return result;
            const invalidated = await deps.invalidateConnection(id);
            if (!invalidated.ok)
                return invalidated;
            return ok({ id: result.value.id, generation: result.value.generation });
        },
        "connections.setCredential": async (ctx, input) => {
            const value = new TextEncoder().encode(JSON.stringify({ username: input.username, password: input.password }));
            try {
                return await replaceSecret(ctx, {
                    ...input,
                    purpose: `wazuh:${input.endpoint}:${input.connectionId}`,
                    value,
                    field: input.endpoint === "indexer"
                        ? "indexerSecretRef"
                        : "serverSecretRef",
                });
            }
            finally {
                value.fill(0);
            }
        },
        "connections.setCa": async (ctx, input) => {
            try {
                const blocks = input.certificatePem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
                if (!blocks?.length ||
                    input.certificatePem
                        .replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g, "")
                        .trim())
                    return fail("INVALID_INPUT", "只接受 PEM 证书");
                for (const block of blocks)
                    new X509Certificate(block);
            }
            catch {
                return fail("INVALID_INPUT", "PEM 证书无效");
            }
            return replaceSecret(ctx, {
                ...input,
                purpose: `ca:${input.connectionId}`,
                value: new TextEncoder().encode(input.certificatePem),
                persist: true,
                field: "caRef",
            });
        },
        "alerts.list": (ctx, input) => services.alerts ? services.alerts.list(ctx, input) : unavailable(),
        "alerts.markRead": async (ctx, input) => {
            if (!services.alerts)
                return unavailable();
            const result = await services.alerts.markRead(ctx, input.alertIds);
            return result.ok ? ok(null) : result;
        },
        "alerts.setPolicy": (ctx, input) => services.alerts ? services.alerts.setPolicy(ctx, input) : unavailable(),
        "statistics.alerts": (ctx, input) => {
            if (!services.connections)
                return unavailable();
            let attempts = 0;
            return services.connections.statistics(ctx, input, {
                signal: AbortSignal.timeout(10000),
                beforeAttempt: async () => ++attempts <= 20
                    ? ok(undefined)
                    : fail("BUDGET_EXHAUSTED", "后台请求预算耗尽"),
            });
        },
        "cases.list": (ctx, input) => services.cases ? services.cases.list(ctx, input) : unavailable(),
        "cases.create": (ctx, input) => services.cases ? services.cases.create(ctx, input) : unavailable(),
        "cases.snapshot": (ctx, input) => services.cases ? services.cases.snapshot(ctx, input) : unavailable(),
        "evidence.get": (ctx, input) => services.cases ? services.cases.evidence(ctx, input) : unavailable(),
        "cases.putContext": (ctx, input) => services.cases ? services.cases.putContext(ctx, input) : unavailable(),
        "cases.setStatus": (ctx, input) => services.cases ? services.cases.setStatus(ctx, input) : unavailable(),
        "cases.moveEvidence": (ctx, input) => services.cases ? services.cases.moveEvidence(ctx, input) : unavailable(),
        "retention.preview": (ctx, input) => services.retention
            ? services.retention.preview(ctx, input)
            : unavailable(),
        "retention.apply": (ctx, input) => services.retention ? services.retention.apply(ctx, input) : unavailable(),
        "requests.create": (ctx, input) => {
            if (input.origin !== "client_user" ||
                input.originBindingId !== undefined ||
                input.autoCandidateId !== undefined)
                return Promise.resolve(fail("FORBIDDEN", "客户端不能伪造自动或委派来源"));
            return services.requests
                ? services.requests.create(ctx, input)
                : unavailable();
        },
        "requests.provideInput": (ctx, input) => services.requests
            ? services.requests.provideInput(ctx, input)
            : unavailable(),
        "requests.status": (ctx, input) => services.requests
            ? services.requests.status(ctx, input.requestId)
            : unavailable(),
        "investigations.snapshot": (ctx, input) => services.requests
            ? services.requests.runSnapshot(ctx, input.runId)
            : unavailable(),
        "requests.cancel": (ctx, input) => services.requests ? services.requests.cancel(ctx, input) : unavailable(),
        "requests.resume": (ctx, input) => services.requests ? services.requests.resume(ctx, input) : unavailable(),
        "requests.abandon": (ctx, input) => services.requests ? services.requests.abandon(ctx, input) : unavailable(),
        "requests.reconcile": (ctx, input) => services.requests
            ? services.requests.reconcile(ctx, input)
            : unavailable(),
        "reports.review": (ctx, input) => services.reports ? services.reports.review(ctx, input) : unavailable(),
        "results.publishReview": (ctx, input) => services.publication
            ? services.publication.publishReview(ctx, input)
            : unavailable(),
        "reports.list": (ctx, input) => services.reports
            ? services.reports.list(ctx, input.caseId)
            : unavailable(),
        "followups.list": (ctx, input) => services.reports
            ? services.reports.followups(ctx, input.caseId)
            : unavailable(),
        "followups.search": (ctx, input) => services.reports
            ? services.reports.searchFollowups(ctx, input)
            : unavailable(),
        "followups.put": (ctx, input) => services.reports
            ? services.reports.putFollowup(ctx, input)
            : unavailable(),
        "cases.export": async (ctx, input) => {
            if (!services.reports || !deps.saveExport)
                return unavailable();
            const result = await services.reports.export(ctx, input);
            if (!result.ok)
                return result;
            const filename = result.value.filename
                .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
                .replace(/^\.+/, "_");
            const saved = await deps.saveExport({ ...result.value, filename });
            return saved.ok ? ok({ ...result.value, filename }) : saved;
        },
        "results.get": (ctx, input) => services.delivery
            ? services.delivery.getResult(ctx, input)
            : unavailable(),
        "deliveries.status": (ctx, input) => services.delivery
            ? services.delivery.status(ctx, input.requestId)
            : unavailable(),
    };
    return {
        initialize: (ctx: CallContext) => settings.initialize(ctx),
        async invoke<K extends keyof DesktopMethodMap>(ctx: CallContext, raw: RpcRequest<K>): Promise<RpcResponse<DesktopMethodMap[K]["output"]>> {
            const responseId = idSchema.safeParse(raw?.requestId).success
                ? raw.requestId
                : deps.ids.next();
            const response = (result: Result<DesktopMethodMap[K]["output"]>): RpcResponse<DesktopMethodMap[K]["output"]> => ({
                protocolVersion: "0.1.0",
                requestId: responseId,
                result,
            });
            if (ctx.actor.role !== "ui")
                return response(fail("FORBIDDEN", "桌面入口只允许可信用户上下文"));
            // Also verify the actor against storage before invoking any external service.
            const identity = await deps.db.read(ctx, () => true);
            if (!identity.ok)
                return response(identity);
            const parsed = parseRpcRequest(raw);
            if (!parsed.ok)
                return response(parsed);
            if (deps.state() === "stopping")
                return response(fail("HOST_UNAVAILABLE", "应用正在停止受理"));
            const reads = new Set([
                "runtime.status",
                "runtime.settings",
                "workspace.snapshot",
                "events.read",
                "cases.list",
                "cases.snapshot",
                "evidence.get",
                "requests.status",
                "investigations.snapshot",
                "reports.list",
                "followups.list",
                "followups.search",
                "results.get",
                "deliveries.status",
                "requests.cancel",
                "requests.abandon",
            ]);
            if (deps.identityLocked?.() && !reads.has(parsed.value.method))
                return response(fail("IDENTITY_CHANGED", "身份已经改变，已停止受理新工作；旧轮次仍需核实或明确放弃"));
            try {
                const method = parsed.value.method as K;
                const handler = handlers[method] as Handlers[K];
                const result = await handler(ctx, parsed.value.payload as DesktopMethodMap[K]["input"]);
                const output = parseRpcResponse(method, responseId, response(result));
                return output.ok
                    ? output.value
                    : response({ ok: false, error: internalError() });
            }
            catch {
                return response({ ok: false, error: internalError() });
            }
        },
    };
}
