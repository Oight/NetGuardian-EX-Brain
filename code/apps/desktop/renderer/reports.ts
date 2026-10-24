import type { CaseRecord, FollowupRecord, ReportCandidate, ReportRecord, ReportStatement, ReviewInput } from '@campussec/contracts';
import type { WorkbenchContext } from './context.js';
import { formatTime, parseInstant, stateText } from './model.js';

export function createReportViews(ctx: WorkbenchContext) {
  const { ui, invoke, begin, run, submit, value, dialog } = ctx;
  const { el, card, button, field, select, table, notice, empty, state, facts, disclosure } = ui;
  function statements(host: HTMLElement, title: string, items: ReportStatement[], caseId: string, valid: () => boolean) {
    host.append(el('h3', title));
    if (!items.length) host.append(el('p', '未提供', 'small muted'));
    for (const item of items) {
      const row = el('article', undefined, 'statement'); row.append(el('p', item.text, 'preserve-lines'));
      const references = el('div', undefined, 'reference-list');
      for (const ref of item.evidenceRefs) references.append(button(`证据 ${ref.evidenceId.slice(0, 8)} · v${ref.version}`, () => void run(undefined, async () => {
        const data = await invoke('evidence.get', { caseId, ref: { evidenceId: ref.evidenceId, version: ref.version }, projectionId: ref.projectionId }); if (!valid()) return;
        const modal = dialog('核对报告引用', '优先查看实际交付模型的投影，本地快照单独展开。');
        if (data.projection) {
          modal.body.append(state(data.projection.state), facts([['投影 ID', data.projection.id], ['投影哈希', data.projection.contentHash], ['版本', String(ref.version)]]));
          modal.body.append(data.projection.availability === 'expired' ? notice('投影正文已过期，保留引用缺口。', 'warning') : el('pre', JSON.stringify(data.projection.content, null, 2), 'code-block'));
        } else modal.body.append(notice('没有返回本轮交付投影，不能将本地完整快照当作模型已见材料。', 'warning'));
        modal.body.append(disclosure('展开本地获准快照', data.evidence.availability === 'expired' ? notice('本地正文已过期，空字段不代表原始记录。', 'warning') : el('pre', JSON.stringify(data.evidence, null, 2), 'code-block')));
      }), 'reference-button'));
      for (const ref of item.contextRefs) references.append(ui.chip(`背景 ${ref.contextId.slice(0, 8)} · v${ref.version}`));
      if (item.queryIds.length) references.append(el('span', `${item.queryIds.length} 项查询依据`, 'small muted')); row.append(references); host.append(row);
    }
  }
  function reportSummary(report: ReportRecord, record: CaseRecord, valid: () => boolean): HTMLElement {
    const panel = card(`报告 v${report.version}`, `${formatTime(report.createdAt)} · 基于材料版本 ${report.baseRevision}`);
    const badges = el('div', undefined, 'actions'); badges.append(state(report.review), state(report.validation));
    if (record.currentReportId === report.id) badges.append(ui.chip('当前候选', 'primary'));
    else badges.append(ui.chip('历史候选'));
    panel.body.append(badges, el('h3', report.candidate.question));
    if (report.baseRevision < record.revision) panel.body.append(notice('该报告基于较早的材料版本，请核对后续背景和证据变化。', 'warning'));
    if (report.validationIssues.length) panel.body.append(notice(report.validationIssues.join('；'), 'warning'));
    statements(panel.body, '观测事实', report.candidate.facts, record.id, valid); statements(panel.body, '分析与解释', report.candidate.analysis, record.id, valid); statements(panel.body, '冲突与反例', report.candidate.conflicts, record.id, valid);
    const gaps = el('div', undefined, 'report-gaps'); gaps.append(el('h3', '缺口与停止原因'));
    for (const gap of report.candidate.gaps) gaps.append(el('p', gap, 'small')); gaps.append(el('p', stateText(report.candidate.stopReason), 'small muted')); panel.body.append(gaps);
    panel.body.append(button('人工审核此报告', () => reviewDialog(report, record, valid), 'button secondary small-button', 'check'));
    return panel.root;
  }
  function reviewDialog(report: ReportRecord, record: CaseRecord, valid: () => boolean) {
    const modal = dialog('人工审核报告', '审核只记录人工判断；案件关闭与发布到原来源是独立操作。');
    const form = el('form', undefined, 'form-grid');
    const disposition = select(form, '审核操作', 'disposition', [['accepted', '采纳草案'], ['revised', '修订判断'], ['rejected', '否定草案']], 'accepted', true);
    select(form, '人工结论', 'humanConclusion', [['unknown', '仍然未知'], ['confirmed_attack', '人工确认攻击'], ['confirmed_benign', '人工确认正常业务']], 'unknown', true);
    field(form, '人工说明与核查依据', 'note', '', 'textarea');
    // Reuse only delivered references already present in this report; the service revalidates the candidate.
    const candidate: ReportCandidate = structuredClone(report.candidate), editor = el('fieldset', undefined, 'form-grid wide'); editor.append(el('legend', '修订内容'));
    const classification = select(editor, '修订后的分类', 'classification', [['needs_investigation', '需要调查'], ['explained', '已有解释'], ['insufficient_evidence', '证据不足']], candidate.classification, true);
    const delivered = [...new Map([...candidate.facts, ...candidate.analysis, ...candidate.conflicts].flatMap(item => item.evidenceRefs).map(ref => [`${ref.evidenceId}:${ref.version}:${ref.projectionId}`, ref])).values()];
    for (const [group, title] of [['facts', '事实'], ['analysis', '分析'], ['conflicts', '冲突']] as const) {
      const section = el('div', undefined, 'wide'), entries = el('div');
      function render() {
        entries.replaceChildren();
        candidate[group].forEach((statement, index) => {
          const row = el('div', undefined, 'statement-editor');
          const text = field(row, `${title} ${index + 1}`, `${group}-${index}`, statement.text, 'textarea'); text.setAttribute('maxlength', '8000'); text.addEventListener('input', () => { statement.text = text.value; });
          const refs = el('div', undefined, 'reference-options');
          delivered.forEach((ref, i) => {
            const check = field(refs, `证据 ${ref.evidenceId.slice(0, 8)} · v${ref.version}`, `${group}-${index}-ref-${i}`, '', 'checkbox', false) as HTMLInputElement;
            check.checked = statement.evidenceRefs.some(item => item.projectionId === ref.projectionId && item.evidenceId === ref.evidenceId && item.version === ref.version);
            check.addEventListener('change', () => { statement.evidenceRefs = statement.evidenceRefs.filter(item => !(item.projectionId === ref.projectionId && item.evidenceId === ref.evidenceId && item.version === ref.version)); if (check.checked) statement.evidenceRefs.push(structuredClone(ref)); });
          });
          if (delivered.length) row.append(disclosure('核对依据引用', refs));
          row.append(button(`移除此项${title}`, () => { candidate[group].splice(index, 1); render(); }, 'button ghost small-button')); entries.append(row);
        });
      }
      section.append(el('h3', title), entries, button(`新增${title}`, () => { if (candidate[group].length >= 20) return; candidate[group].push({ text: '', evidenceRefs: [], queryIds: [], contextRefs: [] }); render(); }, 'button secondary small-button', 'plus'));
      render(); editor.append(section);
    }
    const gaps = field(editor, '缺口（每行一项）', 'gaps', candidate.gaps.join('\n'), 'textarea', false);
    editor.disabled = true; editor.hidden = true; disposition.addEventListener('change', () => { editor.disabled = disposition.value !== 'revised'; editor.hidden = editor.disabled; }); form.append(editor);
    submit(form, '保存人工审核', async () => {
      const operation = value(form, 'disposition') as ReviewInput['disposition']; candidate.classification = classification.value as ReportCandidate['classification']; candidate.gaps = gaps.value.split('\n').map(s => s.trim()).filter(Boolean);
      await invoke('reports.review', { reportId: report.id, expectedCaseRevision: record.revision, disposition: operation, humanConclusion: value(form, 'humanConclusion') as ReviewInput['humanConclusion'], note: value(form, 'note'), ...(operation === 'revised' ? { revisedCandidate: candidate } : {}) });
      if (!modal.valid() || !valid()) return; modal.close(); await showReports(record.id); ctx.notify('人工审核已保存；案件状态和原来源结果未自动变更。');
    }); modal.body.append(facts([['报告版本', String(report.version)], ['案件材料版本', String(record.revision)]]), form);
  }
  async function exportPreview(record: CaseRecord, reports: ReportRecord[], valid: () => boolean) {
    const followups = await invoke('followups.list', { caseId: record.id }); if (!valid()) return;
    const modal = dialog('交接导出预览', '核对范围、报告版本、审核状态和未完成事项后，再由桌面保存对话框选择路径。');
    modal.body.append(el('h3', record.title), facts([['设备', record.scope.agentIds.join(', ')], ['范围', `${record.scope.from} ≤ 时间 < ${record.scope.to}`], ['材料版本', String(record.revision)], ['未完成核查项', String(followups.filter(item => item.state !== 'completed').length)]]));
    for (const report of reports) modal.body.append(reportSummary(report, record, modal.valid));
    if (!reports.length) modal.body.append(notice('没有报告候选；导出内容只能包含服务端认可的现有材料与缺口。', 'warning'));
    for (const item of followups) modal.body.append(el('p', `${stateText(item.state)} · ${item.question}`, 'small'));
    const form = el('form', undefined, 'filter-bar'); select(form, '导出格式', 'format', [['markdown', 'Markdown'], ['json', 'JSON']], 'markdown', true);
    submit(form, '选择路径并导出', async () => { const data = await invoke('cases.export', { caseId: record.id, caseRevision: record.revision, format: value(form, 'format') as 'markdown' | 'json' }); if (modal.valid()) { modal.close(); ctx.notify(`已由桌面保存：${data.filename}`); } }); modal.body.append(form);
  }
  async function showReports(caseId?: string) {
    const page = begin('reports'), selector = card('报告历史与人工审核', '先选择案件；基于旧输入的报告仍然保留'); const form = el('form', undefined, 'filter-bar'); field(form, '案件 ID', 'caseId', caseId ?? '');
    const results = el('div'); let loadedCase: CaseRecord | undefined, loadedReports: ReportRecord[] = [];
    async function load() {
      const id = value(form, 'caseId'), responses = await Promise.allSettled([invoke('cases.snapshot', { caseId: id, evidencePage: { limit: 1 } }), invoke('reports.list', { caseId: id })]); if (!page.valid()) return;
      const [caseResponse, reportResponse] = responses;
      if (caseResponse.status === 'rejected') throw caseResponse.reason;
      loadedCase = caseResponse.value.case; results.replaceChildren(facts([['案件', loadedCase.title], ['当前材料版本', String(loadedCase.revision)], ['设备', loadedCase.scope.agentIds.join(', ')]]));
      if (reportResponse.status === 'rejected') { loadedReports = []; results.append(empty('报告能力尚不可用', reportResponse.reason instanceof Error ? reportResponse.reason.message : '无法读取报告', undefined, 'reports')); return; }
      loadedReports = reportResponse.value;
      if (!loadedReports.length) results.append(empty('暂无报告历史', '可以先维护案件背景与已取得的观测材料。', button('打开案件', () => void run(undefined, () => ctx.openCase(id)), 'button secondary', 'cases'), 'reports'));
      for (const report of loadedReports) results.append(reportSummary(report, loadedCase, page.valid));
      results.append(button('预览交接与导出', () => void run(undefined, () => exportPreview(loadedCase!, loadedReports, page.valid)), 'button primary', 'download'));
      const publication = el('form', undefined, 'form-grid'); field(publication, '原来源请求 ID', 'requestId');
      const reportInput = select(publication, '要发布的已审核报告', 'reportId', loadedReports.filter(report => ['accepted', 'revised'].includes(report.review)).map(report => [report.id, `版本 ${report.version} · ${stateText(report.review)}`] as const), undefined, true);
      submit(publication, '预览发布到原来源', async () => {
        if (!reportInput.value) throw new Error('先保存人工审核，再选择要发布的报告'); const requestId = value(publication, 'requestId');
        const current = await invoke('results.get', { requestId }); if (!page.valid()) return;
        if (current.caseId !== loadedCase!.id) throw new Error('该请求与当前案件不一致');
        const modal = dialog('确认发布人工审核结果', '发布新结果版本不会重跑调查；实际投递与接收状态需单独核实。');
        modal.body.append(facts([['请求', requestId], ['当前结果版本', String(current.resultVersion)], ['报告', reportInput.value]]));
        const publish = button('发布到绑定来源', () => void run(publish, async () => { const updated = await invoke('results.publishReview', { requestId, reportId: reportInput.value, expectedCaseRevision: loadedCase!.revision, expectedResultVersion: current.resultVersion }); if (modal.valid()) { modal.close(); ctx.notify(`结果版本 ${updated.resultVersion} 已发布；投递结果请在调查任务中核实。`); } }), 'button primary', 'connections'); modal.body.append(publish);
      }); results.append(disclosure('向原来源发布人工修订', publication));
    }
    submit(form, '读取报告', load); selector.body.append(form);
    const recent = ctx.workspace()?.cases ?? []; if (recent.length) { const shortcuts = el('div', undefined, 'case-shortcuts'); for (const c of recent.slice(0, 5)) shortcuts.append(button(c.title, () => { (form.elements.namedItem('caseId') as HTMLInputElement).value = c.id; void run(undefined, load); }, 'button ghost small-button')); selector.body.append(shortcuts); }
    selector.body.append(results); page.body.append(selector.root); if (caseId) await load(); else results.append(empty('选择一个案件查看报告', '报告按实际轮次和材料版本保存，人工结论与模型建议分别展示。', undefined, 'reports'));
  }
  function editFollowup(existing: FollowupRecord | undefined, caseId: string, valid: () => boolean) {
    const modal = dialog(existing ? '更新核查事项' : '新增核查事项', '完成表示人工记录已保存；没有观测依据时，不代表远端风险已经消除。'); const form = el('form', undefined, 'form-grid');
    field(form, '案件 ID', 'caseId', existing?.caseId ?? caseId); field(form, '要核实的问题', 'question', existing?.question ?? '', 'textarea'); field(form, '建议操作', 'suggestedAction', existing?.suggestedAction ?? '', 'textarea'); field(form, '负责角色', 'responsibleRole', existing?.responsibleRole ?? '', 'text', false);
    select(form, '事项状态', 'state', [['open', '待核查'], ['waiting', '待他人确认'], ['completed', '已记录完成']], existing?.state ?? 'open', true); field(form, '截止时间（含时区，可空）', 'dueAt', existing?.dueAt ?? '', 'text', false); field(form, '处理说明与复核记录', 'note', existing?.note ?? '', 'textarea', false);
    submit(form, '保存核查事项', async () => {
      const item: FollowupRecord = { ...(existing ?? { id: crypto.randomUUID(), revision: 1, evidenceRefs: [] }), caseId: value(form, 'caseId'), question: value(form, 'question'), suggestedAction: value(form, 'suggestedAction'), state: value(form, 'state') as FollowupRecord['state'] };
      if (value(form, 'responsibleRole')) item.responsibleRole = value(form, 'responsibleRole'); else delete item.responsibleRole;
      if (value(form, 'dueAt')) item.dueAt = parseInstant(value(form, 'dueAt')); else delete item.dueAt;
      if (value(form, 'note')) item.note = value(form, 'note'); else delete item.note;
      await invoke('followups.put', { item, expectedRevision: existing?.revision ?? 0 }); if (modal.valid() && valid()) { modal.close(); await showFollowups(item.caseId); ctx.notify('核查记录已保存。'); }
    }); modal.body.append(form);
  }
  async function showFollowups(caseId?: string, cursor?: string) {
    const page = begin('followups'), list = card('人工核查事项', '负责角色、期限、处理说明和观测依据分别保留', button('新增核查事项', () => editFollowup(undefined, caseId ?? '', page.valid), 'button primary', 'plus'));
    const form = el('form', undefined, 'filter-bar'); field(form, '限定案件 ID（可空）', 'caseId', caseId ?? '', 'text', false); select(form, '事项状态', 'state', [['', '全部事项'], ['open', '待核查'], ['waiting', '待他人确认'], ['completed', '已记录完成']]);
    const results = el('div');
    async function load(next?: string) {
      try {
        const data = await invoke('followups.search', { ...(value(form, 'caseId') ? { caseId: value(form, 'caseId') } : {}), ...(value(form, 'state') ? { state: value(form, 'state') as FollowupRecord['state'] } : {}), page: { limit: 20, ...(next ? { cursor: next } : {}) } }); if (!page.valid()) return;
        const grid = table(['问题 / 建议操作', '负责角色', '状态', '截止时间', '']);
        for (const item of data.items) { const title = el('div', undefined, 'table-title'); title.append(el('strong', item.question), el('p', item.suggestedAction, 'small muted')); grid.row([title, item.responsibleRole ?? '待确认', state(item.state), item.dueAt ? formatTime(item.dueAt) : '未设置', button('处理记录', () => editFollowup(item, item.caseId, page.valid), 'button ghost small-button', 'arrow')]); }
        results.replaceChildren(data.items.length ? grid.root : empty('没有匹配核查事项', '可从已有案件创建具体、可操作的待确认问题。', undefined, 'followups'));
        if (data.nextCursor) results.append(button('下一页事项', () => void run(undefined, () => load(data.nextCursor)), 'button secondary small-button', 'arrow'));
      } catch (reason) { if (page.valid()) results.replaceChildren(empty('核查服务尚不可用', reason instanceof Error ? reason.message : '读取失败', button('重新读取', () => void run(undefined, () => load()), 'button secondary', 'refresh'), 'followups')); }
    }
    submit(form, '筛选事项', () => load()); list.body.append(form, results); page.body.append(list.root); await load(cursor);
  }
  return { showReports, showFollowups, reportSummary };
}
