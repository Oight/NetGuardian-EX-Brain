import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { desktopSchemas, parseDto, canonicalJson, fail, parseRpcRequest, parseRpcResponse, parseControlToolEnvelope, parseResultPackage, parseEvidenceToolEnvelope, type DesktopMethodMap } from '@campussec/contracts';
import { CASE, SPACE, foundationSamples } from '@campussec/testkit';
const samples = foundationSamples();
for (const method of Object.keys(samples.desktop) as (keyof DesktopMethodMap)[]) {
  test(`public IPC contract roundtrip: ${method}`, () => {
    const sample = samples.desktop[method];
    const request = { protocolVersion: '0.1.0', requestId: CASE, method, payload: sample.input };
    assert.ok(parseRpcRequest(request).ok, `${method} valid request`);
    assert.ok(parseRpcResponse(method, CASE, { protocolVersion: '0.1.0', requestId: CASE, result: { ok: true, value: sample.output } }).ok, `${method} valid response`);
    assert.equal(parseRpcRequest({ ...request, payload: { ...sample.input, __unexpected: true } }).ok, false);
    const invalidOutput = sample.output && typeof sample.output === 'object' && !Array.isArray(sample.output) ? { ...sample.output, __unexpected: true } : { __unexpected: true };
    assert.equal(parseRpcResponse(method, CASE, { protocolVersion: '0.1.0', requestId: CASE, result: { ok: true, value: invalidOutput } }).ok, false);
  });
}
test('RPC response correlation, error variants and external envelopes reject forged/oversized input', () => {
  assert.equal(Object.keys(samples.desktop).length, Object.keys(desktopSchemas).length);
  const denied = fail('FORBIDDEN', '合成权限不足'); assert.ok(!denied.ok);
  const response = { protocolVersion: '0.1.0', requestId: CASE, result: denied };
  assert.ok(parseRpcResponse('runtime.status', CASE, response).ok);
  for (const bad of [{ ...response, requestId: SPACE }, { ...response, protocolVersion: '0.2.0' }, { ...response, extra: true }, { ...response, result: { ...response.result, value: {} } }, { ...response, result: { ok: false, error: { ...response.result.error, code: 'UNKNOWN' } } }]) assert.equal(parseRpcResponse('runtime.status', CASE, bad).ok, false);
  assert.ok(parseControlToolEnvelope({ schemaVersion: '0.1.0', status: 'needs_input', data: { question: '合成范围缺失' }, warnings: [] }).ok);
  assert.equal(parseControlToolEnvelope({ schemaVersion: '0.1.0', status: 'ok', data: { text: '中'.repeat(6000) }, warnings: [] }).ok, false);
  assert.ok(parseResultPackage(samples.result).ok);
  assert.equal(parseResultPackage({ ...samples.result, schemaVersion: '0.2.0' }).ok, false);
  assert.equal(parseResultPackage({ ...samples.result, token: 'synthetic-forged-secret' }).ok, false);
  assert.equal(parseEvidenceToolEnvelope({ schemaVersion: '0.1.0', status: 'pretend_success', records: [], budget: samples.budget, warnings: [] }).ok, false);
});


test('shared public examples conform to DTOs and contain a consistent source content hash', () => {
  for (const [name, value] of Object.entries({ CaseRecord: samples.caseRecord, ConnectionProfile: samples.connection, BusinessContext: samples.context, Coverage: samples.coverage, AnalysisRun: samples.run, InvestigationRequest: samples.request, JobRecord: samples.job, BudgetState: samples.budget, RequestStatus: samples.status, ReportCandidate: samples.candidate, ReportRecord: samples.report, ResultPackage: samples.result, TriggerPolicy: samples.policy, AutoCandidate: samples.autoCandidate, OriginBinding: samples.binding, PlatformPage: samples.page })) {
    // Names above are concrete contract DTOs, checked through the public runtime entry.
    assert.ok(parseDto(name as Parameters<typeof parseDto>[0], value).ok, name);
  }
  const evidence = samples.desktop['evidence.get'].output.evidence;
  assert.equal(createHash('sha256').update(canonicalJson(evidence.fields)).digest('hex'), evidence.contentHash);
});
