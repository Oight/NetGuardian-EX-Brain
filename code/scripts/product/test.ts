import { spawnSync } from 'node:child_process';
import { sourceFiles } from './files.ts';

function run(args: string[]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const tests = (await sourceFiles(['packages', 'apps', 'tests'])).filter(path => path.endsWith('.test.ts'));
if (!tests.length) throw new Error('No tests found');
// Explicit source paths avoid running stale dist-test files and work without shell glob expansion.
if (process.versions.bun) run(['test', ...tests.map(path => './' + path)]);
else {
  run(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.test.json']);
  run(['--test', ...tests.map(path => 'dist-test/' + path.replace(/\.ts$/, '.js'))]);
}
