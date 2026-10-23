import type {DatabaseSync} from "node:sqlite";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import type {StorageDependencies} from "./types.js";
const checksum=(text:string)=>createHash("sha256").update(text).digest("hex");
export async function migrate(connection:DatabaseSync,deps:StorageDependencies):Promise<void>{
    const ddl = await readFile(new URL('../migrations/0001.sql', import.meta.url), 'utf8');
    const expectedChecksum = checksum(ddl);
    const tables = connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    if (tables.length) {
      if (!tables.some(row => row.name === 'schema_migrations') || !tables.some(row => row.name === 'space_metadata')) throw new Error('Unmanaged database');
      const migrations = connection.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all() as { version: number; checksum: string }[];
      if (migrations.length !== 1 || migrations[0]?.version !== 1 || migrations[0].checksum !== expectedChecksum) throw new Error('Migration checksum mismatch');
      const metadata = connection.prepare('SELECT space_id,principal_id,identity_epoch FROM space_metadata').all() as { space_id: string; principal_id: string; identity_epoch: number }[];
      if (metadata.length !== 1 || metadata[0]?.space_id !== deps.spaceId || metadata[0].principal_id !== deps.principalId || metadata[0].identity_epoch !== deps.identityEpoch) throw new Error('Space identity mismatch');
      const expectedTables = Array.from(ddl.matchAll(/^CREATE TABLE (\w+)/gm), match => match[1]).sort();
      if (tables.map(row => row.name).sort().join(',') !== expectedTables.join(',')) throw new Error('Schema table mismatch');
    } else {
      connection.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
      try {
        connection.exec(ddl);
        connection.prepare('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)').run(1, expectedChecksum, deps.clock.now());
        connection.prepare('INSERT INTO space_metadata(space_id,principal_id,identity_epoch) VALUES(?,?,?)').run(deps.spaceId, deps.principalId, deps.identityEpoch);
        connection.exec('COMMIT');
      } catch (error) { connection.exec('ROLLBACK'); throw error; }
    }
    connection.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    if (Object.values(connection.prepare('PRAGMA integrity_check').get() ?? {})[0] !== 'ok' || connection.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Database integrity check failed');
}
