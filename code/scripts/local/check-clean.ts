import { cp, mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
if (!process.versions.bun)
    throw new Error('Bun-only clean verification');
const root = process.cwd(), excluded = new Set(['node_modules', 'dist', 'dist-test', '.local', '.cache', '.git', '.idea', '.venv', '__pycache__']);
await mkdir('.local/clean-bun', { recursive: true });
const target = await mkdtemp(resolve('.local/clean-bun/run-'));
for (const entry of await readdir(root))
    if (!excluded.has(entry))
        await cp(resolve(root, entry), resolve(target, entry), { recursive: true, filter: source => !relative(root, source).split(sep).some(part => excluded.has(part)) });
function run(args: string[]) { const result = spawnSync(process.execPath, args, { cwd: target, stdio: 'inherit' }); if (result.error)
    throw result.error; if (result.status !== 0)
    process.exit(result.status ?? 1); }
// Explicitly suppress all lifecycle scripts. Cached packages were inspected before installation.
run(['install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--cache-dir', resolve('.cache/bun')]);
run(['scripts/local/check.ts']);
console.log('PASS: clean Bun source copy, frozen offline install, build before tests; no existing dist was consumed.');
console.log('No Node.js, Electron, Windows or installer acceptance was executed.');
