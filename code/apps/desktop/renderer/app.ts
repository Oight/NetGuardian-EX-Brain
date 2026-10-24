import type { BusinessContext, CaseRecord, CaseSnapshot, DesktopApi, EvidenceRef, Scope, WorkspaceSnapshot } from '@campussec/contracts';
import { ApiError, createClient } from './api.js';
import { absoluteWindow, caseStates, formatTime, parseInstant, parseScope } from './model.js';
import { createUi } from './ui.js';
import { renderStatistics } from './charts.js';
import type { Route, WorkbenchContext } from './context.js';
import { createPlatformViews } from './platform.js';
import { createReportViews } from './reports.js';
import { createInvestigationViews } from './investigations.js';
import { createSettingsViews } from './settings.js';

const routes: Record<Route, [string, string, string]> = {
  overview: ['安全概览', '从当前工作空间出发，关注告警、调查与待核实的信息。', 'overview'],
  alerts: ['告警收件箱', '筛选规则告警，核对来源，再决定下一步调查。', 'alerts'],
  cases: ['调查与案件', '让每一次调查都有范围、有依据、有可追溯的记录。', 'cases'],
  requests: ['调查任务', '查看请求、执行预算与恢复状态，区分受理和完成。', 'requests'],
  devices: ['设备与资产', '查看获准设备和最近采集快照，从设备开始调查。', 'devices'],
  business: ['业务背景', '把业务用途、维护说明和授权信息保留为可追溯的版本。', 'business'],
  followups: ['核查与交接', '记录待确认问题、人工处理情况和复核依据。', 'followups'],
  reports: ['调查报告', '核对事实、分析与缺口，审核后导出或发布结果。', 'reports'],
  connections: ['平台连接', '分别管理 Server 与 Indexer，逐项确认数据能力。', 'connections'],
  architecture: ['接入状态', '查看采集、调查和结果回传各环节的真实状态。', 'architecture'],
  settings: ['工作空间设置', '调整显示、预算、留存和桌面行为。', 'settings'],
};

