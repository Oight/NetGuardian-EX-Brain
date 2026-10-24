import { posix } from 'node:path';
import ts from 'typescript';

/** File URLs have no package resolver: every emitted import must resolve inside the packaged renderer. */
export function rendererImport(parent: string, target: string): string | undefined {
  if (!/^\.\.?\//.test(target) || /[?#\\]/.test(target) || !target.endsWith('.js')) return;
  const path = posix.normalize(posix.join(posix.dirname(parent), target));
  if (path === '..' || path.startsWith('../') || posix.isAbsolute(path)) return;
  return path;
}

export function inspectRendererModule(path: string, source: string) {
  const errors: string[] = [], imports: string[] = [];
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const error = (message: string) => errors.push(`${path}: ${message}`);
  function dependency(target: string) {
    const resolved = rendererImport(path, target);
    if (!resolved) error('runtime dependency must be a relative packaged JS module');
    else imports.push(resolved);
  }
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) dependency(node.moduleSpecifier.text);
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
      if (['fetch', 'sendBeacon', 'eval', 'Function', 'require', 'insertAdjacentHTML', 'write', 'writeln', 'pushState', 'replaceState'].includes(name)) error('network, code generation, HTML injection or document navigation API');
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const target = node.arguments[0];
        if (target && ts.isStringLiteralLike(target)) dependency(target.text);
        else error('dynamic module path cannot be verified');
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ['XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'Function'].includes(node.expression.text)) error('privileged or network constructor');
    if (ts.isIdentifier(node) && ['Bun', 'process', 'require', 'ipcRenderer', '__dirname', '__filename', 'location', 'sessionStorage'].includes(node.text)) error('privileged runtime, session data storage or document navigation');
    if (ts.isPropertyAccessExpression(node) && ['innerHTML', 'outerHTML', 'srcdoc'].includes(node.name.text)) error('untrusted content must render as text');
    ts.forEachChild(node, visit);
  }
  visit(file);
  return { imports: [...new Set(imports)], errors: [...new Set(errors)] };
}

function attributes(text: string) {
  return new Map([...text.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(match => [match[1]!.toLowerCase(), match[2] ?? match[3] ?? '']));
}
export function inspectRendererHtml(source: string): string[] {
  const errors: string[] = [], metas = [...source.matchAll(/<meta\b([^>]*)>/gi)].map(match => attributes(match[1]!));
  const policies = metas.filter(meta => meta.get('http-equiv')?.toLowerCase() === 'content-security-policy');
  const directives = (policies[0]?.get('content') ?? '').split(';').filter(part => part.trim());
  const policy = new Map(directives.map(part => {
    const [name, ...values] = part.trim().split(/\s+/); return [name!, values.join(' ')];
  }));
  const expected = { 'default-src': "'self'", 'script-src': "'self'", 'style-src': "'self'", 'img-src': "'self' data:", 'connect-src': "'none'", 'object-src': "'none'", 'base-uri': "'none'", 'frame-src': "'none'", 'form-action': "'none'" };
  if (policies.length !== 1 || directives.length !== Object.keys(expected).length || policy.size !== directives.length || Object.entries(expected).some(([key, value]) => policy.get(key) !== value)) errors.push('renderer CSP must allow packaged resources and block direct network/navigation');
  const scripts = [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  if (scripts.length !== 1 || attributes(scripts[0]![1]!).get('src') !== './view.js' || attributes(scripts[0]![1]!).get('type') !== 'module' || scripts[0]![2]!.trim()) errors.push('renderer must boot from the packaged view.js ES module');
  const links = [...source.matchAll(/<link\b([^>]*)>/gi)].map(match => attributes(match[1]!));
  if (links.length !== 1 || links[0]?.get('rel') !== 'stylesheet' || links[0]?.get('href') !== './style.css') errors.push('renderer must load its packaged stylesheet');
  if (/<(?:base|iframe|object|embed)\b|\son[a-z]+\s*=|\sstyle\s*=/i.test(source)) errors.push('inline execution, styling or embedded documents are forbidden');
  return errors;
}

/** Report categories only: a failed check must never echo a discovered secret. Synthetic examples use .invalid. */
export function rendererPrivacyFindings(source: string): string[] {
  return Object.entries({
    'personal home path': /\/(?:home|Users)\/[\w.-]+\/|[A-Z]:[\\/]Users[\\/][^\\/\s]+[\\/]/i,
    'private platform address': /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/,
    'private key': /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/,
    'access key': /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    'embedded bearer credential': /Bearer\s+[A-Za-z0-9._~+\/-]{20,}/,
  }).filter(([, pattern]) => pattern.test(source)).map(([category]) => category);
}

export function inspectRendererCss(source: string): string[] {
  // All icons are local SVG DOM nodes; this UI needs no stylesheet imports, fonts or URL-based assets.
  return /@import\b|\burl\s*\(/i.test(source) ? ['stylesheet introduces an unverified resource dependency'] : [];
}
