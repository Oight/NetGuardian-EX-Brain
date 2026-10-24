import { fail, ok, type SecretPort } from "@campussec/contracts";
import { ScriptedPort } from "./clock.js";

/** C-line auth fixture: explicit synthetic bytes only, no persistence or implicit authorization. */
export function createScriptedSecrets() {
  const put = new ScriptedPort<Parameters<SecretPort["put"]>[0], string>();
  const read = new ScriptedPort<{ ref: string; purpose: string }, Uint8Array>();
  const remove = new ScriptedPort<string, void>();
  const port: SecretPort = {
    put: (input) => put.invoke(input),
    async use(ref, purpose, work) {
      const result = await read.invoke({ ref, purpose });
      if (!result.ok) return result;
      const bytes = result.value.slice();
      try {
        return ok(await work(bytes));
      } catch {
        return fail("INTERNAL", "合成秘密使用操作失败");
      } finally {
        bytes.fill(0);
      }
    },
    remove: (ref) => remove.invoke(ref),
  };
  return { port, put, read, remove };
}
