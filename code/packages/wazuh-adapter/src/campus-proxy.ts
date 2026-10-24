import { fail, ok, type Result } from '@campussec/contracts';
import type { Dependencies } from './connections.js';
import { object, field, count } from './mapping.js';
export const CAMPUS_PROXY_MAPPING = 'campus-mui-v1';
/** campusguard-mui owns Wazuh authentication and TLS. No environment file or credential is read here.
 * The fixed loopback URL is supplied by Main/server, never by an RPC payload. Proxy account identity,
 * cache freshness and inner HTTP attempts cannot be independently established by this adapter.
 */
export function createCampusProxy(input: {
    baseUrl?: string;
    fetch?: typeof fetch;
} = {}): NonNullable<Dependencies['external']> {
    const base = new URL(input.baseUrl ?? 'http://127.0.0.1:4173');
    if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.pathname !== '/' || base.search || base.hash || base.username || base.password)
        throw new Error('Campus proxy must be a fixed IPv4 loopback origin');
    const send = input.fetch ?? fetch;
    async function get(path: string, params: Record<string, string>, signal: AbortSignal): Promise<Result<Record<string, unknown>>> {
        const url = new URL(path, base);
        url.search = new URLSearchParams(params).toString();
        try {
            const response = await send(url, {
                method: 'GET', headers: { 'X-Campus-SOC': '1' }, redirect: 'error', cache: 'no-store', signal
            });
            const text = await response.text();
            if (text.length > 4 * 1024 * 1024)
                return fail('PARTIAL_RESULT', '代理响应超过大小限制');
            const body = object(JSON.parse(text));
            if (!response.ok || body.status === 'error') {
                if (response.status === 401 || body.code === 'AUTH')
                    return fail('UPSTREAM_AUTH', 'Wazuh 代理认证失败');
                if (response.status === 403)
                    return fail('UPSTREAM_DENIED', 'Wazuh 代理拒绝读取');
                if (body.code === 'CONFIG')
                    return fail('CAPABILITY_UNAVAILABLE', 'Wazuh 代理尚未配置');
                if (body.code === 'TIMEOUT')
                    return fail('UPSTREAM_TIMEOUT', 'Wazuh 代理查询超时');
                return fail('UPSTREAM_UNAVAILABLE', 'Wazuh 代理读取失败');
            }
            return ok(body);
        }
        catch {
            return signal.aborted ? fail('CANCELLED', '代理请求已取消或超时') : fail('UPSTREAM_UNAVAILABLE', '无法读取本机 Wazuh 代理');
        }
    }
    function serverPage(raw: Record<string, unknown>, parameters: Record<string, string>, whole = false): Result<Record<string, unknown>> {
        if (!Array.isArray(raw.data) || !Number.isSafeInteger(raw.total) || Number(raw.total) < 0 || !['ok', 'partial'].includes(String(raw.status)))
            return fail('PARTIAL_RESULT', '代理清单结构无效');
        const offset = Number(parameters.offset ?? 0), limit = Number(parameters.limit ?? 50);
        const rows = whole ? raw.data.slice(offset, offset + limit) : raw.data;
        return ok({ error: 0, data: {
                affected_items: rows, total_affected_items: raw.total, total_failed_items: raw.status === 'partial' ? 1 : 0
            } });
    }
    return {
        matches: p => p.mappingVersion === CAMPUS_PROXY_MAPPING,
        async request({ kind, segments, parameters, body, signal }) {
            if (kind === 'server') {
                if (segments.length === 1 && segments[0] === 'agents') {
                    const raw = await get('/api/agents', {}, signal);
                    return raw.ok ? serverPage(raw.value, parameters, true) : raw;
                }
                const module = segments[0] === 'syscollector' ? segments[2] : segments[0] === 'syscheck' ? 'fim' : segments[0] === 'sca' ? 'sca' : undefined;
                const agent = segments[1];
                if (!module || !['os', 'hardware', 'packages', 'processes', 'ports', 'fim', 'sca'].includes(module) || !agent || !/^\d{3,8}$/.test(agent) || agent === '000')
                    return fail('CAPABILITY_UNAVAILABLE', '代理不支持该设备类别或 Agent 身份');
                // The reference API permits 10/20/50. Fetch one page then slice; retain native offset.
                const limit = Number(parameters.limit ?? 50), upstreamLimit = [10, 20, 50].find(n => n >= limit) ?? 50;
                const raw = await get(`/api/agents/${agent}/${module}`, { offset: parameters.offset ?? '0', limit: String(upstreamLimit) }, signal);
                if (!raw.ok)
                    return raw;
                const value = serverPage(raw.value, parameters, ['os', 'hardware'].includes(module));
                if (!value.ok)
                    return value;
                const data = object(value.value.data);
                data.affected_items = (data.affected_items as unknown[]).slice(0, limit);
                return value;
            }
            if (segments.length !== 2 || segments[1] !== '_search' || segments[0] !== 'wazuh-alerts-4.x-*')
                return fail('CAPABILITY_UNAVAILABLE', '代理仅适配已核对的告警索引；不支持漏洞或任意索引');
            const query = object(body);
            if (query.size === 0 && !query.aggs && field(query, 'query.match_none')) {
                const raw = await get('/api/events', { size: '10', page: '0' }, signal);
                if (!raw.ok)
                    return raw;
                const data = object(raw.value.data);
                if (!count(data.total) || !Array.isArray(data.items) || raw.value.status !== 'ok')
                    return fail('PARTIAL_RESULT', '代理告警可用性未通过完整结构核实');
                return ok({
                    timed_out: false, _shards: { failed: 0 }, hits: { total: data.total, hits: [] }
                });
            }
            const filters = field(query, 'query.bool.filter');
            const list = Array.isArray(filters) ? filters : [];
            const agents = list.map(v => object(object(v).terms)['agent.id']).find(Array.isArray) as string[] | undefined;
            const range = object(list.map(v => field(v, 'range.timestamp')).find(v => v !== undefined));
            if (!agents?.length || agents.length !== 1 || typeof range.gte !== 'string' || typeof range.lt !== 'string')
                return fail('CAPABILITY_UNAVAILABLE', '代理要求单设备和显式时间范围，不能扩大为全平台');
            const from = Date.parse(range.gte), upper = Date.parse(range.lt);
            if (!Number.isFinite(from) || !Number.isFinite(upper) || upper <= from)
                return fail('INVALID_INPUT', '代理时间范围无效');
            // Reference API uses lte; subtract one millisecond to preserve the canonical [from,to) interval.
            const params = {
                agent: agents[0]!, from: new Date(from).toISOString(), to: new Date(upper - 1).toISOString()
            };
            if (query.aggs) {
                const raw = await get('/api/summary', params, signal);
                if (!raw.ok)
                    return raw;
                const alerts = object(raw.value.alerts), data = object(alerts.data), total = count(data.total);
                if (!['ok', 'partial'].includes(String(alerts.status)) || !total || !Array.isArray(data.levels) || !Array.isArray(data.trend))
                    return fail('UPSTREAM_UNAVAILABLE', '代理统计不可读取，不能解释为零告警');
                // The reference histogram rounds in Asia/Shanghai. These are absolute epoch bucket starts.
                return ok({
                    timed_out: false, _shards: { failed: 0 }, _campusWarnings: ['代理统计缓存、采集覆盖与账号身份未独立核实', ...(object(raw.value.connection).tls === 'lab-exception' ? ['代理报告正在使用实验室 TLS 例外'] : [])], hits: { total, hits: [] }, aggregations: { levels: {
                            buckets: data.levels, sum_other_doc_count: alerts.status === 'partial' ? 1 : 0, doc_count_error_upper_bound: 0
                        }, hours: { buckets: data.trend.map(v => ({ key: object(v).time, doc_count: object(v).count })) } }
                });
            }
            if (query.size === 0) {
                // A real read verifies availability; no synthetic successful permission probe.
                const raw = await get('/api/events', {
                    ...params, size: '10', page: '0'
                }, signal);
                return raw.ok ? ok({
                    timed_out: raw.value.status === 'partial', _shards: { failed: 0 }, hits: { total: object(raw.value.data).total, hits: [] }
                }) : raw;
            }
            const raw = await get('/api/events', {
                ...params, size: '100', page: '0', kind: 'alerts'
            }, signal);
            if (!raw.ok)
                return raw;
            const data = object(raw.value.data);
            if (!Array.isArray(data.items) || !count(data.total) || !['ok', 'partial'].includes(String(raw.value.status)))
                return fail('PARTIAL_RESULT', '代理告警结构无效');
            const ruleIds = list.map(v => object(object(v).terms)['rule.id']).find(Array.isArray) as string[] | undefined;
            const groups = list.map(v => object(object(v).terms)['rule.groups']).find(Array.isArray) as string[] | undefined;
            const min = list.map(v => object(object(object(v).range)['rule.level']).gte).find(v => v !== undefined) as number | undefined;
            const rows = data.items.map(object);
            // Reject scope violations, even if subsequent client filtering would hide them.
            if (rows.some(r => r.agentId !== agents[0] || typeof r.time !== 'number' || r.time < from || r.time >= upper || typeof r.index !== 'string' || !/^wazuh-alerts-[a-zA-Z0-9._-]+$/.test(r.index) || typeof r.documentId !== 'string' || !r.documentId))
                return fail('SCOPE_EXCEEDED', '代理返回了范围外或无原生身份的告警');
            const selected = rows.filter(r => (!ruleIds || ruleIds.includes(String(r.ruleId))) && (!groups || groups.some(g => Array.isArray(r.groups) && r.groups.includes(g))) && (min === undefined || typeof r.level === 'number' && r.level >= min)).slice(0, Number(query.size));
            return ok({
                timed_out: false, _shards: { failed: 0 }, _campusWarnings: ['代理按时间倒序返回首 100 条，稳定分页未核实；筛选后数量不代表全量', '代理缓存、账号身份与内部 HTTP 尝试次数未独立核实'], hits: { total: { value: selected.length, relation: 'gte' }, hits: selected.map(r => ({
                        _index: r.index, _id: r.documentId, _source: {
                            timestamp: new Date(r.time as number).toISOString(), agent: { id: r.agentId, name: r.agentName }, rule: {
                                id: r.ruleId, level: r.level, description: r.title, groups: r.groups
                            }, data: { srcip: r.sourceIP, dstip: r.destinationIP }, decoder: { name: r.decoder }, location: r.location
                        }
                    })) }
            });
        }
    };
}
