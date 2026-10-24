import { stateText, stateTone } from './model.js';

// Static local SVG paths keep the renderer offline and avoid an icon/font CDN or a privileged dependency.
const paths: Record<string, string> = {
  shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Zm-4 9 3 3 5-6',
  overview: 'M3 3h7v7H3z M14 3h7v11h-7z M3 14h7v7H3z M14 18h7v3h-7z',
  alerts: 'M12 3 2 21h20L12 3Zm0 6v5m0 3v1',
  cases: 'M3 7h7l2-3h8a1 1 0 0 1 1 1v14H3V7Zm1 4h16',
  devices: 'M4 3h16v7H4z M4 14h16v7H4z M7 6h.01M7 17h.01M11 6h6m-6 11h6',
  business: 'M4 21V7h16v14M8 7V3h8v4M8 11h1m6 0h1m-8 4h1m6 0h1m-5 6v-3h2v3',
  requests: 'M8 3H3v5m18 0V3h-5M3 16v5h5m8 0h5v-5M7 12h3l2-5 2 10 2-5h2',
  followups: 'M9 5H4v16h16V5h-5M9 3h6v4H9z M8 12l2 2 5-4m-7 8h8',
  reports: 'M5 3h10l4 4v14H5V3Zm10 0v5h4M8 12h8m-8 4h5',
  connections: 'M8 3v5m8-5v5M5 8h14v3a7 7 0 0 1-7 7v4m0-4a7 7 0 0 1-7-7',
  architecture: 'M9 3h6v6H9z M2 16h6v6H2z M16 16h6v6h-6z M12 9v4M5 16v-3h14v3',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm-2-5h4l1 3 3-1 2 3-2 3 2 2-2 4-3-1-1 3h-4l-1-3-3 1-2-4 2-2-2-3 2-3 3 1 1-3Z',
  search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6',
  plus: 'M12 5v14M5 12h14', refresh: 'M20 7V3m0 4h-4m4 0a9 9 0 1 0 1 8',
  arrow: 'M5 12h14m-6-6 6 6-6 6', close: 'm6 6 12 12M6 18 18 6',
  moon: 'M20 14A9 9 0 0 1 10 4a9 9 0 1 0 10 10Z', sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0-5v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1',
  menu: 'M4 6h16M4 12h16M4 18h16', clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3 2',
  check: 'm5 12 4 4L19 6', download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 7v7m0-10v1',
};
export function createUi(doc: Document) {
  function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
    const result = doc.createElement(tag);
    if (text !== undefined) result.textContent = text;
    if (className) result.className = className;
    return result;
  }
  function icon(name: string) {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'icon');
    const path = doc.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths[name] ?? paths.info!); svg.append(path);
    return svg;
  }
  function button(label: string, action: () => void, className = 'button secondary', glyph?: string) {
    const result = el('button', undefined, className); result.type = 'button';
    if (glyph) result.append(icon(glyph));
    result.append(el('span', label)); result.addEventListener('click', action); return result;
  }
  function chip(label: string, tone = 'neutral') { return el('span', label, `chip ${tone}`); }
  function state(value: string, label = stateText(value)) { return chip(label, stateTone(value)); }
  function card(title: string, description?: string, action?: HTMLElement) {
    const root = el('section', undefined, 'card'), head = el('div', undefined, 'card-head'), labels = el('div');
    labels.append(el('h2', title)); if (description) labels.append(el('p', description, 'muted small'));
    head.append(labels); if (action) head.append(action); root.append(head);
    const body = el('div', undefined, 'card-body'); root.append(body); return { root, body, head };
  }
  function empty(title: string, description: string, action?: HTMLElement, glyph = 'cases') {
    const root = el('div', undefined, 'empty'); root.append(icon(glyph), el('h3', title), el('p', description, 'muted'));
    if (action) root.append(action); return root;
  }
  function notice(text: string, tone = 'info') { const root = el('div', undefined, `notice ${tone}`); root.append(icon('info'), el('p', text)); return root; }
  function field(form: HTMLElement, label: string, name: string, value = '', type = 'text', required = true) {
    const wrapper = el('label', undefined, `field${type === 'textarea' ? ' wide' : ''}${type === 'checkbox' ? ' check-field' : ''}`);
    const control = type === 'textarea' ? el('textarea') : el('input');
    control.name = name; control.value = value; control.required = required;
    if (control.tagName === 'INPUT') (control as HTMLInputElement).type = type;
    if (type === 'checkbox') wrapper.append(control, el('span', label)); else wrapper.append(el('span', label), control);
    form.append(wrapper); return control;
  }
  function select(form: HTMLElement, label: string, name: string, options: readonly (readonly [string, string])[], value = '', required = false) {
    const wrapper = el('label', undefined, 'field'), control = el('select'); control.name = name; control.required = required;
    for (const [key, text] of options) { const option = el('option', text); option.value = key; control.append(option); }
    if (value) control.value = value;
    wrapper.append(el('span', label), control); form.append(wrapper); return control;
  }
  function table(headers: string[]) {
    const root = el('div', undefined, 'table-scroll'), table = el('table'), head = el('thead'), row = el('tr'), body = el('tbody');
    for (const label of headers) { const th = el('th', label); th.scope = 'col'; row.append(th); }
    head.append(row); table.append(head, body); root.append(table);
    return { root, body, row(values: (string | Node)[]) { const tr = el('tr'); for (const value of values) { const td = el('td'); if (typeof value === 'string') td.textContent = value; else td.append(value); tr.append(td); } body.append(tr); return tr; } };
  }
  function disclosure(title: string, content: Node) { const result = el('details', undefined, 'disclosure'); result.append(el('summary', title), content); return result; }
  function facts(values: [string, string][]) {
    const root = el('dl', undefined, 'facts'); for (const [label, value] of values) { const pair = el('div'); pair.append(el('dt', label), el('dd', value)); root.append(pair); } return root;
  }
  return { el, icon, button, chip, state, card, empty, notice, field, select, table, disclosure, facts };
}
export type Ui = ReturnType<typeof createUi>;
