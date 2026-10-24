import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, chmodSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, fsyncSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StorageDependencies } from './types.js';
type Cell = null | string | number | {
    blob: string;
};
type Snapshot = {
    version: 1;
    schemaVersion: number;
    tables: {
        name: string;
        columns: string[];
        rows: Cell[][];
    }[];
};
export interface Durability {
    prepare(): {
        commit(): void;
        abort(): void;
    };
    restore(): void;
    close(): void;
}
const quote = (name: string) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(name))
        throw Error('Invalid schema identifier');
    return '"' + name + '"';
};
function layout(db: DatabaseSync) {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') ORDER BY name").all() as {
        name: string;
    }[]).map(({ name }) => ({ name, columns: (db.prepare(`PRAGMA table_info(${quote(name)})`).all() as {
            name: string;
        }[]).map(c => c.name) }));
}
function capture(db: DatabaseSync): Snapshot {
    const version = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
        version: number;
    };
    return {
        version: 1, schemaVersion: version.version, tables: layout(db).map(table => ({ ...table, rows: (db.prepare(`SELECT ${table.columns.map(quote).join(',')} FROM ${quote(table.name)}`).all() as Record<string, unknown>[]).map(row => table.columns.map(name => {
                const value = row[name];
                if (value instanceof Uint8Array)
                    return { blob: Buffer.from(value).toString('base64') };
                if (value === null || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value))
                    return value;
                throw Error('Invalid stored cell');
            })) }))
    };
}
function parse(text: string): Snapshot {
    if (Buffer.byteLength(text) > 64 * 1024 * 1024)
        throw Error('Encrypted database exceeds 64 MiB limit');
    const value = JSON.parse(text) as Snapshot;
    if (!value || Object.keys(value).sort().join(',') !== 'schemaVersion,tables,version' || value.version !== 1 || !Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1 || value.schemaVersion > 9999 || !Array.isArray(value.tables) || value.tables.length > 100)
        throw Error('Invalid encrypted database');
    for (const table of value.tables) {
        if (!table || Object.keys(table).sort().join(',') !== 'columns,name,rows' || typeof table.name !== 'string' || !Array.isArray(table.columns) || !table.columns.length || table.columns.length > 100 || table.columns.some(c => typeof c !== 'string') || !Array.isArray(table.rows))
            throw Error('Invalid snapshot table');
        for (const row of table.rows) {
            if (!Array.isArray(row) || row.length !== table.columns.length)
                throw Error('Invalid snapshot row');
            for (const cell of row) {
                if (cell === null || typeof cell === 'string' || typeof cell === 'number' && Number.isFinite(cell))
                    continue;
                if (cell && typeof cell === 'object' && Object.keys(cell).join(',') === 'blob' && typeof cell.blob === 'string' && Buffer.from(cell.blob, 'base64').toString('base64') === cell.blob)
                    continue;
                throw Error('Invalid snapshot cell');
            }
        }
    }
    return value;
}
export function restoreSnapshot(db: DatabaseSync, snapshot: Snapshot) {
    const expected = layout(db), actual = snapshot.tables.map(({ name, columns }) => ({ name, columns }));
    if (JSON.stringify(expected) !== JSON.stringify(actual))
        throw Error('Snapshot schema does not match signed migrations');
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    try {
        for (const table of expected)
            db.exec(`DELETE FROM ${quote(table.name)}`);
        // AUTOINCREMENT high-water marks are restored last, including when all events were removed.
        for (const table of [...snapshot.tables.filter(t => t.name !== 'sqlite_sequence'), ...snapshot.tables.filter(t => t.name === 'sqlite_sequence')]) {
            if (table.name === 'sqlite_sequence')
                db.exec('DELETE FROM sqlite_sequence');
            const statement = db.prepare(`INSERT INTO ${quote(table.name)}(${table.columns.map(quote).join(',')}) VALUES(${table.columns.map(() => '?').join(',')})`);
            for (const row of table.rows)
                statement.run(...row.map(cell => cell !== null && typeof cell === 'object' ? Buffer.from(cell.blob, 'base64') : cell));
        }
        if (db.prepare('PRAGMA foreign_key_check').all().length || Object.values(db.prepare('PRAGMA integrity_check').get() ?? {})[0] !== 'ok')
            throw Error('Snapshot integrity failed');
        db.exec('COMMIT');
    }
    catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
    finally {
        db.exec('PRAGMA foreign_keys=ON');
    }
}
/** SQLite stays in memory (including temporary pages). Only a complete signed ciphertext
 * snapshot reaches disk. The fixed migration DDL creates the schema; snapshot data cannot
 * inject SQL. This mode is bounded to 64 MiB and intentionally does not claim on-disk WAL.
 */
