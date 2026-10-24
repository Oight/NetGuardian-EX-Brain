import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, rename, mkdir, rm, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createStorage } from '@campussec/storage';
import { FakeClock, FakeIds, SPACE, PRINCIPAL, CASE, context } from '@campussec/testkit';
import { ok, fail, type Result } from '@campussec/contracts';
import { temporaryDirectory, seedCase } from '../../../tests/support/storage.js';
import { generateIdentityKeys, publicIdentity, seal, openSealed } from '../main/cryptography.js';
function take<T>(r: Result<T>): T {
    assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.error));
    return r.value;
}
async function fixture() {
    const directory = await temporaryDirectory(), keys = generateIdentityKeys(), peer = publicIdentity(keys);
    let broken = false;
    const encryption = { encrypt: (text: string) => {
            if (broken)
                throw Error('Synthetic encryption failure');
            return Buffer.from(seal(Buffer.from(text), 'database:synthetic', keys, peer));
        }, decrypt: (bytes: Uint8Array) => openSealed(Buffer.from(bytes).toString(), 'database:synthetic', keys, peer).toString() };
    const deps = {
        dataDir: directory.path, spaceId: SPACE, principalId: PRINCIPAL, identityEpoch: 1, clock: new FakeClock(), ids: new FakeIds(), encryption
    };
    const storage = take(await createStorage(deps));
    return {
        directory, deps, storage, path: join(directory.path, 'spaces', SPACE, 'state.ngdb'), breakEncryption: (value: boolean) => {
            broken = value;
        }
    };
}
test('encrypted SQLite persists cases/events and AUTOINCREMENT high-water marks without plaintext database, WAL, SHM or temporary pages', async () => {
    const f = await fixture();
    let storage = f.storage;
    try {
        take(await storage.db.write(context(), tx => {
            seedCase(tx);
            storage.events.appendInTx(tx, context(), {
                type: 'case.changed', aggregateId: CASE, revision: 1, payload: {
                    caseId: CASE, revision: 1, reason: 'Sensitive synthetic event'
                }
            });
            tx.run('DELETE FROM domain_events');
            return ok(undefined);
        }));
        const files = await readdir(join(f.directory.path, 'spaces', SPACE));
        assert.ok(files.includes('state.ngdb'));
        assert.ok(!files.some(n => /sqlite|wal|shm/.test(n)));
        const encrypted = await readFile(f.path, 'utf8');
        assert.ok(!encrypted.includes('合成案件') && !encrypted.includes('Sensitive synthetic event'));
        assert.equal(JSON.parse(encrypted).suite, 'Ed25519+X25519+HKDF-SHA256+AES-256-GCM');
        await storage.close();
        storage = take(await createStorage(f.deps));
        assert.equal(take(await storage.db.read(context(), tx => tx.get<{
            title: string;
        }>('SELECT title FROM cases WHERE id=?', [CASE])))?.title, '合成案件');
        take(await storage.db.write(context(), tx => {
            storage.events.appendInTx(tx, context(), {
                type: 'case.changed', aggregateId: CASE, revision: 2, payload: {
                    caseId: CASE, revision: 2, reason: 'after reopen'
                }
            });
            return ok(undefined);
        }));
        assert.equal(take(await storage.db.read(context(), tx => tx.get<{
            seq: number;
        }>('SELECT seq FROM domain_events')))?.seq, 2);
    }
    finally {
        await storage.close();
        await f.directory.dispose();
    }
});
test('encryption failure and post-COMMIT publication failure restore all business state and events with no successful partial write', async () => {
    const f = await fixture();
    try {
        take(await f.storage.db.write(context(), tx => {
            seedCase(tx);
            return ok(undefined);
        }));
        const before = await readFile(f.path, 'utf8');
        const write = () => f.storage.db.write(context(), tx => {
            tx.run('UPDATE cases SET title=? WHERE id=?', ['must rollback', CASE]);
            f.storage.events.appendInTx(tx, context(), {
                type: 'case.changed', aggregateId: CASE, revision: 2, payload: {
                    caseId: CASE, revision: 2, reason: 'must rollback'
                }
            });
            return ok(undefined);
        });
        f.breakEncryption(true);
        assert.equal((await write()).ok, false);
        f.breakEncryption(false);
        assert.equal(await readFile(f.path, 'utf8'), before);
        await rename(f.path, f.path + '.original');
        await mkdir(f.path);
        assert.equal((await write()).ok, false);
        assert.equal(take(await f.storage.db.read(context(), tx => tx.get<{
            title: string;
        }>('SELECT title FROM cases WHERE id=?', [CASE])))?.title, '合成案件');
        assert.equal(take(await f.storage.events.read(context(), { afterSeq: 0, limit: 20 })).events.length, 0);
        await rm(f.path, { recursive: true });
        await rename(f.path + '.original', f.path);
        assert.equal(await readFile(f.path, 'utf8'), before);
        assert.ok(!(await readdir(join(f.directory.path, 'spaces', SPACE))).some(n => n.endsWith('.tmp')));
        take(await write());
    }
    finally {
        await f.storage.close();
        await f.directory.dispose();
    }
});
test('tampering, wrong identity and concurrent opens preserve ciphertext and refuse plaintext fallback', async () => {
    const f = await fixture();
    try {
        assert.equal((await createStorage(f.deps)).ok, false, 'Exclusive lease');
        await f.storage.close();
        const original = await readFile(f.path, 'utf8');
        const corrupt = JSON.parse(original);
        corrupt.ciphertext = (corrupt.ciphertext.startsWith('A') ? 'B' : 'A') + corrupt.ciphertext.slice(1);
        await writeFile(f.path, JSON.stringify(corrupt));
        assert.equal((await createStorage(f.deps)).ok, false);
        assert.equal(await readFile(f.path, 'utf8'), JSON.stringify(corrupt));
        await writeFile(f.path, original);
        assert.equal((await createStorage({ ...f.deps, principalId: crypto.randomUUID() })).ok, false);
        const good = take(await createStorage(f.deps));
        await good.close();
        await writeFile(join(f.directory.path, 'spaces', SPACE, 'state.sqlite'), 'synthetic legacy file');
        assert.equal((await createStorage(f.deps)).ok, false);
        assert.equal(await readFile(join(f.directory.path, 'spaces', SPACE, 'state.sqlite'), 'utf8'), 'synthetic legacy file');
    }
    finally {
        await f.storage.close();
        await f.directory.dispose();
    }
});
test('encrypted storage lock releases after a separate process dies and the last committed snapshot reopens', async () => {
    const { spawn } = await import('node:child_process');
    const f = await fixture();
    let child: ReturnType<typeof spawn> | undefined;
    try {
        take(await f.storage.db.write(context(), tx => {
            seedCase(tx);
            return ok(undefined);
        }));
        await f.storage.close();
        const code = `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');process.stdout.write(JSON.stringify({argv:process.argv,cwd:process.cwd(),databases:db.prepare('PRAGMA database_list').all()}));setInterval(()=>db.prepare('SELECT 1').get(),1000);`;
        child = spawn(process.execPath, ['-e', code, f.path + '.lock'], { stdio: ['ignore', 'pipe', 'pipe'] });
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('Lock child timeout')), 5000);
            child!.once('error', reject);
            let diagnostic = '';
            child!.stderr!.on('data', bytes => {
                diagnostic += String(bytes).slice(0, 2000);
            });
            child!.once('close', code => {
                clearTimeout(timer);
                reject(Error('Lock child exited: ' + code + ' ' + diagnostic));
            });
            child!.stdout!.once('data', bytes => {
                clearTimeout(timer);
                const report = JSON.parse(String(bytes));
                assert.ok(report.databases[0].file.endsWith(f.path + '.lock'), JSON.stringify(report));
                resolve();
            });
        });
        assert.equal((await createStorage(f.deps)).ok, false);
        const ended = new Promise<void>(resolve => child!.once('close', () => resolve()));
        child.kill('SIGKILL');
        await ended;
        child = undefined;
        const storage = take(await createStorage(f.deps));
        assert.equal(take(await storage.db.read(context(), tx => tx.get<{
            title: string;
        }>('SELECT title FROM cases WHERE id=?', [CASE])))?.title, '合成案件');
        await storage.close();
    }
    finally {
        child?.kill('SIGKILL');
        await f.storage.close();
        await f.directory.dispose();
    }
});
