import { fail, idSchema, ok, type Result } from '@campussec/contracts';
import type { composeRuntime } from './compose.js';

export interface SpaceIdentity { spaceId:string; principalId:string; identityEpoch:number }
type Composed = Extract<Awaited<ReturnType<typeof composeRuntime>>,{ok:true}>['value'];

/** Core-only lifecycle controller. Never exposed as a renderer-supplied identity operation. */
export function createSpaceController(open:(identity:SpaceIdentity)=>Promise<Result<Composed>>){
  let current:Composed|undefined;
  let changing=false;
  let identityChanged=false;
  async function switchTo(identity:SpaceIdentity):Promise<Result<Composed>>{
    if(changing)return fail('CONFLICT','主体空间切换正在进行');
    if(!idSchema.safeParse(identity.spaceId).success||!idSchema.safeParse(identity.principalId).success||!Number.isSafeInteger(identity.identityEpoch)||identity.identityEpoch<1)return fail('INVALID_INPUT','主体身份无效');
    changing=true;
    try{
      if(current){
        const ctx=current.context();
        const snapshot=await current.facade.invoke(ctx,{protocolVersion:'0.1.0',requestId:ctx.traceId,method:'workspace.snapshot',payload:{}});
        if(!snapshot.result.ok)return snapshot.result;
        if(snapshot.result.value.totals.active>0)return fail('CONFLICT','请先取消并核实，或通过请求模块明确放弃旧轮次；未知远端任务仍占用活动槽');
        await current.close();current=undefined;
      }
      const next=await open(identity);if(!next.ok)return next;
      current=next.value;identityChanged=false;return next;
    }catch{return fail('STORAGE_UNAVAILABLE','主体空间切换失败，原数据保留');}
    finally{changing=false;}
  }
  return {
    switchTo,
    getCurrent(){return current;},
    async notifyIdentityChanged():Promise<Result<void>>{
      identityChanged=true;
      if(!current)return ok(undefined);
      return current.lockIdentity();
    },
    isIdentityChanged(){return identityChanged;},
    async close(){if(current){await current.close();current=undefined;}},
  };
}
