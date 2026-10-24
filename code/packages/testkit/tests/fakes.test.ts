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
  http.script.assertDrained();
  http.script.push(async () => ok({ status: 503, headers: {}, bodyText: 'synthetic-unavailable' }));
  assert.equal(http.script.pending(), 1); assert.throws(() => http.script.assertDrained(), /Unused/);
  await http.port.request(request); http.script.assertDrained();
  const execution=createScriptedExecution();
  execution.inspect.push(async()=>ok({runId:CASE,phase:'uncertain',verification:'unverified',observedAt:scope.to}));
  execution.abort.push(async()=>ok({runId:CASE,phase:'completed',verification:'verified',observedAt:scope.to}));
  const uncertain=await execution.port.inspect(context(),CASE);assert.ok(uncertain.ok);assert.equal(uncertain.value.phase,'uncertain');
  const late=await execution.port.abort(context(),CASE);assert.ok(late.ok);assert.equal(late.value.phase,'completed');
});


test('desktop fake preserves ordering, validates boundaries and exposes explicit failures', async () => {
  const { createScriptedDesktop } = await import('@campussec/testkit');
  const desktop = createScriptedDesktop();
  const request = { protocolVersion: '0.1.0' as const, requestId: CASE, method: 'connections.list' as const, payload: {} };
  await assert.rejects(() => desktop.port.invoke(request), /Unscripted/);
  desktop.push('connections.list', async () => fail('FORBIDDEN', '合成权限不足'));
  await assert.rejects(() => desktop.port.invoke({ ...request, method: 'runtime.status' }), /Expected/);
  assert.equal(desktop.pending(), 1);
  const denied = await desktop.port.invoke(request);
  assert.equal(denied.requestId, CASE);
  assert.equal(denied.result.ok, false);
  if (!denied.result.ok) assert.equal(denied.result.error.code, 'FORBIDDEN');
  assert.equal(desktop.pending(), 0);
  desktop.push('connections.list', async () => ok([{ id: CASE, displayName: '合成连接', generation: 1 }]));
  const result = await desktop.port.invoke(request);
  assert.ok(result.result.ok);
  assert.equal(result.result.value[0]?.displayName, '合成连接');
  desktop.push('connections.list', async () => ok([{ id: CASE, displayName: 'bad', generation: -1 }]));
  assert.equal((await desktop.port.invoke(request)).result.ok, false);
  desktop.push('connections.list', async () => ok([]));
  const invalid = { ...request, payload: { unexpected: true } };
  // @ts-expect-error Inject malformed external input to exercise runtime validation.
  assert.equal((await desktop.port.invoke(invalid)).result.ok, false);
  assert.equal(desktop.pending(), 1);
});
