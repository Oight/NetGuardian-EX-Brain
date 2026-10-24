import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectRendererCss, inspectRendererHtml, inspectRendererModule, rendererImport, rendererPrivacyFindings } from '../../scripts/product/renderer-checks.js';

test('file renderer imports reject package resolution, remote URLs and escape from packaged resources', () => {
  assert.equal(rendererImport('view.js', './app.js'), 'app.js');
  assert.equal(rendererImport('views/detail.js', '../api.js'), 'api.js');
  for (const path of ['electron', '@campussec/contracts', 'https://example.invalid/a.js', '../app.js', './app.js?test', '/app.js', '.\\app.js']) assert.equal(rendererImport('view.js', path), undefined);
  const valid = inspectRendererModule('view.js', 'import {mount} from "./app.js"; mount(window.campusSec);');
  assert.deepEqual(valid.errors, []); assert.deepEqual(valid.imports, ['app.js']);
});
test('renderer dependency checks catch network APIs, unsafe HTML and URL mutation that would break pinned IPC', () => {
  for (const source of ['import "electron";', 'import(name);', 'fetch("/api");', 'window.fetch("/api");', 'new WebSocket("wss://example.invalid");', 'process.env.SECRET;', 'Bun.file("x");', 'node.innerHTML = data;', 'history.pushState({}, "", "#cases");', 'location.hash = "cases";']) assert.ok(inspectRendererModule('view.js', source).errors.length, 'Unsafe renderer fixture should fail');
});
test('production HTML and CSS checks catch preview bridges, relaxed CSP and external assets', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile('apps/desktop/renderer/index.html', 'utf8');
  assert.deepEqual(inspectRendererHtml(html), []);
  for (const altered of [html.replace("connect-src 'none'", "connect-src 'self'"), html.replace("form-action 'none'", "form-action 'none'; script-src-elem 'unsafe-inline'"), html.replace('./view.js', '/fixture.js'), html.replace('</body>', '<script>alert(1)</script></body>'), html.replace('<main ', '<main onclick="x()" ')]) assert.ok(inspectRendererHtml(altered).length);
  assert.deepEqual(inspectRendererCss('body { color: #123456; }'), []);
  assert.ok(inspectRendererCss('@import "https://example.invalid/font.css";').length);
  assert.ok(inspectRendererCss('body{background:url(./unpackaged.png)}').length);
});
test('privacy failures expose categories without echoing sensitive values', () => {
  const examples = ['/home/developer/private/', 'C:\\Users\\developer\\private', 'https://10.20.30.40:55000', '-----BEGIN PRIVATE KEY-----', 'Bearer syntheticCredentialValueWithEnoughCharacters'];
  for (const value of examples) { const findings = rendererPrivacyFindings(value); assert.ok(findings.length); assert.equal(JSON.stringify(findings).includes(value), false); }
  assert.deepEqual(rendererPrivacyFindings('https://example.invalid · 本地工作空间'), []);
});
