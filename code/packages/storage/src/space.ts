import { mkdir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { StorageDependencies } from './types.js';

export async function prepareSpacePath(deps:StorageDependencies):Promise<string>{
  const directory=join(resolve(deps.dataDir),'spaces',deps.spaceId);
  await mkdir(directory,{recursive:true,mode:0o700});
  if((await lstat(directory)).isSymbolicLink())throw new Error('Unsafe space path');
  const filename=join(directory,'state.sqlite');
  try{if((await lstat(filename)).isSymbolicLink())throw new Error('Unsafe database path');}
  catch(error){if((error as {code?:string}).code!=='ENOENT')throw error;}
  return filename;
}
