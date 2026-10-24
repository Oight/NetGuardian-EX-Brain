import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { temporaryDirectory } from '../../../tests/support/storage.js';
import { createAuthentication } from '../main/authentication.js';
import { createAuthController } from '../main/auth-controller.js';
import { composeRuntime } from '../runtime/compose.js';
import { serveWorkbench } from '../runtime/web-server.js';
import { generateIdentityKeys, publicIdentity, seal, openSealed, type PublicIdentity } from '../main/cryptography.js';
import { fail } from '@campussec/contracts';
test('actual loopback web transport encrypts authentication/RPC, rejects tampering/replay/forged sources, and protects session-bound downloads', async () => {
    const directory = await temporaryDirectory();
    let web: Awaited<ReturnType<typeof serveWorkbench>> | undefined;
    const controller = createAuthController({ authentication: await createAuthentication({ directory: join(directory.path, 'auth') }), open: (account, protection, databaseProtection) => composeRuntime({
            dataDir: directory.path, spaceId: account.spaceId, principalId: account.id, identityEpoch: 1, protection, databaseProtection, backgroundEnabled: false, http: { request: async () => fail('FORBIDDEN', 'Synthetic test forbids network') }, saveExport: value => web!.saveExport(value)
        }) });
    try {
        web = await serveWorkbench({
            authentication: controller, assets: resolve('dist/apps/desktop/renderer'), port: 0, label: 'Synthetic acceptance'
        });
        const origin = web.origin, bridge = await (await fetch(origin + '/web-bridge.js')).text();
        const matches = bridge.match(/createWebChannel\((\{[^}]+\}),"([^"]+)"\)/);
        assert.ok(matches);
        const server = JSON.parse(matches[1]!) as PublicIdentity, marker = matches[2]!, client = generateIdentityKeys(), clientPublic = publicIdentity(client);
        let cookie = '';
        function packet(path: string, value: unknown) {
            const nonce = randomUUID(), text = seal(Buffer.from(JSON.stringify({
                sentAt: Date.now(), nonce, value
            })), 'web-request:' + path, client, server);
            return { nonce, body: JSON.stringify({ publicKeys: clientPublic, envelope: text }) };
        }
        async function post(path: string, p: ReturnType<typeof packet>, headers: Record<string, string> = {}) {
            const response = await fetch(origin + path, {
                method: 'POST', headers: {
                    Origin: origin, 'X-Campus-Web': marker, 'Content-Type': 'application/json', Cookie: cookie, ...headers
                }, body: p.body
            });
            if (response.headers.get('set-cookie'))
                cookie = response.headers.get('set-cookie')!.split(';')[0]!;
            if (response.status !== 200)
                return { response, value: undefined };
            const text = await response.text();
            const result = JSON.parse(openSealed(text, 'web-response:' + path, client, server).toString());
            assert.equal(result.nonce, p.nonce);
            return { response, value: result.value };
        }
        const anonymous = await post('/api/rpc', packet('/api/rpc', {
            protocolVersion: '0.1.0', requestId: randomUUID(), method: 'workspace.snapshot', payload: {}
        }));
        assert.equal(anonymous.value.result.error.code, 'UNAUTHENTICATED');
        const setup = packet('/api/auth', { method: 'setup', input: { username: 'web_admin', password: 'Synthetic-web-transport-2026!' } });
        assert.ok(!setup.body.includes('Synthetic-web-transport-2026!'));
        const signed = await post('/api/auth', setup);
        assert.ok(signed.value.ok);
        assert.ok(cookie.startsWith('ng_session='));
        assert.ok(!Buffer.from(cookie.slice(11), 'base64url').toString().includes('web_admin'));
        assert.equal((await post('/api/auth', setup)).response.status, 409, 'Replay must be rejected');
        assert.equal((await post('/api/auth', packet('/api/auth', { method: 'status', input: {} }), { Origin: 'http://hostile.invalid' })).response.status, 403);
        const tampered = packet('/api/auth', { method: 'status', input: {} });
        const outer = JSON.parse(tampered.body), envelope = JSON.parse(outer.envelope);
        envelope.ciphertext = (envelope.ciphertext[0] === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1);
        outer.envelope = JSON.stringify(envelope);
        tampered.body = JSON.stringify(outer);
        assert.equal((await post('/api/auth', tampered)).response.status, 400);
        const rpc = async (method: string, payload: unknown) => post('/api/rpc', packet('/api/rpc', {
            protocolVersion: '0.1.0', requestId: randomUUID(), method, payload
        }));
        const config = await rpc('connections.configure', {
            displayName: 'Synthetic only', platformInstanceId: randomUUID(), alertsPattern: 'wazuh-alerts-*', mappingVersion: 'wazuh-alerts-v1'
        });
        assert.ok(config.value.result.ok);
        const created = await rpc('cases.create', {
            title: 'Private synthetic case', scope: {
                connectionId: config.value.result.value.id, agentIds: ['001'], from: '2026-10-23T00:00:00.000Z', to: '2026-10-23T00:30:00.000Z', timeZone: 'UTC'
            }, seedRefs: []
        });
        assert.ok(created.value.result.ok);
        const exported = await rpc('cases.export', {
            caseId: created.value.result.value.id, caseRevision: 1, format: 'json'
        });
        assert.ok(exported.value.result.ok);
        assert.ok(exported.value.result.value.filename.endsWith('.ngenc'));
        assert.ok(!exported.value.result.value.text.includes('Private synthetic case'));
        const ticket = exported.response.headers.get('X-Campus-Download');
        assert.ok(ticket);
        assert.equal((await fetch(origin + '/download/' + ticket)).status, 404, 'Another session cannot fetch the file');
        const download = await fetch(origin + '/download/' + ticket, { headers: { Cookie: cookie } });
        assert.equal(download.status, 200);
        assert.ok(!(await download.text()).includes('Private synthetic case'));
        assert.equal((await fetch(origin + '/download/' + ticket, { headers: { Cookie: cookie } })).status, 404);
        const opened = await post('/api/auth', packet('/api/auth', { method: 'openExport', input: { text: exported.value.result.value.text } }));
        assert.ok(opened.value.ok && opened.value.value.text.includes('Private synthetic case'));
        const old = cookie;
        await post('/api/auth', packet('/api/auth', { method: 'logout', input: {} }));
        cookie = old;
        const invalid = await rpc('workspace.snapshot', {});
        assert.equal(invalid.value.result.error.code, 'UNAUTHENTICATED');
    }
    finally {
        await web?.close();
        await controller.close();
        await directory.dispose();
    }
});