export function openEncryptedSnapshot(sqlitePath: string, protection: NonNullable<StorageDependencies['encryption']>) {
    if (existsSync(sqlitePath))
        throw Error('Legacy plaintext database requires an explicit migration');
    const filename = sqlitePath.replace(/\.sqlite$/, '.ngdb'), lock = filename + '.lock';
    for (const path of [filename, lock])
        if (existsSync(path) && lstatSync(path).isSymbolicLink())
            throw Error('Unsafe encrypted database path');
    // A data-free SQLite lock uses OS file locking, which releases on process death.
    // Never unlink a live lock inode or infer stale ownership from a reusable PID.
    const lease = new DatabaseSync(lock);
    let closed = false;
    try {
        chmodSync(lock, 0o600);
        lease.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS lease_marker(id INTEGER PRIMARY KEY CHECK(id=1)); PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE');
    }
    catch (error) {
        lease.close();
        throw error;
    }
    const close = () => {
        if (closed)
            return;
        closed = true;
        lease.close();
    };
    try {
        const snapshot = existsSync(filename) ? parse(protection.decrypt(readFileSync(filename))) : undefined;
        return {
            snapshot, close, attach(db: DatabaseSync): Durability {
                let committed = capture(db);
                function prepare() {
                    if (closed)
                        throw Error('Encrypted storage closed');
                    const candidate = capture(db), serialized = JSON.stringify(candidate);
                    if (Buffer.byteLength(serialized) > 64 * 1024 * 1024)
                        throw Error('Encrypted database exceeds 64 MiB limit');
                    const temporary = filename + '.' + randomUUID() + '.tmp';
                    const encrypted = protection.encrypt(serialized);
                    const descriptor = openSync(temporary, 'wx', 0o600);
                    try {
                        writeFileSync(descriptor, encrypted);
                        fsyncSync(descriptor);
                    }
                    catch (error) {
                        closeSync(descriptor);
                        unlinkSync(temporary);
                        throw error;
                    }
                    closeSync(descriptor);
                    let finished = false;
                    return { commit() {
                            renameSync(temporary, filename);
                            finished = true;
                            committed = candidate;
                            if (process.platform !== 'win32') {
                                let directory: number | undefined;
                                try {
                                    directory = openSync(dirname(filename), 'r');
                                    fsyncSync(directory);
                                }
                                catch { /* Published snapshot remains valid; directory fsync is not supported by every filesystem. */
                                }
                                finally {
                                    if (directory !== undefined)
                                        closeSync(directory);
                                }
                            }
                        }, abort() {
                            if (!finished)
                                try {
                                    unlinkSync(temporary);
                                }
                                catch { /* Preserve original snapshot. */
                                }
                        } };
                }
                // Publish migrations before admitting business work. A failed publish preserves the old file.
                const initial = prepare();
                try {
                    initial.commit();
                }
                finally {
                    initial.abort();
                }
                return {
                    prepare, restore: () => restoreSnapshot(db, committed), close
                };
            }
        };
    }
    catch (error) {
        close();
        throw error;
    }
}
