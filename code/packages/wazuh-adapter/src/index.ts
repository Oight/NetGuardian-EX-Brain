import { fail, ok, type Capability, type ConnectionService, type Result } from '@campussec/contracts';
import { createConnections, type Dependencies } from './connections.js';
import { createQueries } from './queries.js';
import { number, object } from './mapping.js';
export function createWazuhAdapter(deps: Dependencies): ConnectionService {
    const connections = createConnections(deps), queries = createQueries(deps, connections);
    const capabilities: ConnectionService['capabilities'] = async (ctx, id, refresh) => {
        const profile = await connections.get(ctx, id);
        if (!profile.ok)
            return profile;
        const p = profile.value;
        const defaults: Capability[] = (['alerts', 'archives', 'authentication_events', 'agents', 'inventory_os', 'inventory_hardware', 'inventory_packages', 'inventory_processes', 'inventory_ports', 'fim_objects', 'fim_events', 'sca', 'vulnerabilities', 'stable_alert_pagination'] as const).map(name => ({ name, state: 'unverified', checkedAt: deps.clock.now(), endpointKind: ['agents', 'sca', 'fim_objects'].includes(name) || name.startsWith('inventory_') ? 'server' : 'indexer', evidence: '尚无当前连接代次的核实证据' }));
        if (refresh) {
            const operation = connections.operation(ctx, p);
            let agentId: string | undefined;
            for (const value of defaults) {
                if (['authentication_events', 'fim_events', 'stable_alert_pagination'].includes(value.name)) {
                    value.evidence = '字段映射或稳定分页未核实，不能由基础权限探测推定';
                    continue;
                }
                if (value.name === 'archives' && !p.archivesPattern) {
                    value.evidence = '归档索引未配置';
                    continue;
                }
                let response: Result<Record<string, unknown>>;
                if (value.endpointKind === 'indexer')
                    response = await operation.request('indexer', [value.name === 'alerts' ? p.alertsPattern : value.name === 'archives' ? p.archivesPattern! : 'wazuh-states-vulnerabilities-*', '_search'], {}, { size: 0, track_total_hits: true, query: { match_none: {} } });
                else {
                    if (value.name !== 'agents' && !agentId) {
                        value.evidence = '尚无可见设备，未探测该类别';
                        continue;
                    }
                    const segments = value.name === 'agents' ? ['agents'] : value.name === 'fim_objects' ? ['syscheck', agentId!] : value.name === 'sca' ? ['sca', agentId!] : ['syscollector', agentId!, value.name.slice('inventory_'.length)];
                    response = await operation.request('server', segments, { limit: '1', offset: '0' });
                }
                if (response.ok) {
                    const body = response.value;
                    const valid = value.endpointKind === 'server' ? body.error === 0 && Array.isArray(object(body.data).affected_items) && number(object(body.data).total_failed_items) === 0 : Array.isArray(object(body.hits).hits) && body.timed_out === false && number(object(body._shards).failed) === 0;
                    if (!valid)
                        response = fail('PARTIAL_RESULT', '响应结构、局部失败或分片状态未通过检查');
                    else if (value.name === 'agents') {
                        const first = object((object(body.data).affected_items as unknown[])[0]);
                        if (typeof first.id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(first.id))
                            agentId = first.id;
                    }
                }
                if (!response.ok && ['CANCELLED', 'IDENTITY_CHANGED'].includes(response.error.code))
                    return response;
                value.state = response.ok ? 'available' : response.error.code === 'UPSTREAM_DENIED' ? 'denied' : response.error.code === 'CAPABILITY_UNAVAILABLE' || response.error.code === 'BUDGET_EXHAUSTED' ? 'unverified' : 'unreachable';
                value.evidence = response.ok ? '当前接口只读结构核实通过；设备类别仅覆盖本次样本，不证明全设备授权' : response.error.code;
                const stored = await connections.storeCapability(ctx, p, value);
                if (!stored.ok)
                    return stored;
            }
        }
        const saved = await deps.db.read(ctx, tx => tx.all<{
            name: Capability['name'];
            state: Capability['state'];
            checked_at: string;
            evidence: string;
            endpoint_kind: Capability['endpointKind'];
        }>('SELECT name,state,checked_at,evidence,endpoint_kind FROM capabilities WHERE connection_id=?', [id]));
        if (!saved.ok)
            return saved;
        const byName = new Map(saved.value.map(row => [row.name, { name: row.name, state: row.state, checkedAt: row.checked_at, evidence: row.evidence, endpointKind: row.endpoint_kind }]));
        return ok(defaults.map(value => byName.get(value.name) ?? value));
    };
    return { list: connections.list, save: connections.save, capabilities, ...queries };
}
