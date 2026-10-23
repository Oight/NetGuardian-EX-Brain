import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fail, ok } from '@campussec/contracts';
import { createScriptedHttp, createScriptedExecution, CASE, context, scope } from '@campussec/testkit';

test('shared fakes require explicit scripts and can model executed requests whose responses are lost',async()=>{
  const http=createScriptedHttp();let remoteEffects=0;
  const request={method:'POST' as const,url:'https://synthetic.invalid/search',headers:{},signal:new AbortController().signal,timeoutMs:10};
  await assert.rejects(()=>http.port.request(request),/Unscripted/);
  http.script.push(async()=>{remoteEffects++;return fail('UPSTREAM_TIMEOUT','合成响应丢失');});
  assert.equal((await http.port.request(request)).ok,false);assert.equal(remoteEffects,1);
  const execution=createScriptedExecution();
  execution.inspect.push(async()=>ok({runId:CASE,phase:'uncertain',verification:'unverified',observedAt:scope.to}));
  execution.abort.push(async()=>ok({runId:CASE,phase:'completed',verification:'verified',observedAt:scope.to}));
  const uncertain=await execution.port.inspect(context(),CASE);assert.ok(uncertain.ok);assert.equal(uncertain.value.phase,'uncertain');
  const late=await execution.port.abort(context(),CASE);assert.ok(late.ok);assert.equal(late.value.phase,'completed');
});
