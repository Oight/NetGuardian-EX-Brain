import {openEncryptedSnapshot,restoreSnapshot,type Durability} from "./encrypted-snapshot.js";
import { DatabaseSync } from "node:sqlite";
import {
  fail,
  idSchema,
  internalError,
  ok,
  type Result,
} from "@campussec/contracts";
import { prepareSpacePath } from "./space.js";
import { migrate } from "./migrations.js";
import { createDatabase } from "./database.js";
import { createEvents } from "./events.js";
import type { Storage, StorageDependencies } from "./types.js";

export type { Storage, StorageDependencies } from "./types.js";

export async function createStorage(
  deps: StorageDependencies,
): Promise<Result<Storage>> {
  if (
    !idSchema.safeParse(deps.spaceId).success ||
    !idSchema.safeParse(deps.principalId).success ||
    !Number.isSafeInteger(deps.identityEpoch) ||
    deps.identityEpoch < 1
  )
    return fail("INVALID_INPUT", "主体空间参数无效");
  let connection: DatabaseSync | undefined;
  let encrypted:ReturnType<typeof openEncryptedSnapshot>|undefined;
  let durability:Durability|undefined;
  try {
    const path=await prepareSpacePath(deps);
    if(deps.encryption){encrypted=openEncryptedSnapshot(path,deps.encryption);connection=new DatabaseSync(":memory:");connection.exec("PRAGMA temp_store=MEMORY");await migrate(connection,deps,encrypted.snapshot?.schemaVersion);if(encrypted.snapshot)restoreSnapshot(connection,encrypted.snapshot);}
    else connection=new DatabaseSync(path);
    await migrate(connection, deps);
    if(encrypted)durability=encrypted.attach(connection);
    const controller = createDatabase(connection, deps,durability);
    const events = createEvents({
      ...deps,
      db: controller.db,
      isWrite: controller.isWrite,
      authorize: controller.authorize,
    });
    return ok({ db: controller.db, events, close: controller.close });
  } catch {
    try {
      connection?.close();
    } catch {
      /* Preserve the existing database. */
    }
    try{encrypted?.close();}catch{/* Preserve the original failure. */}
    return { ok: false, error: internalError("STORAGE_UNAVAILABLE") };
  }
}
