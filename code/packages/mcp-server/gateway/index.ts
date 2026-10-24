import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { canonicalJson, fail, ok, parseDto, parseDesktopInput, idSchema, decodeCursor, encodeCursor, type CallContext, type ClockPort, type ConnectionReadPort, type DeliveryService, type EvidenceChannelPort, type InvestigationToolPort, type JsonObject, type McpGatewayPort, type RequestCommandPort, type RequestReadPort, type Result, type ToolInvocation, type ToolReply, type TrustedOriginPort } from '@campussec/contracts';
export interface TrustedAdmission {
    context: CallContext;
    transportBindingId: string;
    allowedTools: string[];
}
/** Only the host adapter may resolve a request to a registered transport. Tool arguments and HTTP session IDs never establish identity. */
export interface GatewayAuthentication {
    authenticate(request: IncomingMessage): Promise<Result<TrustedAdmission>>;
    recheck(admission: TrustedAdmission): Promise<Result<void>>;
}
export interface GatewayDependencies {
    clock: ClockPort;
    channels: Pick<EvidenceChannelPort, 'revokeAll'>;
    delegationCommands: RequestCommandPort;
    delegationReads: RequestReadPort;
    scope: ConnectionReadPort;
    results: Pick<DeliveryService, 'getResult'>;
    origins: TrustedOriginPort;
    tools: InvestigationToolPort;
    authentication: GatewayAuthentication;
}
import { catalog, delegation } from './catalog.js';
const roleAllows = (ctx: CallContext, name: string) => ctx.actor.role === 'delegation' ? delegation.has(name) : ctx.actor.role === 'evidence' && !delegation.has(name);
export function createMcpGateway(d: GatewayDependencies): McpGatewayPort {
    let server: Server | undefined, endpoint: string | undefined;
    const acknowledgements = new Set<Promise<unknown>>();
    const acknowledge = (ctx: CallContext, input: ToolInvocation, outcome: 'released' | 'uncertain') => { const task = d.tools.acknowledgeReply(ctx, { transportBindingId: input.transportBindingId, callId: input.callId, outcome }).catch(() => undefined); acknowledgements.add(task); void task.finally(() => acknowledgements.delete(task)); return task; };
    async function invoke(ctx: CallContext, input: ToolInvocation): Promise<Result<ToolReply>> {
        const caller = parseDto('CallContext', ctx);
        if (!caller.ok)
            return caller;
        const checked = parseDto('ToolInvocation', input);
        if (!checked.ok)
            return checked;
        const definition = catalog.find(t => t.name === input.toolName);
        if (!definition || !roleAllows(ctx, input.toolName))
            return fail('FORBIDDEN', '工具不属于当前角色');
        if (Object.keys(input.arguments).some(k => !Object.hasOwn(definition.inputSchema.properties, k)))
            return fail('INVALID_INPUT', '工具包含未开放参数');
        if (ctx.actor.role === 'evidence')
            return d.tools.invoke(ctx, input);
        const trustedSystem: CallContext = { traceId: ctx.traceId, actor: { spaceId: ctx.actor.spaceId, principalId: ctx.actor.principalId, identityEpoch: ctx.actor.identityEpoch, role: 'system' } };
        const origin = await d.origins.resolveOrigin(trustedSystem, input.transportBindingId);
        if (!origin.ok)
            return origin;
        if (origin.value.id !== ctx.actor.originBindingId || origin.value.state !== 'active' || origin.value.expiresAt <= d.clock.now())
            return fail('FORBIDDEN', '可信来源与入口不一致');
        const args = input.arguments;
        let result: Result<unknown>;
        switch (input.toolName) {
            case 'list_investigation_scope': {
                const page = parseDto('PageRequest', args.page);
                if (!page.ok)
                    return page;
                if (!args.connectionId) {
                    const queryHash = createHash('sha256').update('investigation-scope:' + ctx.actor.principalId).digest('hex');
                    let after = '';
                    if (page.value.cursor) {
                        const parsed = decodeCursor(page.value.cursor, { spaceId: ctx.actor.spaceId, queryHash });
                        if (!parsed.ok)
                            return parsed;
                        if (typeof parsed.value.lastKeys[0] !== 'string')
                            return fail('CURSOR_INVALID', '范围游标无效');
                        after = parsed.value.lastKeys[0];
                    }
                    const all = await d.scope.list(trustedSystem);
                    if (!all.ok) {
                        result = all;
                        break;
                    }
                    const rows = all.value.filter(c => c.id > after).sort((a, b) => a.id.localeCompare(b.id));
                    const selected = rows.slice(0, page.value.limit);
                    result = ok({ connections: selected.map(c => ({ id: c.id, displayName: c.displayName, generation: c.generation })), ...(rows.length > selected.length ? { nextCursor: encodeCursor({ version: '0.1.0', spaceId: ctx.actor.spaceId, queryHash, lastKeys: [selected.at(-1)!.id] }) } : {}) });
                    break;
                }
                const parsed = parseDesktopInput('connections.agents', { connectionId: args.connectionId, page: args.page });
                if (!parsed.ok)
                    return parsed;
                const agents = await d.scope.agents(trustedSystem, parsed.value);
                if (!agents.ok) {
                    result = agents;
                    break;
                }
                const capabilities = await d.scope.capabilities(trustedSystem, parsed.value.connectionId, false);
                result = capabilities.ok ? ok({ agents: agents.value, capabilities: capabilities.value }) : capabilities;
                break;
            }
            case 'request_investigation': {
                const parsed = parseDto('CreateRequest', { ...args, origin: 'teleagent_user', originBindingId: origin.value.id });
                result = parsed.ok ? await d.delegationCommands.create(ctx, parsed.value) : parsed;
                break;
            }
            case 'provide_investigation_input': {
                const parsed = parseDesktopInput('requests.provideInput', args);
                result = parsed.ok ? await d.delegationCommands.provideInput(ctx, parsed.value) : parsed;
                break;
            }
            case 'get_investigation_status': {
                const parsed = parseDesktopInput('requests.status', args);
                result = parsed.ok ? await d.delegationReads.status(ctx, parsed.value.requestId) : parsed;
                break;
            }
            case 'get_investigation_result': {
                if (!idSchema.safeParse(args.requestId).success || args.resultVersion !== undefined && (!Number.isInteger(args.resultVersion) || Number(args.resultVersion) < 1))
                    return fail('INVALID_INPUT', '结果参数无效');
                result = await d.results.getResult(ctx, { requestId: args.requestId as string, ...(args.resultVersion !== undefined ? { resultVersion: args.resultVersion as number } : {}) });
                break;
            }
            case 'cancel_investigation': {
                const parsed = parseDesktopInput('requests.cancel', args);
                result = parsed.ok ? await d.delegationCommands.cancel(ctx, parsed.value) : parsed;
                break;
            }
            default: return fail('FORBIDDEN', '工具未开放');
        }
        const data: JsonObject = result.ok ? { result: result.value as JsonObject } : { error: { ...result.error } };
        const envelope = { schemaVersion: '0.1.0', status: result.ok ? 'ok' : 'failed', data, warnings: [] };
        const text = canonicalJson(envelope);
        if (Buffer.byteLength(text) > 16384)
            return fail('BUDGET_EXHAUSTED', '结果超过工具回复上限，请使用分页');
        return ok({ isError: !result.ok, text, structured: envelope, preparedProjectionIds: [] });
    }
    return {
        invoke,
        async start(ctx) {
            if (ctx.actor.role !== 'system')
                return fail('FORBIDDEN', '网络入口仅系统可启动');
            if (server)
                return ok({ endpoint });
            const listener = createServer(async (req, res) => {
                const json = (status: number, value: unknown) => {
                    if (res.destroyed)
                        return;
                    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                    res.end(JSON.stringify(value));
                };
                let pending: {
                    ctx: CallContext;
                    input: ToolInvocation;
                } | undefined;
                try {
                    const address = listener.address();
                    const expected = address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : '';
                    if (req.headers.host !== expected || req.headers.origin !== undefined && req.headers.origin !== `http://${expected}`) {
                        json(403, { error: 'untrusted_origin' });
                        return;
                    }
                    if (req.url !== '/mcp') {
                        res.writeHead(404).end();
                        return;
                    }
                    if (req.method !== 'POST') {
                        res.writeHead(405, { Allow: 'POST' }).end();
                        return;
                    }
                    if (!req.headers['content-type']?.startsWith('application/json')) {
                        res.writeHead(415).end();
                        return;
                    }
                    const accept = req.headers.accept ?? '';
                    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
                        res.writeHead(406).end();
                        return;
                    }
                    const version = req.headers['mcp-protocol-version'];
                    if (version !== undefined && version !== '2025-06-18' && version !== '2025-03-26') {
                        res.writeHead(400).end();
                        return;
                    }
                    const admitted = await d.authentication.authenticate(req);
                    if (!admitted.ok) {
                        json(401, { error: admitted.error.code });
                        return;
                    }
                    const admission = admitted.value;
                    if (!parseDto('CallContext', admission.context).ok || !idSchema.safeParse(admission.transportBindingId).success || !['delegation', 'evidence'].includes(admission.context.actor.role) || !Array.isArray(admission.allowedTools)) {
                        json(401, { error: 'invalid_admission' });
                        return;
                    }
                    const chunks: Buffer[] = [];
                    let length = 0;
                    for await (const chunk of req) {
                        length += chunk.length;
                        if (length > 262144) {
                            res.writeHead(413).end();
                            req.resume();
                            return;
                        }
                        chunks.push(Buffer.from(chunk));
                    }
                    let rpc: Record<string, unknown>;
                    try {
                        rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    }
                    catch {
                        json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
                        return;
                    }
                    if (!rpc || Array.isArray(rpc) || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string' || rpc.id !== undefined && typeof rpc.id !== 'string' && typeof rpc.id !== 'number') {
                        json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
                        return;
                    }
                    const id = rpc.id ?? null;
                    if (rpc.id === undefined) {
                        if (rpc.method.startsWith('notifications/'))
                            res.writeHead(202).end();
                        else
                            json(400, { jsonrpc: '2.0', id, error: { code: -32600, message: 'Request id required' } });
                        return;
                    }
                    let value: unknown;
                    if (rpc.method === 'initialize')
                        value = { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'campussec', version: '0.2.0' } };
                    else if (rpc.method === 'ping')
                        value = {};
                    else if (rpc.method === 'tools/list')
                        value = { tools: catalog.filter(t => roleAllows(admission.context, t.name) && admission.allowedTools.includes(t.name)) };
                    else if (rpc.method === 'tools/call') {
                        const params = rpc.params as Record<string, unknown> | undefined;
                        if (!params || typeof params.name !== 'string' || Object.keys(params).some(k => !['name', 'arguments', '_meta'].includes(k)) || !admission.allowedTools.includes(params.name)) {
                            json(400, { jsonrpc: '2.0', id, error: { code: -32602, message: 'Tool not authorized' } });
                            return;
                        }
                        const parsed = parseDto('ToolInvocation', { transportBindingId: admission.transportBindingId, callId: String(id), toolName: params.name, arguments: params.arguments ?? {} });
                        if (!parsed.ok) {
                            json(400, { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid arguments' } });
                            return;
                        }
                        const reply = await invoke(admission.context, parsed.value);
                        if (!reply.ok)
                            value = { isError: true, content: [{ type: 'text', text: canonicalJson({ schemaVersion: '0.1.0', status: 'failed', data: { error: reply.error }, warnings: [] }) }] };
                        else {
                            if (Buffer.byteLength(reply.value.text) > 16384) {
                                json(500, { jsonrpc: '2.0', id, error: { code: -32603, message: 'Tool reply exceeds limit' } });
                                return;
                            }
                            value = { isError: reply.value.isError, content: [{ type: 'text', text: reply.value.text }], ...(reply.value.structured ? { structuredContent: reply.value.structured } : {}) };
                            if (admission.context.actor.role === 'evidence')
                                pending = { ctx: admission.context, input: parsed.value };
                        }
                    }
                    else {
                        json(200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
                        return;
                    }
                    const fence = await d.authentication.recheck(admission);
                    if (!fence.ok) {
                        if (pending)
                            await acknowledge(pending.ctx, pending.input, 'uncertain');
                        json(403, { error: fence.error.code });
                        return;
                    }
                    if (pending && res.destroyed) {
                        await acknowledge(pending.ctx, pending.input, 'uncertain');
                        return;
                    }
                    if (pending) {
                        const ack = pending;
                        let acknowledged = false;
                        const sent = (outcome: 'released' | 'uncertain') => {
                            if (acknowledged)
                                return;
                            acknowledged = true;
                            void acknowledge(ack.ctx, ack.input, outcome);
                        };
                        res.once('finish', () => sent('released'));
                        res.once('close', () => sent('uncertain'));
                    }
                    json(200, { jsonrpc: '2.0', id, result: value });
                }
                catch {
                    if (pending)
                        await acknowledge(pending.ctx, pending.input, 'uncertain');
                    if (!res.headersSent)
                        json(500, { error: 'internal' });
                    else
                        res.destroy();
                }
            });
            listener.requestTimeout = 15000;
            listener.headersTimeout = 10000;
            listener.maxHeadersCount = 32;
            try {
                await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', () => { listener.off('error', reject); resolve(); }); });
                const address = listener.address();
                if (!address || typeof address === 'string')
                    throw new Error();
                server = listener;
                endpoint = `http://127.0.0.1:${address.port}/mcp`;
                return ok({ endpoint });
            }
            catch {
                listener.close();
                return fail('CAPABILITY_UNAVAILABLE', '无法启动回环 MCP 入口');
            }
        },
        async stop(ctx) {
            if (ctx.actor.role !== 'system')
                return fail('FORBIDDEN', '仅系统可停止网络入口');
            const revoked = await d.channels.revokeAll(ctx);
            const active = server;
            server = undefined;
            endpoint = undefined;
            if (active)
                await new Promise<void>(resolve => { active.close(() => resolve()); active.closeAllConnections(); });
            await Promise.all(acknowledgements);
            return revoked;
        },
    };
}
