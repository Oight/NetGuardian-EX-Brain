/** Read-only synthetic showcase, served only by scripts/local/preview-workbench.ts. */
import { mountWorkbench } from '../app.js';
import { Fixture, id, record, scope, report, evidence, context, followup } from './browser-suite.js';

const fixture = new Fixture();
const cases = [
  { ...record, title: '统一认证异常登录 · 维护窗口核查', status: 'investigating' },
  { ...record, id: id(22), title: '实验室主机文件基线变化复核', status: 'pending' },
  { ...record, id: id(23), title: '教学平台高等级告警补充调查', status: 'reopened' },
  { ...record, id: id(24), title: '软件更新触发规则 · 人工确认', status: 'resolved' },
];
const agents = [
  { id: '001', name: 'auth-gateway-01', status: 'active', version: 'v4.14.0' },
  { id: '002', name: 'campus-lab-02', status: 'disconnected', version: 'v4.14.0' },
  { id: '003', name: 'teaching-api-01', status: 'active', version: 'v4.14.0' },
];
fixture.set('workspace.snapshot', () => ({ eventSeq: 0, generatedAt: scope.to, connections: [{ id: id(1), displayName: '合成示例平台', generation: 1 }], cases, requests: [], jobs: [], totals: { cases: 4, queued: 0, active: 0 } }));
fixture.set('cases.list', payload => ({ items: cases.filter(item => (!payload.status || payload.status === item.status) && (!payload.text || item.title.includes(payload.text))) }));
fixture.set('cases.snapshot', payload => {
  const c = cases.find(c => c.id === payload.caseId) ?? cases[0]!;
  return { case: c, evidence: [evidence], contexts: [{ ...context, caseId: c.id, text: '网络中心登记了该时段的统一认证维护；操作人员与工单授权仍需值班人员确认。', department: '网络与信息中心', purpose: '统一身份认证', sourceLabel: '合成维护说明' }], queries: [{ queryId: id(90), coverage: { requestedScope: scope, effectiveScope: scope, queryCompleteness: 'partial', collectionCoverage: 'unknown', sourceTypes: ['alerts'], reasons: ['示例：部分清单的扫描时间较旧，仍需补充核实'], retrievedAt: scope.to, returned: 18 } }] };
});
fixture.set('reports.list', payload => [{ ...report, caseId: payload.caseId, candidate: { ...report.candidate, caseId: payload.caseId, question: '本次异常登录能否由已登记的维护活动解释？', facts: [{ ...report.candidate.facts[0]!, text: '指定设备在当前窗口内出现规则告警，需要结合账号与授权记录核对。' }], analysis: [{ ...report.candidate.facts[0]!, text: '维护活动可能解释部分异常，但仅凭人工背景不足以确认全部活动已获授权。' }], gaps: ['尚未取得维护工单和操作人员确认', '当前采集覆盖不能证明窗口内的全部活动均已被记录'] } }]);
fixture.set('followups.search', () => ({ items: [{ ...followup, question: '确认维护活动是否覆盖该账号与设备', suggestedAction: '核对工单、执行人员与维护时间范围', responsibleRole: '网络中心值班人员' }] }));
fixture.set('connections.agents', () => ({ items: agents, total: { value: 3, relation: 'eq' } }));
fixture.set('devices.detail', payload => ({ agentId: payload.agentId, category: payload.category, items: [{ source: { platformInstanceId: id(7), kind: 'resource', resource: 'synthetic-inventory', agentId: payload.agentId, collectionIdentity: 'synthetic-scan' }, kind: 'inventory', agentId: payload.agentId, observedAt: scope.from, timeQuality: 'source', retrievedAt: scope.to, fields: { name: '合成采集条目', category: payload.category, description: '仅用于界面预览' } }], retrievedAt: scope.to, status: 'partial', warnings: ['合成示例，不代表真实设备快照'] }));
fixture.set('connections.capabilities', () => ['alerts', 'agents', 'inventory_os', 'inventory_ports', 'fim_objects', 'sca', 'vulnerabilities'].map(name => ({ name, state: 'unverified', endpointKind: name === 'alerts' || name === 'vulnerabilities' ? 'indexer' : 'server', checkedAt: scope.to, evidence: '合成示例；真实平台权限尚未核实' })));
fixture.set('alerts.list', () => ({ items: [12, 10, 5].map((level, index) => ({ id: id(60 + index), connectionId: id(1), sourceKey: String(index).repeat(64), receiveSeq: index + 1, kind: 'history', evidence: { evidenceId: id(6), version: 1 }, agentId: agents[index]!.id, ruleId: String(5710 + index), ruleGroups: ['authentication', 'syscheck'], level, observedAt: scope.to, receivedAt: scope.to, read: index === 2, decisionReason: '合成历史记录，不触发真实调查' })) }));
fixture.set('statistics.alerts', requested => {
  const counts = [2, 3, 1, 2, 4, 2, 5, 4, 6, 10, 8, 5, 3, 4, 7, 6, 4, 9, 12, 7, 5, 8, 4, 3];
  const total = counts.reduce((sum, count) => sum + count, 0);
  return { scope: requested, total: { value: total, relation: 'eq' }, byLevel: [{ level: 12, count: 9 }, { level: 10, count: 28 }, { level: 4, count: total - 37 }], byHour: counts.map((count, index) => ({ start: new Date(Date.parse(requested.from) + index * (Date.parse(requested.to) - Date.parse(requested.from)) / 24).toISOString(), count })), coverage: { requestedScope: requested, effectiveScope: requested, queryCompleteness: 'partial', collectionCoverage: 'unknown', sourceTypes: ['synthetic-alerts'], reasons: ['合成图表数据，仅用于界面预览'], retrievedAt: scope.to, returned: total } };
});
mountWorkbench({ element: document.getElementById('app')!, api: fixture.api });
document.getElementById('show-synthetic-chart')!.addEventListener('click', () => {
  const form = document.querySelector<HTMLFormElement>('.card-body details form');
  if (!form) return;
  const agents = form.elements.namedItem('agents') as HTMLInputElement; agents.value = '001';
  const from = form.elements.namedItem('from') as HTMLInputElement, to = form.elements.namedItem('to') as HTMLInputElement;
  to.value = new Date().toISOString(); from.value = new Date(Date.parse(to.value) - 86400000).toISOString(); form.requestSubmit();
});
