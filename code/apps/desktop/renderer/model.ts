import type { CaseRecord, InboxAlert, JobRecord, Scope } from '@campussec/contracts';

export const caseStates: Record<CaseRecord['status'], string> = {
  pending: '待调查', investigating: '调查中', resolved: '已关闭', reopened: '已重开',
};
export const jobStates: Record<JobRecord['state'], string> = {
  coalescing: '合并等待', queued: '排队中', preparing: '准备中', submitting: '提交中',
  running: '调查中', verifying: '验证中', succeeded: '已完成', needs_review: '待人工核查',
  failed: '失败', cancel_requested: '等待停止确认', cancelled: '已取消', uncertain: '远端状态待核实',
};
export const capabilityNames: Record<string, string> = {
  alerts: '规则告警', archives: '归档检索', authentication_events: '认证事件', agents: '设备清单',
  inventory_os: '操作系统', inventory_hardware: '硬件信息', inventory_packages: '软件包',
  inventory_processes: '进程', inventory_ports: '端口', fim_objects: '文件基线', fim_events: '文件变更',
  sca: '配置评估', vulnerabilities: '漏洞发现', stable_alert_pagination: '稳定告警分页',
  signedApi: '可信宿主 API', dedicatedProfile: '独立调查配置', isolatedEvidenceChannel: '独立证据通道',
  trustedOrigin: '可信来源', asyncDelivery: '异步投递', deliveryReconcile: '投递核实',
};
export const stateNames: Record<string, string> = {
  available: '可用', denied: '权限受限', unreachable: '连接失败', unsupported: '暂不支持',
  unverified: '未核实', verified: '已核实', rejected: '已否定', unknown: '未知',
  partial: '部分结果', complete: '查询完整', not_executed: '未执行', known: '已知',
  ok: '查询成功', unavailable: '不可用', failed: '失败', active: '在线', disconnected: '离线',
  never_connected: '未连接', pending: '待处理', open: '待核查', waiting: '待他人确认', completed: '已记录完成',
  unreviewed: '未审核', accepted: '已采纳', revised: '已修订', valid: '校验通过', invalid: '校验失败',
  needs_review: '待人工核查', needs_investigation: '需要调查', explained: '已有解释',
  insufficient_evidence: '证据不足', delivered: '投递完成', sending: '投递中', uncertain: '待核实',
  retryable_failed: '投递失败，可重试', blocked: '已阻止', expired: '正文已过期',
  alert_auto: '告警触发', client_user: '客户端主动', teleagent_user: '来源对话',
  awaiting_scope: '待补充范围', withdrawn: '已撤回', recovery: '恢复补查', history: '历史记录', realtime: '实时接收',
  prepared: '已准备，尚未交付', released: '已交付', source: '来源时间', ambiguous: '时间含义不明确',
  answered_with_limits: '已作有限回答', evidence_unavailable: '关键证据不可得', budget_exhausted: '预算耗尽',
  user_cancelled: '用户取消', execution_failed: '执行失败', scope_expansion_needed: '需要扩大范围',
};
export function stateText(state: string): string { return stateNames[state] ?? state; }
export function stateTone(state: string): string {
  if (['available', 'verified', 'active', 'resolved', 'succeeded', 'accepted', 'complete', 'valid', 'delivered', 'released', 'ok'].includes(state)) return 'success';
  if (['denied', 'failed', 'invalid', 'rejected', 'blocked', 'unreachable'].includes(state)) return 'danger';
  if (['partial', 'uncertain', 'needs_review', 'waiting', 'expired', 'cancel_requested'].includes(state)) return 'warning';
  if (['running', 'investigating', 'queued', 'preparing', 'reopened', 'sending'].includes(state)) return 'primary';
  return 'neutral';
}
export function formatTime(instant?: string, timeZone = 'Asia/Shanghai'): string {
  if (!instant || !Number.isFinite(Date.parse(instant))) return '时间未知';
  try { return new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(instant)); }
  catch { return instant; }
}
export function absoluteWindow(minutes: number, now = new Date().toISOString()) {
  const upper = Date.parse(now);
  return { from: new Date(upper - minutes * 60000).toISOString(), to: new Date(upper).toISOString() };
}
export function parseInstant(value: string): string {
  if (!/(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('时间必须是包含时区的 ISO 时间，例如 2026-10-24T08:00:00+08:00');
  return new Date(value).toISOString();
}
export function parseScope(input: { connectionId: string; agents: string; from: string; to: string; timeZone: string }, maximumMinutes = 60): Scope {
  const agentIds = [...new Set(input.agents.split(/[,，\s]+/).map(x => x.trim()).filter(Boolean))];
  const from = parseInstant(input.from), to = parseInstant(input.to);
  if (!input.connectionId) throw new Error('请先选择连接');
  if (agentIds.length < 1 || agentIds.length > 5) throw new Error('请选择 1—5 台设备');
  if (Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > maximumMinutes * 60000) throw new Error(`时间范围必须大于零且不超过 ${maximumMinutes} 分钟`);
  try { new Intl.DateTimeFormat('zh-CN', { timeZone: input.timeZone }); } catch { throw new Error('显示时区无效'); }
  return { connectionId: input.connectionId, agentIds, from, to, timeZone: input.timeZone };
}
// IPC request IDs change per call. A business submission keeps its key until its payload changes.
export function submissionKey() {
  let signature = '', key = '';
  return (payload: unknown): string => {
    const next = JSON.stringify(payload);
    if (next !== signature || !key) { signature = next; key = crypto.randomUUID(); }
    return key;
  };
}
export function canResume(job: JobRecord): boolean {
  return job.recoveryHold && !job.runId && ['queued', 'preparing'].includes(job.state);
}
export function scopeForAlerts(items: Pick<InboxAlert, 'agentId' | 'observedAt'>[], connectionId: string, fallback?: Scope, now = Date.now()): Scope | undefined {
  if (fallback) return fallback;
  if (!items.length || items.some(item => !item.agentId || !item.observedAt || !Number.isFinite(Date.parse(item.observedAt)))) return undefined;
  const agentIds = [...new Set(items.map(item => item.agentId!))].sort(), times = items.map(item => Date.parse(item.observedAt!));
  const first = Math.min(...times), last = Math.max(...times);
  if (agentIds.length > 5 || last - first >= 3600000) return undefined;
  // Prefill around selected events, rather than silently giving an older alert the current 30-minute window.
  let from = first - 300000, to = Math.max(last + 1, Math.min(now, last + 300000));
  if (to - from > 3600000) { from = first; to = last + 1; }
  return { connectionId, agentIds, from: new Date(from).toISOString(), to: new Date(to).toISOString(), timeZone: 'Asia/Shanghai' };
}
