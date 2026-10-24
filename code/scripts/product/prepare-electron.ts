import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const manifest = JSON.parse(await readFile('node_modules/electron/package.json', 'utf8'));
const version: string = manifest.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid locked Electron version');
if (!['win32', 'linux'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) throw new Error('Unsupported acceptance platform');
const name = `electron-v${version}-${process.platform}-${process.arch}.zip`;
const checksums = JSON.parse(await readFile('node_modules/electron/checksums.json', 'utf8'));
const expected: string = checksums[name];
if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('Missing official Electron checksum');
const cache = resolve('.cache/electron'); await mkdir(cache, { recursive: true });
const archive = join(cache, name);
try { await access(archive); } catch {
  const response = await fetch(`https://github.com/electron/electron/releases/download/v${version}/${name}`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Official Electron download returned ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Electron download checksum mismatch');
  await writeFile(archive, bytes);
}
if (createHash('sha256').update(await readFile(archive)).digest('hex') !== expected) throw new Error('Cached Electron checksum mismatch');
const directory = resolve(`.local/electron-${version}`); await mkdir(directory, { recursive: true });
const executable = join(directory, process.platform === 'win32' ? 'electron.exe' : 'electron');
try { await access(executable); } catch {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(directory)} -Force`], { stdio: 'inherit', windowsHide: true })
    : spawnSync('unzip', ['-q', archive, '-d', directory], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Verified Electron extraction failed');
}
await access(executable);
console.log(`Prepared official Electron ${version} for ${process.platform}/${process.arch}; SHA256 verified; no dependency hook executed.`);
