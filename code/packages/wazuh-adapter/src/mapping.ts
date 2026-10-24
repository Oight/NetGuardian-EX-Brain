import { createHash } from 'node:crypto';
import { type JsonObject, type SourceRecord, type ConnectionProfile, type Count, type Coverage, type Scope } from '@campussec/contracts';
export const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function field(value: unknown, path: string): unknown { let current: unknown = value; for (const key of path.split('.'))
    current = object(current)[key]; return current; }
export const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
export const string = (value: unknown) => typeof value === 'string' && value.length <= 8192 ? value : undefined;
export function instant(value: unknown) { if (typeof value !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value)))
    return undefined; return new Date(value).toISOString(); }
export function count(value: unknown): Count | undefined { if (number(value) !== undefined)
    return { value: value as number, relation: 'eq' }; const v = object(value); return number(v.value) !== undefined && ['eq', 'gte'].includes(String(v.relation)) ? { value: v.value as number, relation: v.relation as Count['relation'] } : undefined; }
export function coverage(scope: Scope, retrievedAt: string, returned: number, reasons: string[], total?: Count): Coverage {
    return { requestedScope: scope, effectiveScope: scope, queryCompleteness: reasons.length ? 'partial' : 'complete', collectionCoverage: 'unknown', sourceTypes: ['wazuh'], reasons, retrievedAt, returned, ...(total ? { total } : {}) };
}
export function indexRecords(p: ConnectionProfile, hits: unknown[], retrievedAt: string, kind: 'alert' | 'authentication' | 'fim' | 'finding' = 'alert') {
    const records: SourceRecord[] = [], warnings: string[] = [];
    const names = ['timestamp', '@timestamp', 'agent.id', 'agent.name', 'rule.id', 'rule.level', 'rule.groups', 'rule.description', 'data.srcip', 'data.dstip', 'data.srcuser', 'data.dstuser', 'decoder.name', 'location', 'syscheck.path', 'syscheck.event', 'syscheck.mtime_after', 'vulnerability.id', 'vulnerability.severity', 'package.name', 'package.version'];
    for (const hit of hits) {
        const row = object(hit), source = object(row._source);
        const index = string(row._index), documentId = string(row._id), agentId = string(field(source, 'agent.id'));
        if (!index || !documentId || !agentId) {
            warnings.push('源记录缺少索引、文档或设备身份，已拒绝该记录');
            continue;
        }
        const fields: JsonObject = {};
        for (const name of names) {
            const value = field(source, name);
            if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (Array.isArray(value) && value.every(v => typeof v === 'string')))
                fields[name] = value;
        }
        const rawTime = field(source, 'timestamp') ?? field(source, '@timestamp');
        const observedAt = instant(rawTime);
        if (rawTime !== undefined && !observedAt)
            warnings.push('事件时间缺少时区或无法解析');
        records.push({ source: { platformInstanceId: p.platformInstanceId, kind: 'index_document', index, documentId }, kind, agentId, ...(observedAt ? { observedAt } : {}), timeQuality: observedAt ? 'source' : rawTime ? 'ambiguous' : 'unknown', retrievedAt, fields });
    }
    return { records, warnings: [...new Set(warnings)] };
}
export function resourceRecords(p: ConnectionProfile, agentId: string, category: string, rows: unknown[], retrievedAt: string, kind: 'inventory' | 'fim' | 'finding') {
    const records: SourceRecord[] = [], warnings: string[] = [];
    const identities: Record<string, string[]> = { os: ['os.name', 'name'], hardware: ['board_serial', 'cpu.name'], packages: ['name', 'version', 'architecture'], processes: ['pid', 'name', 'start_time'], ports: ['protocol', 'local.ip', 'local.port', 'inode'], fim_objects: ['file'], sca: ['policy_id'] };
    const allowed = new Set(['id', 'name', 'version', 'architecture', 'pid', 'ppid', 'protocol', 'local', 'remote', 'state', 'inode', 'file', 'size', 'perm', 'mtime', 'policy_id', 'description', 'pass', 'fail', 'invalid', 'total_checks', 'score', 'scan', 'os', 'cpu', 'ram', 'board_serial', 'start_time']);
    for (const raw of rows) {
        const row = object(raw);
        const scan = object(row.scan);
        const observedAt = instant(scan.time ?? row['scan.time'] ?? row.end_scan ?? row.scan_time);
        const rawScanId = scan.id ?? row['scan.id'];
        const scanId = string(rawScanId) ?? (number(rawScanId) !== undefined ? String(rawScanId) : undefined) ?? observedAt;
        const keyFields = identities[category] ?? ['id'];
        const nativeId = string(row.id) ?? (number(row.id) !== undefined ? String(row.id) : undefined);
        const values = keyFields.map(name => field(row, name));
        const complete = values.length > 0 && values.every(value => (typeof value === 'string' && value.trim().length > 0) || (typeof value === 'number' && Number.isFinite(value)));
        const rowKey = nativeId && nativeId.trim() ? JSON.stringify(['native', nativeId]) : complete ? JSON.stringify(['fields', ...values]) : undefined;
        if (!scanId || !rowKey) {
            warnings.push('源限制：缺少稳定行键或扫描身份，未生成可去重材料');
            continue;
        }
        const fields = Object.fromEntries(Object.entries(row).filter(([name, value]) => allowed.has(name) && value !== undefined)) as JsonObject;
        if (!observedAt)
            warnings.push('扫描时间未知；取得时间不代表采集时间');
        if (observedAt && Date.parse(retrievedAt) - Date.parse(observedAt) > 86400000)
            warnings.push('清单扫描早于 24 小时，请结合采集新鲜度解释');
        if (category === 'fim_objects')
            warnings.push('FIM 对象清单不是文件变更事件历史');
        if (category === 'ports')
            warnings.push('端口清单不证明发生过网络通信');
        // Hash only the explicit native row identity + scan identity, never the whole content.
        const collectionIdentity = createHash('sha256').update(JSON.stringify([rowKey, scanId])).digest('hex');
        records.push({ source: { platformInstanceId: p.platformInstanceId, kind: 'resource', resource: category, agentId, collectionIdentity }, kind, agentId, ...(observedAt ? { observedAt } : {}), timeQuality: observedAt ? 'source' : 'unknown', retrievedAt, fields });
    }
    const counts = new Map<string, number>();
    for (const record of records) {
        const identity = record.source.collectionIdentity!;
        counts.set(identity, (counts.get(identity) ?? 0) + 1);
    }
    if ([...counts.values()].some(count => count > 1))
        warnings.push('源限制：本页原生身份重复，无法确认稳定行身份，已拒绝重复身份的全部行');
    return { records: records.filter(record => counts.get(record.source.collectionIdentity!) === 1), warnings: [...new Set(warnings)] };
}
