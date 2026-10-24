import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createStorage } from "@campussec/storage";
import { canonicalJson, type WriteTx } from "@campussec/contracts";
import {
  CASE,
  CONNECTION,
  PRINCIPAL,
  SPACE,
  FakeClock,
  FakeIds,
  scope,
} from "@campussec/testkit";

/** Synthetic integration data only; this is not an S04/S06 business implementation. */
export function seedCase(tx: WriteTx) {
  tx.run(
    "INSERT INTO connections(id,platform_instance_id,display_name,generation,alerts_pattern,mapping_version,principal_fingerprint,updated_at) VALUES(?,?,?,?,?,?,?,?)",
    [
      CONNECTION,
      SPACE,
      "合成连接",
      1,
      "synthetic-*",
      "v1",
      "synthetic",
      scope.to,
    ],
  );
  tx.run(
    "INSERT INTO cases(id,revision,title,connection_id,scope_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
    [
      CASE,
      1,
      "合成案件",
      CONNECTION,
      canonicalJson(scope),
      "pending",
      scope.to,
      scope.to,
    ],
  );
}

export async function temporaryDirectory() {
  await mkdir(".local/tests", { recursive: true });
  const path = await mkdtemp(join(process.cwd(), ".local/tests/run-"));
  return {
    path,
    async dispose() {
      await rm(path, { recursive: true, force: true });
    },
  };
}

export async function storageFixture() {
  const directory = await temporaryDirectory();
  const clock = new FakeClock(),
    ids = new FakeIds();
  const deps = {
    dataDir: directory.path,
    spaceId: SPACE,
    principalId: PRINCIPAL,
    identityEpoch: 1,
    clock,
    ids,
  };
  const result = await createStorage(deps);
  if (!result.ok) {
    await directory.dispose();
    throw new Error(result.error.code);
  }
  return {
    ...result.value,
    deps,
    directory,
    clock,
    ids,
    async dispose() {
      await result.value.close();
      await directory.dispose();
    },
  };
}
