import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { StorageDependencies } from "./types.js";
export async function migrate(
  connection: DatabaseSync,
  deps: StorageDependencies,
  through?: number,
): Promise<void> {
  connection.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const directory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => /^\d{4}[-\w]*\.sql$/.test(name))
    .sort();
  const available = await Promise.all(
    names.map(async (name) => {
      const sql = await readFile(new URL(name, directory), "utf8");
      return {
        version: Number(name.slice(0, 4)),
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
  const migrations=through===undefined?available:available.filter(m=>m.version<=through);
  if(through!==undefined&&migrations.length!==through)throw Error("Unknown encrypted schema version");
  if (!migrations.length || migrations.some((m, i) => m.version !== i + 1))
    throw new Error("Invalid migration sequence");
  const tables = () =>
    (
      connection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as {
        name: string;
      }[]
    )
      .map((row) => row.name)
      .sort();
  let applied = 0;
  if (tables().length) {
    const stored = connection
      .prepare(
        "SELECT version,checksum FROM schema_migrations ORDER BY version",
      )
      .all() as {
      version: number;
      checksum: string;
    }[];
    if (
      !stored.length ||
      stored.length > migrations.length ||
      stored.some(
        (m, i) =>
          m.version !== migrations[i]?.version ||
          m.checksum !== migrations[i]?.checksum,
      )
    )
      throw new Error("Migration checksum mismatch");
    const metadata = connection
      .prepare(
        "SELECT space_id,principal_id,identity_epoch FROM space_metadata",
      )
      .all() as {
      space_id: string;
      principal_id: string;
      identity_epoch: number;
    }[];
    if (
      metadata.length !== 1 ||
      metadata[0]?.space_id !== deps.spaceId ||
      metadata[0].principal_id !== deps.principalId ||
      metadata[0].identity_epoch !== deps.identityEpoch
    )
      throw new Error("Space identity mismatch");
    applied = stored.length;
    const expected = migrations
      .slice(0, applied)
      .flatMap((m) =>
        Array.from(
          m.sql.matchAll(/^CREATE TABLE (\w+)/gm),
          (match) => match[1]!,
        ),
      )
      .sort();
    if (tables().join(",") !== expected.join(","))
      throw new Error("Schema table mismatch");
  }
  connection.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;");
  try {
    for (const migration of migrations.slice(applied)) {
      connection.exec(migration.sql);
      connection
        .prepare(
          "INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)",
        )
        .run(migration.version, migration.checksum, deps.clock.now());
      if (migration.version === 1)
        connection
          .prepare(
            "INSERT INTO space_metadata(space_id,principal_id,identity_epoch) VALUES(?,?,?)",
          )
          .run(deps.spaceId, deps.principalId, deps.identityEpoch);
    }
    if (
      Object.values(
        connection.prepare("PRAGMA integrity_check").get() ?? {},
      )[0] !== "ok" ||
      connection.prepare("PRAGMA foreign_key_check").all().length
    )
      throw new Error("Database integrity check failed");
    connection.exec("COMMIT");
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
  connection.exec(
    "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;",
  );
}