export function mountWorkbench(input: { element: HTMLElement; api: DesktopApi }): { unmount(): void } {
  const { element } = input, doc = element.ownerDocument, win = doc.defaultView!, ui = createUi(doc), invoke = createClient(input.api);
  const { el, icon, button, card, field, select, table, notice, empty, state, facts, disclosure } = ui;
  let disposed = false, route: Route = 'overview', revision = 0, afterSeq = 0, polling = false, spaceId = '';
  let workspace: WorkspaceSnapshot | undefined, selectedCase: CaseSnapshot | undefined;
  let caseFilters: { text?: string; status?: CaseRecord['status'] } = {};
  const cleanups: (() => void)[] = [], dialogs = new Set<() => void>();
  const root = el('div', undefined, 'workbench'), sidebar = el('aside', undefined, 'sidebar'); sidebar.id = 'main-sidebar';
  const brand = el('div', undefined, 'brand'), mark = el('div', undefined, 'brand-mark'); mark.append(icon('shield'));
  const brandText = el('div'); brandText.append(el('strong', '校安智脑'), el('span', 'NETGUARDIAN', 'brand-caption')); brand.append(mark, brandText);
  const nav = el('nav'); nav.setAttribute('aria-label', '主导航');
  const sidebarBottom = el('div', undefined, 'sidebar-bottom'), local = el('div', undefined, 'local-space');
  local.append(el('span', 'L', 'space-avatar'), el('div', '本地工作空间', 'space-name'), ui.chip('本地', 'neutral'));
  sidebarBottom.append(local, el('p', '证据有来源 · 判断有依据', 'small muted'));
  sidebar.append(brand, el('div', '安全运营工作台', 'sidebar-caption'), nav, sidebarBottom);
  const scrim = button('关闭导航', () => { root.classList.remove('nav-open'); menu.setAttribute('aria-expanded', 'false'); }, 'nav-scrim'); scrim.setAttribute('aria-label', '关闭导航');
  const area = el('div', undefined, 'workspace-area'), topbar = el('header', undefined, 'topbar');
  const menu = button('展开导航', () => { const open = root.classList.toggle('nav-open'); menu.setAttribute('aria-expanded', String(open)); }, 'icon-button mobile-menu', 'menu');
  menu.setAttribute('aria-controls', sidebar.id); menu.setAttribute('aria-expanded', 'false');
  const breadcrumb = el('div', undefined, 'breadcrumb'); breadcrumb.append(el('span', '工作空间'), el('span', '/'), el('strong', routes.overview[0]));
  const globalSearch = el('form', undefined, 'global-search'), searchInput = el('input'); searchInput.type = 'search'; searchInput.placeholder = '搜索案件标题…'; searchInput.setAttribute('aria-label', '搜索案件标题');
  globalSearch.append(icon('search'), searchInput, el('kbd', 'Ctrl K'));
  globalSearch.addEventListener('submit', event => { event.preventDefault(); caseFilters = { text: searchInput.value.trim() }; void run(undefined, () => showCases()); });
  const themeButton = button('切换主题', () => applyTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'), 'icon-button', 'moon'); themeButton.setAttribute('aria-label', '切换主题');
  const avatar = el('div', '本', 'user-avatar'); avatar.title = '当前本地主体'; topbar.append(menu, breadcrumb, globalSearch, themeButton, avatar);
  const shell = el('div', undefined, 'page-shell'), heading = el('div', undefined, 'page-heading'), labels = el('div'), pageTitle = el('h1'), description = el('p', undefined, 'muted');
  labels.append(pageTitle, description);
  const actions = el('div', undefined, 'actions');
  const refreshButton = button('刷新工作空间', () => void run(refreshButton, async () => { await refresh(); notify('工作空间摘要已更新，未覆盖当前表单。'); }), 'button secondary', 'refresh');
  actions.append(refreshButton, button('发起调查', () => investigations.open(), 'button primary', 'plus')); heading.append(labels, actions);
  const statusBar = el('div', undefined, 'workspace-status'), status = el('span', '正在读取工作空间…'), summary = el('span', '', 'small muted'); statusBar.append(status, summary);
  const message = el('div', '', 'message'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
  const error = el('div', '', 'error'); error.setAttribute('role', 'alert');
  const content = el('div', undefined, 'page-content'); content.id = 'content';
  const footer = el('footer', undefined, 'page-footer'); footer.append(el('span', 'NetGuardian · 校园安全调查工作台'), el('span', '本地案件持久化 · Asia/Shanghai'));
  shell.append(heading, statusBar, message, error, content, footer); area.append(topbar, shell); root.append(sidebar, scrim, area); element.replaceChildren(root);
  // Browser storage holds appearance only; cases, evidence, credentials and task state stay behind DesktopApi.
  function preference(name: string): string | null { try { return win.localStorage.getItem(`netguardian-ui-${name}`); } catch { return null; } }
  function savePreference(name: string, value: string) { try { win.localStorage.setItem(`netguardian-ui-${name}`, value); } catch { /* Locked-down browsers can still use session appearance. */ } }
  function applyTheme(theme: string) {
    root.dataset.theme = theme; doc.documentElement.dataset.theme = theme; themeButton.replaceChildren(icon(theme === 'dark' ? 'sun' : 'moon'));
    themeButton.title = theme === 'dark' ? '切换浅色模式' : '切换深色模式'; themeButton.setAttribute('aria-pressed', String(theme === 'dark')); savePreference('theme', theme);
  }
  applyTheme(preference('theme') === 'dark' ? 'dark' : 'light'); root.dataset.density = preference('density') === 'compact' ? 'compact' : 'comfortable';
  function notify(text: string) { if (!disposed) message.textContent = text; }
  function report(reason: unknown) {
    if (disposed) return;
    error.textContent = reason instanceof ApiError ? `${reason.code}：${reason.message}` : reason instanceof Error ? reason.message : '操作失败，请重试';
    const modalError = Array.from(root.querySelectorAll<HTMLElement>('.modal-error')).at(-1); if (modalError) modalError.textContent = error.textContent;
    if (reason instanceof ApiError && reason.code === 'REVISION_CONFLICT') notify('数据已有新版本。请重新读取并审阅后再次保存；当前输入已保留。');
  }
  async function run(b: HTMLButtonElement | undefined, action: () => Promise<void>) {
    if (disposed || b?.disabled) return;
    if (b) { b.disabled = true; b.setAttribute('aria-busy', 'true'); } error.textContent = '';
    for (const feedback of Array.from(root.querySelectorAll('.modal-error'))) feedback.textContent = '';
    try { await action(); } catch (reason) { report(reason); }
    finally { if (b && !disposed) { b.disabled = false; b.removeAttribute('aria-busy'); } }
  }
  function submit(form: HTMLFormElement, label: string, action: () => Promise<void>) {
    const b = button(label, () => {}, 'button primary'); b.type = 'submit'; const group = el('div', undefined, 'form-actions'); group.append(b); form.append(group);
    form.addEventListener('submit', event => { event.preventDefault(); void run(b, action); }); return b;
  }
  const value = (form: HTMLFormElement, name: string) => String(new FormData(form).get(name) ?? '').trim();
  function connectionSelect(form: HTMLElement, selected?: string) {
    const entries = (workspace?.connections ?? []).map(c => [c.id, c.displayName] as const);
    return select(form, '平台连接', 'connectionId', entries.length ? entries : [['', '尚未配置连接']], selected ?? entries[0]?.[0], true);
  }
  function scopeFields(form: HTMLElement, scope?: Scope, maximumMinutes = 60) {
    connectionSelect(form, scope?.connectionId);
    const agents = field(form, '设备 ID（1—5 台，逗号分隔）', 'agents', scope?.agentIds.join(', ') ?? ''); agents.placeholder = '例如 001, 002';
    const window = scope ?? absoluteWindow(Math.min(30, maximumMinutes));
    const from = field(form, '开始时间（含起点）', 'from', window.from), to = field(form, '结束时间（不含终点）', 'to', window.to);
    field(form, '显示时区', 'timeZone', scope?.timeZone ?? 'Asia/Shanghai');
    const presets = el('div', undefined, 'scope-presets wide'); presets.append(el('span', '快速选择', 'small muted'));
    for (const minutes of maximumMinutes > 60 ? [60, 360, 1440] : [15, 30, 60]) if (minutes <= maximumMinutes) presets.append(button(minutes < 60 ? `近 ${minutes} 分钟` : `近 ${minutes / 60} 小时`, () => { const fixed = absoluteWindow(minutes); from.value = fixed.from; to.value = fixed.to; }, 'button ghost small-button'));
    presets.append(el('span', '时间含时区；相对范围在点击时冻结', 'small muted')); form.append(presets);
  }
  function readScope(form: HTMLFormElement, maximumMinutes = 60) { return parseScope({ connectionId: value(form, 'connectionId'), agents: value(form, 'agents'), from: value(form, 'from'), to: value(form, 'to'), timeZone: value(form, 'timeZone') }, maximumMinutes); }
  function dialog(title: string, description?: string) {
    const modal = el('dialog', undefined, 'modal'), head = el('div', undefined, 'modal-head'), titleElement = el('h2', title), body = el('div', undefined, 'modal-body');
    titleElement.id = `dialog-${crypto.randomUUID()}`; modal.setAttribute('aria-labelledby', titleElement.id); const previousFocus = doc.activeElement as HTMLElement | null;
    const close = () => {
      // Clear detached controls too: closing/navigation/unmount must not retain credentials in a dialog reference.
      for (const control of Array.from(modal.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'))) control.value = '';
      modal.close(); modal.remove(); dialogs.delete(close); if (previousFocus?.isConnected) previousFocus.focus();
    };
    head.append(titleElement, button('关闭', close, 'icon-button', 'close')); modal.append(head); if (description) body.append(el('p', description, 'muted'));
    const feedback = el('div', '', 'error modal-error'); feedback.setAttribute('role', 'alert'); body.append(feedback); modal.append(body); root.append(modal);
    modal.addEventListener('cancel', event => { event.preventDefault(); close(); }); dialogs.add(close); modal.showModal(); return { body, close, valid: () => !disposed && modal.isConnected };
  }
  // S03 pins the exact document URL for IPC. Navigation stays in this document, including on file://.
  function begin(name: Route, title = routes[name][0], subtitle = routes[name][1]) {
    for (const close of [...dialogs]) close(); route = name; revision++; selectedCase = undefined; content.replaceChildren(); message.textContent = ''; error.textContent = '';
    pageTitle.textContent = title; description.textContent = subtitle; breadcrumb.lastElementChild!.textContent = routes[name][0]; root.classList.remove('nav-open'); menu.setAttribute('aria-expanded', 'false');
    for (const b of Array.from(nav.querySelectorAll<HTMLButtonElement>('button'))) { if (b.dataset.route === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
    doc.title = `${title} · 校安智脑`; const ticket = revision; return { body: content, valid: () => !disposed && ticket === revision };
  }
  async function refresh() {
    const [runtime, snapshot] = await Promise.all([invoke('runtime.status', {}), invoke('workspace.snapshot', {})]); if (disposed) return;
    const changed = !!spaceId && spaceId !== runtime.spaceId; spaceId = runtime.spaceId; workspace = snapshot; afterSeq = Math.max(afterSeq, snapshot.eventSeq);
    status.replaceChildren(el('span', '', `status-dot ${runtime.state === 'ready' ? 'success' : 'warning'}`), el('span', runtime.state === 'degraded' ? '本地案件可用 · 调查能力待接入' : runtime.state === 'ready' ? '调查服务就绪' : '服务正在停止'));
    summary.textContent = `${snapshot.totals.cases} 个案件 · ${snapshot.totals.queued} 个排队 · ${snapshot.totals.active} 个活动调查`; local.title = `当前主体空间：${spaceId}`;
    if (changed) { revision++; afterSeq = snapshot.eventSeq; selectedCase = undefined; searchInput.value = ''; caseFilters = {}; await showCases(); notify('主体空间已改变，旧空间表单和缓存已清空。'); }
  }
  const ctx: WorkbenchContext = {
    ui, invoke, begin, connections: () => workspace?.connections ?? [], workspace: () => workspace, refresh, run, notify, submit, value, scopeFields, readScope, connectionSelect, dialog,
    openCase: id => showCase(id), openCreate: (scope, refs) => openCreate(scope, refs), openInvestigation: (scope, caseId, refs) => investigations.open(scope, caseId, refs),
    openReports: caseId => reports.showReports(caseId), openFollowups: caseId => reports.showFollowups(caseId), navigate,
  };
  const platform = createPlatformViews(ctx), reports = createReportViews(ctx), investigations = createInvestigationViews(ctx), settings = createSettingsViews(ctx, {
    theme: () => root.dataset.theme!, setTheme: applyTheme, density: () => root.dataset.density!, setDensity: density => { root.dataset.density = density; savePreference('density', density); },
  });
  function metric(label: string, amount: string, caption: string, glyph: string, tone = 'primary') {
    const result = el('section', undefined, `metric ${tone}`), top = el('div', undefined, 'between'), symbol = el('div', undefined, 'metric-icon'); symbol.append(icon(glyph)); top.append(el('span', label, 'muted'), symbol); result.append(top, el('strong', amount, 'metric-value'), el('span', caption, 'small muted')); return result;
  }
  function caseTable(items: CaseRecord[]) {
    const grid = table(['案件 / 调查目标', '设备范围', '案件状态', '更新时间 · 上海', '']);
    for (const c of items) { const title = el('div', undefined, 'table-title'); title.append(button(c.title, () => void run(undefined, () => showCase(c.id)), 'text-button'), el('span', `#${c.id.slice(0, 8)} · 版本 ${c.revision}`, 'small muted mono')); grid.row([title, `Agent ${c.scope.agentIds.join(', ')}`, state(c.status, caseStates[c.status]), formatTime(c.updatedAt), button('打开', () => void run(undefined, () => showCase(c.id)), 'button ghost small-button', 'arrow')]); }
    return grid.root;
  }
  async function showOverview() {
    const page = begin('overview'), snapshot = await invoke('workspace.snapshot', {}); if (!page.valid()) return; workspace = snapshot;
    const metrics = el('div', undefined, 'metrics'); metrics.append(metric('本地案件', String(snapshot.totals.cases), '当前主体可见的持久化案件', 'cases'), metric('进行中的调查', String(snapshot.totals.active), '执行状态由服务端确认', 'requests', 'success'), metric('等待执行', String(snapshot.totals.queued), '排队不代表已开始取证', 'clock', 'warning'), metric('平台连接', String(snapshot.connections.length), '配置数量；可用性需逐项核实', 'connections', 'violet'));
    const banner = el('section', undefined, 'investigation-banner'), copy = el('div'); copy.append(el('span', 'EVIDENCE BEFORE CONCLUSIONS', 'eyebrow'), el('h2', '从一个问题开始，让证据连接答案。'), el('p', '选择设备与时间范围，保留业务背景，追踪每一步调查依据。', 'muted'));
    const bannerActions = el('div', undefined, 'actions'); bannerActions.append(button('创建案件', () => openCreate(), 'button primary', 'plus'), button('查看调查任务', () => void run(undefined, investigations.show), 'button secondary', 'arrow')); banner.append(copy, bannerActions);
    const grid = el('div', undefined, 'overview-grid'), recent = card('最近案件', '当前工作空间最近更新的案件', button('全部案件', () => void run(undefined, showCases), 'button ghost small-button', 'arrow'));
    if (snapshot.cases.length) recent.body.append(caseTable(snapshot.cases.slice(0, 6))); else recent.body.append(empty('从第一项案件开始', '可以直接指定设备与时间，不需要已有告警。', button('创建案件', () => openCreate(), 'button secondary', 'plus')));
    const attention = card('下一步工作', '先核对范围，再核对证据与解释');
    const steps: [string, string, string, Route][] = [['01', '确认平台能力', 'Server 与 Indexer 独立核实，缺失权限明确保留。', 'connections'], ['02', '补充业务背景', '记录维护、用途与授权说明，并标明信息来源。', 'business'], ['03', '核查与交接', '人工判断和案件关闭分别保存，保留未知问题。', 'followups']];
    for (const [index, title, text, target] of steps) { const row = el('div', undefined, 'next-step'), copy = el('div'); copy.append(button(title, () => void run(undefined, () => navigate(target)), 'text-button'), el('p', text, 'small muted')); row.append(el('span', index, 'step-number'), copy); attention.body.append(row); }
    grid.append(recent.root, attention.root);
    const statistics = card('告警统计', '显式选择范围后读取平台；未查询和失败不会显示为零', button('配置连接', () => void run(undefined, settings.showConnections), 'button ghost small-button', 'connections'));
    const statsForm = el('form', undefined, 'form-grid'), result = el('div'); scopeFields(statsForm, undefined, 1440);
    submit(statsForm, '查询告警统计', async () => { const data = await invoke('statistics.alerts', readScope(statsForm, 1440)); if (page.valid()) result.replaceChildren(renderStatistics(ui, data)); }); statistics.body.append(disclosure('选择设备与时间范围', statsForm), result); page.body.append(metrics, banner, grid, statistics.root);
  }
  async function showCases(cursor?: string) {
    const page = begin('cases'), listCard = card('案件列表', '按标题和状态检索；跨页保持相同筛选条件', button('创建案件', () => openCreate(), 'button primary', 'plus'));
    const search = el('form', undefined, 'filter-bar'); field(search, '搜索案件', 'text', caseFilters.text ?? '', 'search', false); select(search, '案件状态', 'status', [['', '全部状态'], ...Object.entries(caseStates)], caseFilters.status);
    submit(search, '检索', async () => { caseFilters = { ...(value(search, 'text') ? { text: value(search, 'text') } : {}), ...(value(search, 'status') ? { status: value(search, 'status') as CaseRecord['status'] } : {}) }; await showCases(); }); listCard.body.append(search); page.body.append(listCard.root);
    const result = await invoke('cases.list', { ...caseFilters, page: { limit: 20, ...(cursor ? { cursor } : {}) } }); if (!page.valid()) return;
    if (result.items.length) listCard.body.append(caseTable(result.items)); else listCard.body.append(empty('没有匹配案件', '尝试调整筛选条件，或为新的问题创建案件。', button('创建案件', () => openCreate(), 'button secondary', 'plus')));
    const pager = el('div', undefined, 'pagination'); pager.append(el('span', `本页 ${result.items.length} 项${cursor ? ' · 后续页' : ''}`, 'small muted'));
    if (cursor) pager.append(button('返回首页', () => void run(undefined, showCases), 'button secondary small-button')); if (result.nextCursor) pager.append(button('下一页', () => void run(undefined, () => showCases(result.nextCursor)), 'button secondary small-button', 'arrow')); listCard.body.append(pager);
  }
  function openCreate(scope?: Scope, seedRefs: EvidenceRef[] = []) {
    const modal = dialog('创建案件', '保存案件会固定设备和时间范围。后续调查、人工背景和材料都关联到这个案件。');
    if (!ctx.connections().length) { modal.body.append(empty('还没有平台连接', '可以先离线保存连接配置，再创建案件。', button('前往平台连接', () => { modal.close(); void run(undefined, settings.showConnections); }, 'button primary', 'connections'))); return; }
    const form = el('form', undefined, 'form-grid'), title = field(form, '案件标题', 'title'); title.setAttribute('maxlength', '200'); scopeFields(form, scope);
    if (seedRefs.length) form.append(notice(`已选择 ${seedRefs.length} 个告警引用；保存时由服务端验证权限与范围。`));
    submit(form, '保存案件', async () => { const created = await invoke('cases.create', { title: value(form, 'title'), scope: readScope(form), seedRefs }); if (!modal.valid()) return; modal.close(); await refresh(); await showCase(created.id); notify('案件已保存到本地主体空间。'); }); modal.body.append(form);
  }
  async function showCase(id: string, evidenceCursor?: string) {
    const page = begin('cases', '案件工作台', '观测证据、人工背景和调查草案分别保留，所有判断都能回到来源。'); page.body.append(el('p', '正在读取案件…', 'loading'));
    const snapshot = await invoke('cases.snapshot', { caseId: id, evidencePage: { limit: 20, ...(evidenceCursor ? { cursor: evidenceCursor } : {}) } }); if (!page.valid()) return;
    selectedCase = snapshot; const c = snapshot.case; page.body.replaceChildren();
    const hero = el('section', undefined, 'case-hero'), top = el('div', undefined, 'between wrap'), title = el('div'); title.append(el('p', `CASE / ${c.id.slice(0, 8).toUpperCase()}`, 'eyebrow'), el('h2', c.title));
    const actions = el('div', undefined, 'actions'); actions.append(state(c.status, caseStates[c.status]), button('重新读取并审阅', () => void run(undefined, () => showCase(id)), 'button secondary small-button', 'refresh')); top.append(title, actions);
    hero.append(top, facts([['设备范围', `Agent ${c.scope.agentIds.join(', ')}`], ['时间 · ' + c.scope.timeZone, `${formatTime(c.scope.from, c.scope.timeZone)} — ${formatTime(c.scope.to, c.scope.timeZone)}`], ['当前材料版本', `Revision ${c.revision}`], ['最近更新', formatTime(c.updatedAt)]])); page.body.append(button('返回案件列表', () => void run(undefined, showCases), 'button ghost small-button'), hero);
    if (c.latestReportId && c.latestReportId !== c.currentReportId) page.body.append(notice('有基于旧输入的历史候选；当前材料未被该候选覆盖。', 'warning'));
    const columns = el('div', undefined, 'case-columns'), left = el('div', undefined, 'column-stack'), middle = el('div', undefined, 'column-stack'), right = el('div', undefined, 'column-stack'); columns.append(left, middle, right); page.body.append(columns);
    const refs: EvidenceRef[] = [], materials = card('证据与时间线', `本页 ${snapshot.evidence.length} 份观测材料 · 人工背景单独列示`);
    const ordered = [...snapshot.evidence].sort((a, b) => (a.observedAt ? Date.parse(a.observedAt) : Infinity) - (b.observedAt ? Date.parse(b.observedAt) : Infinity));
    for (const e of ordered) {
      const row = el('article', undefined, 'evidence-row'), label = el('label', undefined, 'evidence-label'), checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', `选择材料 ${e.id} 版本 ${e.version}`);
      checkbox.addEventListener('change', () => { const index = refs.findIndex(r => r.evidenceId === e.id && r.version === e.version); if (checkbox.checked && index < 0) refs.push({ evidenceId: e.id, version: e.version }); else if (!checkbox.checked && index >= 0) refs.splice(index, 1); });
      label.append(checkbox, ui.chip(({ alert: '规则告警', authentication: '认证事件', inventory: '采集清单', fim: '文件信息', finding: '检查发现', human_context: '人工材料' })[e.kind], 'primary'), el('span', `v${e.version}`, 'small muted'));
      row.append(label, el('p', e.observedAt ? `观察 ${formatTime(e.observedAt, c.scope.timeZone)}` : '观察时间未知', 'small'), el('p', `取得 ${formatTime(e.retrievedAt, c.scope.timeZone)}`, 'small muted'));
      if (e.availability === 'expired') row.append(notice('正文已过期；引用与缺口仍保留。', 'warning'));
      row.append(button('查看原始材料', () => void run(undefined, async () => { const result = await invoke('evidence.get', { caseId: id, ref: { evidenceId: e.id, version: e.version } }); if (!page.valid()) return; const preview = dialog('证据与来源', '本地获准快照；不等同于模型实际收到的字段投影。'); preview.body.append(facts([['证据 ID', e.id], ['版本', String(e.version)], ['内容哈希', result.evidence.contentHash], ['观察时间质量', result.evidence.timeQuality]]), el('pre', JSON.stringify(result.evidence, null, 2), 'code-block')); }), 'button ghost small-button')); materials.body.append(row);
    }
    if (!ordered.length) materials.body.append(empty('尚无观测材料', '保存业务背景不会被计为平台观测证据。', undefined, 'reports'));
    if (snapshot.nextEvidenceCursor) materials.body.append(button('下一页材料', () => void run(undefined, () => showCase(id, snapshot.nextEvidenceCursor)), 'button secondary small-button', 'arrow'));
    const move = el('form', undefined, 'form-grid'); field(move, '目标案件 ID', 'target'); field(move, '目标案件版本', 'targetRevision', '', 'number'); field(move, '移动理由', 'reason');
    submit(move, '移动所选材料', async () => { if (!refs.length) throw new Error('请先选择要移动的材料'); await invoke('cases.moveEvidence', { sourceCaseId: id, targetCaseId: value(move, 'target'), sourceRevision: c.revision, targetRevision: Number(value(move, 'targetRevision')), refs, reason: value(move, 'reason') }); if (page.valid()) { await refresh(); await showCase(id); notify('所选材料已移动，源案件和目标案件版本均已更新。'); } }); materials.body.append(disclosure('拆分案件 · 移动材料', move)); left.append(materials.root);
    const coverage = card('查询覆盖', '查询完整不表示采集覆盖完整');
    for (const query of snapshot.queries) { const row = el('div', undefined, 'coverage-row'); row.append(state(query.coverage.queryCompleteness), el('p', `返回 ${query.coverage.returned} 条 · 采集覆盖 ${query.coverage.collectionCoverage === 'known' ? '已知' : query.coverage.collectionCoverage === 'partial' ? '部分' : '未知'}`, 'small'), el('p', query.coverage.reasons.join('；') || '没有额外查询缺口', 'small muted')); coverage.body.append(row); }
    if (!snapshot.queries.length) coverage.body.append(el('p', '尚无查询覆盖记录，不能据此判断不存在风险。', 'muted small')); left.append(coverage.root);
    const investigation = card('调查过程', '问题先限定在当前案件范围；请求受理不等于调查完成'); investigations.form(investigation.body, c.scope, id, refs, page.valid);
    const jobs = workspace?.jobs.filter(j => j.caseId === id) ?? []; for (const job of jobs) investigation.body.append(button(`查看任务 ${job.requestId.slice(0, 8)}`, () => void run(undefined, async () => { const current = await invoke('requests.status', { requestId: job.requestId }); if (page.valid()) investigations.statusDialog(current); }), 'button secondary small-button', 'requests')); middle.append(investigation.root);
    const background = card('人工业务背景', '背景作为解释材料保存；默认未核实，修改会生成新版本'), holder = el('div');
    for (const context of snapshot.contexts) { const row = el('article', undefined, 'context-row'), rowTop = el('div', undefined, 'between'); rowTop.append(state(context.verification), el('span', `版本 ${context.version}`, 'small muted')); row.append(rowTop, el('p', context.text, 'preserve-lines'), el('p', `${context.sourceLabel} · ${context.department ?? '部门未知'}${context.purpose ? ' / ' + context.purpose : ''}`, 'small muted'), el('p', `${formatTime(context.from)} — ${formatTime(context.to)}`, 'small muted'), button('编辑此背景', () => editContext(context), 'button ghost small-button')); background.body.append(row); }
    background.body.append(holder); middle.append(background.root);
    function editContext(existing?: BusinessContext) {
      holder.replaceChildren(); const form = el('form', undefined, 'form-grid');
      field(form, '背景正文', 'text', existing?.text ?? '', 'textarea').setAttribute('maxlength', '8000'); field(form, '信息来源', 'sourceLabel', existing?.sourceLabel ?? '人工提供'); field(form, '有效开始时间', 'from', existing?.from ?? c.scope.from); field(form, '有效结束时间', 'to', existing?.to ?? c.scope.to); field(form, '部门', 'department', existing?.department ?? '', 'text', false); field(form, '用途', 'purpose', existing?.purpose ?? '', 'text', false);
      select(form, '核实状态', 'verification', [['unverified', '未核实'], ['verified', '人工已核实'], ['rejected', '已否定']], existing?.verification ?? 'unverified', true);
      submit(form, '保存背景版本', async () => { const from = parseInstant(value(form, 'from')), to = parseInstant(value(form, 'to')); if (Date.parse(to) <= Date.parse(from)) throw new Error('背景有效结束时间必须晚于开始时间'); await invoke('cases.putContext', { caseId: id, expectedRevision: c.revision, ...(existing ? { contextId: existing.id } : {}), context: { caseId: id, connectionId: c.scope.connectionId, agentIds: c.scope.agentIds, text: value(form, 'text'), sourceLabel: value(form, 'sourceLabel'), from, to, verification: value(form, 'verification') as BusinessContext['verification'], ...(value(form, 'department') ? { department: value(form, 'department') } : {}), ...(value(form, 'purpose') ? { purpose: value(form, 'purpose') } : {}) } }); if (page.valid()) { await refresh(); await showCase(id); notify('背景版本已保存，作者来自当前主体。'); } });
      if (existing) form.append(button('改为新增背景', () => editContext(), 'button ghost small-button')); holder.append(form);
    }
    editContext();
    const draft = card('草案与人工核查', '事实、解释、冲突与未知分别列示');
    draft.body.append(empty(c.currentReportId ? '已有候选报告' : '尚无报告草案', c.currentReportId ? '打开报告核对其基于的材料版本与引用。' : '调查服务尚未产出报告，当前不生成占位结论。', button('读取报告历史', () => void run(undefined, async () => { const items = await invoke('reports.list', { caseId: id }); if (!page.valid()) return; draft.body.replaceChildren(); if (!items.length) draft.body.append(empty('没有报告历史', '可以继续整理证据与业务背景。')); for (const report of items) draft.body.append(reports.reportSummary(report, c, page.valid)); }), 'button secondary small-button', 'reports'), 'reports'));
    draft.body.append(button('进入核查与交接', () => void run(undefined, () => reports.showFollowups(id)), 'button ghost small-button', 'followups')); right.append(draft.root);
    const statusCard = card('案件状态', '人工状态和调查任务状态分别保存'), statusForm = el('form', undefined, 'form-grid'); const transitions: Record<CaseRecord['status'], CaseRecord['status'][]> = { pending: ['investigating'], investigating: ['pending', 'resolved'], resolved: ['reopened'], reopened: ['investigating', 'resolved'] };
    select(statusForm, '变更为', 'status', transitions[c.status].map(target => [target, caseStates[target]] as const), undefined, true); field(statusForm, '变更或关闭理由', 'reason', '', 'textarea');
    submit(statusForm, '保存状态', async () => { await invoke('cases.setStatus', { caseId: id, expectedRevision: c.revision, status: value(statusForm, 'status') as CaseRecord['status'], reason: value(statusForm, 'reason') }); if (page.valid()) { await refresh(); await showCase(id); notify('状态和审计记录已保存。'); } }); statusCard.body.append(statusForm); right.append(statusCard.root);
    right.append(disclosure('查看范围与版本诊断', facts([['案件 ID', c.id], ['连接 ID', c.scope.connectionId], ['起点（含）', c.scope.from], ['终点（不含）', c.scope.to], ['当前候选', c.currentReportId ?? '无'], ['最新历史候选', c.latestReportId ?? '无']])));
  }
  async function showBusiness() {
    const page = begin('business'), list = card('案件中的业务背景', '沿用正式契约：部门、用途、说明、适用时间、来源与核实状态'); const form = el('form', undefined, 'filter-bar'); field(form, '按案件标题查找', 'text', '', 'search', false); const result = el('div');
    async function load(cursor?: string) { const cases = await invoke('cases.list', { ...(value(form, 'text') ? { text: value(form, 'text') } : {}), page: { limit: 20, ...(cursor ? { cursor } : {}) } }); if (!page.valid()) return; const rows = table(['案件', '设备范围', '版本', '']); for (const c of cases.items) rows.row([c.title, c.scope.agentIds.join(', '), `v${c.revision}`, button('维护背景', () => void run(undefined, () => showCase(c.id)), 'button secondary small-button', 'business')]); result.replaceChildren(cases.items.length ? rows.root : empty('暂无匹配案件', '为指定设备建立案件后，可以维护有来源、有版本的业务背景。', button('创建案件', () => openCreate(), 'button primary', 'plus'))); if (cases.nextCursor) result.append(button('下一页', () => void run(undefined, () => load(cases.nextCursor)), 'button secondary small-button', 'arrow')); }
    submit(form, '查找', () => load()); list.body.append(form, result); page.body.append(list.root, notice('用途、部门和维护说明按来源与核实状态保存。未确认的业务背景不自动转换成安全结论。')); await load();
  }
  async function navigate(name: Route) {
    if (name === 'overview') return showOverview(); if (name === 'cases') return showCases(); if (name === 'business') return showBusiness(); if (name === 'devices') return platform.showDevices(); if (name === 'alerts') return platform.showAlerts(); if (name === 'architecture') return platform.showArchitecture(); if (name === 'requests') return investigations.show(); if (name === 'reports') return reports.showReports(); if (name === 'followups') return reports.showFollowups(); if (name === 'connections') return settings.showConnections(); return settings.showSettings();
  }
  for (const [group, entries] of [['工作台', ['overview', 'alerts', 'cases', 'requests']], ['资产与研判', ['devices', 'business', 'followups', 'reports']], ['平台管理', ['connections', 'architecture', 'settings']]] as const) { nav.append(el('div', group, 'nav-group')); for (const name of entries) { const b = button(routes[name][0], () => void run(undefined, () => navigate(name)), 'nav-item', routes[name][2]); b.dataset.route = name; nav.append(b); } }
  const keydown = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchInput.focus(); } if (event.key === 'Escape') { root.classList.remove('nav-open'); menu.setAttribute('aria-expanded', 'false'); } };
  doc.addEventListener('keydown', keydown); cleanups.push(() => doc.removeEventListener('keydown', keydown));
  void run(undefined, async () => { await refresh(); if (!disposed) await showOverview(); });
  const timer = setInterval(() => {
    if (disposed || polling || doc.hidden) return; polling = true;
    void invoke('events.read', { afterSeq, limit: 200 }).then(async batch => {
      if (disposed) return;
      if (batch.resetRequired) {
        const caseId = selectedCase?.case.id, oldSpace = spaceId; selectedCase = undefined; await refresh();
        if (spaceId === oldSpace) { if (route === 'cases' && caseId) await showCase(caseId); else await navigate(route); }
        notify('事件记录已重置，已清空旧缓存并重新读取数据，请重新审阅。'); return;
      }
      const fresh = batch.events.filter(event => event.seq > afterSeq); if (!fresh.length) return; afterSeq = Math.max(afterSeq, ...fresh.map(event => event.seq));
      const runtime = await invoke('runtime.status', {}); if (disposed) return; if (runtime.spaceId !== spaceId) { await refresh(); return; }
      if (selectedCase && fresh.some(event => event.type === 'case.changed' && event.payload.caseId === selectedCase?.case.id && event.payload.revision !== selectedCase.case.revision)) notify('当前案件有新版本；输入已保留，请重新读取并审阅后保存。');
      else if (fresh.some(event => event.type === 'case.changed') && ['cases', 'business', 'reports', 'followups'].includes(route)) notify('案件数据已有更新；当前输入已保留，请重新读取以查看最新版本。');
      if (fresh.some(event => ['connection.changed', 'runtime.changed', 'job.changed'].includes(event.type))) { await refresh(); if (route === 'requests') notify('调查任务状态有更新，请读取最新状态。'); }
    }).catch(report).finally(() => { polling = false; });
  }, 1000); cleanups.push(() => clearInterval(timer));
  return { unmount() { if (disposed) return; disposed = true; revision++; for (const close of [...dialogs]) close(); for (const stop of cleanups) stop(); selectedCase = undefined; workspace = undefined; element.replaceChildren(); } };
}
