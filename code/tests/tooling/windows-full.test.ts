import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowsTestPlan, executeWindowsTestPlan } from '../../scripts/product/windows-test-plan.js';
const environment = { platform: 'win32', runtime: 'node' as const, nodeVersion: '24.15.0', npmVersion: '11.12.1' };
test('Windows full command rejects Bun/non-Windows/version mismatches before any execution', () => {
  for (const patch of [{platform:'linux'},{runtime:'bun' as const},{runtime:'electron' as const},{nodeVersion:'22.0.0'},{npmVersion:'11.1.0'}]) assert.throws(()=>windowsTestPlan({...environment,...patch}));
  const plan=windowsTestPlan(environment);assert.ok(plan.find(stage=>stage.id==='install')?.args.includes('--ignore-scripts'));assert.ok(plan.find(stage=>stage.id==='clean'));assert.ok(plan.find(stage=>stage.id==='electron'));
});
test('Windows full command preserves failed and unexecuted results instead of reporting aggregate success',()=>{
 const stages=windowsTestPlan(environment),executed:string[]=[];
 const results=executeWindowsTestPlan(stages,stage=>{executed.push(stage.id);return stage.id==='product'?2:0;});
 assert.deepEqual(executed,['environment','install','product']);assert.equal(results.find(stage=>stage.id==='product')?.status,'failed');assert.equal(results.find(stage=>stage.id==='electron')?.status,'skipped');assert.equal(results.find(stage=>stage.id==='clean')?.exitCode,undefined);
 const thrown=executeWindowsTestPlan(stages,()=>{throw new Error('synthetic runner failure');});assert.equal(thrown[0]?.status,'failed');assert.ok(thrown.slice(1).every(stage=>stage.status==='skipped'));
});

test('the external Electron acceptance script parses without loading Electron on the local machine',async()=>{
 const {readFile}=await import('node:fs/promises');const ts=await import('typescript');
 const source=ts.createSourceFile('foundation-smoke.cjs',await readFile('scripts/electron/foundation-smoke.cjs','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const diagnostics=(source as typeof source&{parseDiagnostics:readonly unknown[]}).parseDiagnostics;
 assert.equal(diagnostics.length,0);
});
