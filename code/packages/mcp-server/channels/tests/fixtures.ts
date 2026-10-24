import assert from "node:assert/strict";
import {
  canonicalJson,
  ok,
  type AnalysisRun,
  type CallContext,
  type Result,
  type SecretPort,
} from "@campussec/contracts";
import {
  CASE,
  CONNECTION,
  PRINCIPAL,
  SPACE,
  context,
  scope,
} from "@campussec/testkit";
import { createSecretStore } from "../../../../apps/desktop/main/secrets.js";
import { seedCase, storageFixture } from "../../../../tests/support/storage.js";
import {
  createChannelAuthenticator,
  createEvidenceChannels,
} from "@campussec/mcp-server/channels";

export const SESSION = "30000000-0000-4000-8000-000000000001";
export const OTHER = "30000000-0000-4000-8000-000000000002";
export function system(): CallContext {
  const ctx = context();
  return { ...ctx, actor: { ...ctx.actor, role: "system" } };
}
export function take<T>(result: Result<T>): T {
  assert.ok(result.ok, result.ok ? "" : result.error.code);
  return result.value;
}
export function error(result: Result<unknown>, code?: string) {
  assert.ok(!result.ok, "operation unexpectedly succeeded");
  if (code) assert.equal(result.error.code, code);
}
export async function setup(
  wrap: (port: SecretPort) => SecretPort = (port) => port,
) {
  const f = await storageFixture();
  const secretStore = createSecretStore({
    directory: f.directory.path + "/secrets",
    spaceId: SPACE,
    protection: {
      available: () => false,
      encrypt() {
        throw new Error("disabled");
      },
      decrypt() {
        throw new Error("disabled");
      },
    },
    authorizeOwner: (owner) => owner === PRINCIPAL,
  });
  const run: AnalysisRun = {
    id: CASE,
    jobId: CASE,
    caseId: CASE,
    baseRevision: 1,
    scope,
    connectionGeneration: 1,
    identityEpoch: 1,
    profileVersion: "v1",
    toolEpoch: 1,
    expiresAt: "2026-10-23T01:05:00.000Z",
  };
  try {
    take(
      await f.db.write(system(), (tx) => {
        seedCase(tx);
        tx.run(
          `INSERT INTO investigation_requests(id,origin,state,principal_id,connection_id,question,
        requested_scope_json,effective_scope_json,seed_refs_json,case_id,job_id,missing_fields_json,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            CASE,
            "client_user",
            "accepted",
            PRINCIPAL,
            CONNECTION,
            "合成通道",
            canonicalJson(scope),
            canonicalJson(scope),
            "[]",
            CASE,
            CASE,
            "[]",
            scope.to,
            run.expiresAt,
          ],
        );
        tx.run(
          "INSERT INTO jobs(id,request_id,case_id,run_id,origin,state,revision,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
          [
            CASE,
            CASE,
            CASE,
            CASE,
            "client_user",
            "preparing",
            1,
            run.expiresAt,
            scope.to,
            scope.to,
          ],
        );
        tx.run(
          `INSERT INTO analysis_runs(id,job_id,case_id,base_revision,scope_json,connection_generation,
        identity_epoch,profile_version,tool_epoch,expires_at,initial_input_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          [
            run.id,
            run.jobId,
            run.caseId,
            1,
            canonicalJson(scope),
            1,
            1,
            "v1",
            1,
            run.expiresAt,
            "{}",
          ],
        );
        return ok(undefined);
      }),
    );
  } catch (e) {
    secretStore.close();
    await f.dispose();
    throw e;
  }
  const secrets = wrap(secretStore);
  const deps = { db: f.db, clock: f.clock, ids: f.ids, secrets };
  return {
    ...f,
    storageDeps: f.deps,
    run,
    secrets,
    secretStore,
    deps,
    channels: createEvidenceChannels(deps),
    auth: createChannelAuthenticator(deps),
    async mutate(sql: string, parameters: (string | number | null)[] = []) {
      take(
        await f.db.write(system(), (tx) => {
          tx.run(sql, parameters);
          return ok(undefined);
        }),
      );
    },
    async dispose() {
      secretStore.close();
      await f.dispose();
    },
  };
}
