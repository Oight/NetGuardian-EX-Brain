import type { AlertStatistics } from '@campussec/contracts';
import type { Ui } from './ui.js';
import { formatTime } from './model.js';

export function renderStatistics(ui: Ui, data: AlertStatistics): HTMLElement {
  const { el } = ui, root = el('div', undefined, 'statistics-grid');
  const trend = ui.card('告警趋势', '按事件时间聚合 · 告警数不等于攻击次数');
  const number = el('div', undefined, 'chart-total');
  number.append(el('strong', `${data.total.value.toLocaleString()}${data.total.relation === 'gte' ? '+' : ''}`), el('span', '窗口内告警', 'muted small'));
  trend.body.append(number);
  const doc = root.ownerDocument, ns = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 680 190'); svg.setAttribute('role', 'img'); svg.setAttribute('class', 'trend-chart');
  const title = doc.createElementNS(ns, 'title'); title.textContent = `当前窗口共有 ${data.total.value}${data.total.relation === 'gte' ? ' 条或更多' : ' 条'}告警；趋势见下方数据表`; svg.append(title);
  const max = Math.max(1, ...data.byHour.map(bucket => bucket.count));
  for (let i = 0; i < 4; i++) {
    const line = doc.createElementNS(ns, 'line'); const y = 14 + i * 46;
    for (const [k, v] of Object.entries({ x1: '36', x2: '666', y1: String(y), y2: String(y), class: 'chart-grid' })) line.setAttribute(k, v);
    const label = doc.createElementNS(ns, 'text'); label.setAttribute('x', '1'); label.setAttribute('y', String(y + 4)); label.textContent = String(Math.round(max * (1 - i / 3))); svg.append(line, label);
  }
  const points = data.byHour.map((bucket, i) => `${36 + i * 630 / Math.max(1, data.byHour.length - 1)},${152 - bucket.count / max * 138}`);
  if (points.length) {
    const area = doc.createElementNS(ns, 'polygon'); area.setAttribute('points', `36,152 ${points.join(' ')} ${points.at(-1)!.split(',')[0]},152`); area.setAttribute('class', 'chart-area');
    const line = doc.createElementNS(ns, 'polyline'); line.setAttribute('points', points.join(' ')); line.setAttribute('class', 'chart-line'); svg.append(area, line);
    for (const index of [...new Set([0, Math.floor((data.byHour.length - 1) / 2), data.byHour.length - 1])]) {
      const text = doc.createElementNS(ns, 'text'); text.setAttribute('x', String(36 + index * 630 / Math.max(1, data.byHour.length - 1))); text.setAttribute('y', '182'); text.setAttribute('text-anchor', index === 0 ? 'start' : index === data.byHour.length - 1 ? 'end' : 'middle'); text.textContent = formatTime(data.byHour[index]!.start, data.scope.timeZone); svg.append(text);
    }
    trend.body.append(svg);
  } else trend.body.append(ui.empty('没有可绘制的时间桶', '聚合没有返回趋势数据；请查看查询覆盖。', undefined, 'requests'));
  const source = ui.table(['小时起点', '告警数']); for (const bucket of data.byHour) source.row([formatTime(bucket.start, data.scope.timeZone), String(bucket.count)]);
  trend.body.append(ui.disclosure('查看图表数据', source.root));
  const distribution = ui.card('原始等级分布', '保留 Wazuh rule.level，不生成风险评分');
  const total = data.byLevel.reduce((sum, bucket) => sum + bucket.count, 0);
  for (const range of [{ label: 'L12–15', min: 12, max: 15, tone: 'danger' }, { label: 'L7–11', min: 7, max: 11, tone: 'warning' }, { label: 'L0–6', min: 0, max: 6, tone: 'primary' }]) {
    const count = data.byLevel.filter(bucket => bucket.level >= range.min && bucket.level <= range.max).reduce((sum, bucket) => sum + bucket.count, 0);
    const row = el('div', undefined, 'distribution-row'), top = el('div', undefined, 'between'); top.append(ui.chip(range.label, range.tone), el('strong', count.toLocaleString()));
    const progress = el('progress'); progress.max = Math.max(1, total); progress.value = count; progress.className = range.tone; progress.setAttribute('aria-label', `${range.label}：${count} 条`); row.append(top, progress); distribution.body.append(row);
  }
  distribution.body.append(ui.notice(`查询${data.coverage.queryCompleteness === 'complete' ? '完整' : '存在缺口'} · 采集覆盖${data.coverage.collectionCoverage === 'known' ? '已知' : '未完全确认'}`,
    data.coverage.queryCompleteness === 'complete' ? 'info' : 'warning'));
  if (data.coverage.reasons.length) distribution.body.append(el('p', data.coverage.reasons.join('；'), 'small muted'));
  distribution.body.append(el('p', `${formatTime(data.scope.from, data.scope.timeZone)} — ${formatTime(data.scope.to, data.scope.timeZone)} · ${data.scope.timeZone}`, 'small muted'));
  root.append(trend.root, distribution.root); return root;
}
