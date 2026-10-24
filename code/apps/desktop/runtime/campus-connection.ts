import { CAMPUS_PROXY_MAPPING } from '@campussec/wazuh-adapter';
import { ok } from '@campussec/contracts';
import type { composeRuntime } from './compose.js';
type Runtime = Extract<Awaited<ReturnType<typeof composeRuntime>>, {
    ok: true;
}>['value'];
/** Deployment opt-in provisions a credential-free connection for each isolated account,
 * so analysts need no admin permission to configure secrets or widen endpoint access.
 * Its local identifier is explicitly unverified; no live platform identity is inferred.
 */
export async function prepareCampusConnection(runtime: Runtime) {
    const ctx = runtime.context(), listed = await runtime.facade.invoke(ctx, {
        protocolVersion: '0.1.0', requestId: crypto.randomUUID(), method: 'connections.list', payload: {}
    });
    if (!listed.result.ok)
        return listed.result;
    if (listed.result.value.length)
        return ok(undefined);
    const configured = await runtime.facade.invoke(ctx, {
        protocolVersion: '0.1.0', requestId: crypto.randomUUID(), method: 'connections.configure', payload: {
            displayName: '本机校园只读代理（身份待核实）', platformInstanceId: ctx.actor.spaceId, alertsPattern: 'wazuh-alerts-4.x-*', mappingVersion: CAMPUS_PROXY_MAPPING
        }
    });
    return configured.result.ok ? ok(undefined) : configured.result;
}
