import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fail,
  idSchema,
  ok,
  type Result,
  type SecretPort,
} from "@campussec/contracts";

export interface SecretProtection {
  available(): boolean;
  encrypt(text: string): Uint8Array;
  decrypt(bytes: Uint8Array): string;
  /** Trusted owner releases any leased key material after runtime shutdown. */
  close?():void;
}
interface SecretRecord {
  spaceId: string;
  owner: string;
  purpose: string;
  value: Uint8Array;
}
export interface SecretStore extends SecretPort {
  close(): void;
}

/** One store belongs to one space. Its port is only injected into trusted adapters. */
export function createSecretStore(deps: {
  directory: string;
  spaceId: string;
  protection: SecretProtection;
  authorizeOwner(owner: string): boolean;
}): SecretStore {
  if (!idSchema.safeParse(deps.spaceId).success)
    throw new Error("Invalid secret space");
  const memory = new Map<string, SecretRecord>();
  let closed = false;
  const filename = (ref: string) =>
    join(deps.directory, deps.spaceId, `${ref}.secret`);
  const validPurpose = (value: string) =>
    value.length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value);
  async function load(ref: string): Promise<SecretRecord | undefined> {
    if (memory.has(ref)) return memory.get(ref);
    if (!deps.protection.available()) return undefined;
    try {
      const bytes = await readFile(filename(ref));
      const record = JSON.parse(deps.protection.decrypt(bytes)) as Record<
        string,
        unknown
      >;
      if (
        Object.keys(record).sort().join(",") !==
          "owner,purpose,ref,spaceId,value,version" ||
        record.version !== 2 || record.ref !== ref ||
        record.spaceId !== deps.spaceId ||
        typeof record.owner !== "string" ||
        !deps.authorizeOwner(record.owner) ||
        typeof record.purpose !== "string" ||
        !validPurpose(record.purpose) ||
        typeof record.value !== "string"
      )
        return undefined;
      const value = Uint8Array.from(atob(record.value), (c) => c.charCodeAt(0));
      if (value.length > 1048576) return undefined;
      if (closed) {
        value.fill(0);
        return undefined;
      }
      const result = {
        spaceId: deps.spaceId,
        owner: record.owner,
        purpose: record.purpose,
        value,
      };
      memory.set(ref, result);
      return result;
    } catch {
      return undefined;
    }
  }
  return {
    async put(input) {
      if (
        closed ||
        !idSchema.safeParse(input.owner).success ||
        !deps.authorizeOwner(input.owner) ||
        !validPurpose(input.purpose) ||
        !(input.value instanceof Uint8Array) ||
        input.value.byteLength > 1048576
      )
        return fail("FORBIDDEN", "秘密存储请求无效");
      if (input.persist && !deps.protection.available())
        return fail(
          "SECRET_STORE_UNAVAILABLE",
          "系统保护存储不可用，请明确选择仅本次会话保存",
        );
      const ref = randomUUID();
      const record = {
        spaceId: deps.spaceId,
        owner: input.owner,
        purpose: input.purpose,
        value: input.value.slice(),
      };
      if (input.persist) {
        const target = filename(ref),
          temporary = `${target}.${randomUUID()}.tmp`;
        try {
          await mkdir(join(deps.directory, deps.spaceId), {
            recursive: true,
            mode: 0o700,
          });
          const serialized = JSON.stringify({
            ...record,
            version:2,ref,
            value: Buffer.from(record.value).toString("base64"),
          });
          const encrypted = deps.protection.encrypt(serialized);
          await writeFile(temporary, encrypted, { mode: 0o600, flag: "wx" });
          await rename(temporary, target);
        } catch {
          record.value.fill(0);
          try {
            await unlink(temporary);
          } catch {
            /* No plaintext fallback. */
          }
          return fail("SECRET_STORE_UNAVAILABLE", "系统保护存储写入失败");
        }
      }
      if (closed) {
        record.value.fill(0);
        try {
          await unlink(filename(ref));
        } catch {
          /* A close won the race. */
        }
        return fail("SECRET_STORE_UNAVAILABLE", "秘密存储已关闭");
      }
      memory.set(ref, record);
      return ok(ref);
    },
    async use<T>(
      ref: string,
      purpose: string,
      work: (value: Uint8Array) => Promise<T>,
    ): Promise<Result<T>> {
      if (closed || !idSchema.safeParse(ref).success || !validPurpose(purpose))
        return fail("FORBIDDEN", "秘密引用无效");
      const record = await load(ref);
      if (
        closed ||
        !record ||
        record.spaceId !== deps.spaceId ||
        record.purpose !== purpose ||
        !deps.authorizeOwner(record.owner)
      )
        return fail("FORBIDDEN", "秘密引用或用途不匹配");
      const copy = record.value.slice();
      try {
        return ok(await work(copy));
      } catch {
        return fail("INTERNAL", "秘密使用操作失败");
      } finally {
        copy.fill(0);
      }
    },
    async remove(ref) {
      if (closed || !idSchema.safeParse(ref).success)
        return fail("FORBIDDEN", "秘密引用无效");
      const existing = await load(ref);
      if (!existing || !deps.authorizeOwner(existing.owner))
        return fail("NOT_FOUND", "秘密引用不存在");
      try {
        await unlink(filename(ref));
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT")
          return fail("SECRET_STORE_UNAVAILABLE", "秘密删除失败");
      }
      existing.value.fill(0);
      memory.delete(ref);
      return ok(undefined);
    },
    close() {
      closed = true;
      for (const record of memory.values()) record.value.fill(0);
      memory.clear();
    },
  };
}
