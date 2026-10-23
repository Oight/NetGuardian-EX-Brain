import { DatabaseSync } from 'node:sqlite';
import { fail, idSchema, internalError, ok, type Result } from '@campussec/contracts';
import { prepareSpacePath } from './space.js';
import { migrate } from './migrations.js';
import { createDatabase } from './database.js';
import { createEvents } from './events.js';
import type { Storage, StorageDependencies } from './types.js';

export type { Storage, StorageDependencies } from './types.js';

export async function createStorage(deps:StorageDependencies):Promise<Result<Storage>>{
  if(!idSchema.safeParse(deps.spaceId).success||!idSchema.safeParse(deps.principalId).success||!Number.isSafeInteger(deps.identityEpoch)||deps.identityEpoch<1)return fail('INVALID_INPUT','主体空间参数无效');
  let connection:DatabaseSync|undefined;
  try{
    connection=new DatabaseSync(await prepareSpacePath(deps));
    await migrate(connection,deps);
    const controller=createDatabase(connection,deps);
    const events=createEvents({...deps,db:controller.db,isWrite:controller.isWrite,authorize:controller.authorize});
    return ok({db:controller.db,events,close:controller.close});
  }catch{
    try{connection?.close();}catch{/* Preserve the existing database. */}
    return {ok:false,error:internalError('STORAGE_UNAVAILABLE')};
  }
}
