import type {Durability} from "./encrypted-snapshot.js";
import type { DatabaseSync } from "node:sqlite";
import type { StorageDependencies } from "./types.js";
import {
  fail,
  internalError,
  ok,
  parseWith,
  callContextSchema,
  parseDomainEvent,
  canonicalJson,
  type CallContext,
  type DatabasePort,
  type EventPort,
  type EventPayloadMap,
  type ReadTx,
  type WriteTx,
  type Result,
  type SqlValue,
} from "@campussec/contracts";
const thenable = (value: unknown): value is PromiseLike<unknown> =>
  !!value &&
  (typeof value === "object" || typeof value === "function") &&
  typeof (value as { then?: unknown }).then === "function";
export function createDatabase(
  connection: DatabaseSync,
  deps: StorageDependencies,
  durability?: Durability,
) {
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let inCallback = false;
  let tail: Promise<unknown> = Promise.resolve();
  const liveWrites = new WeakSet<object>();
  function authorize(ctx: CallContext): Result<void> {
    if (!parseWith(callContextSchema, ctx).ok)
      return fail("UNAUTHENTICATED", "调用上下文无效");
    const actor = ctx.actor;
    if (
      actor.spaceId !== deps.spaceId ||
      actor.principalId !== deps.principalId ||
      actor.identityEpoch !== deps.identityEpoch
    )
      return fail("FORBIDDEN", "主体空间不匹配");
    return ok(undefined);
  }
  function enqueue<T>(
    ctx: CallContext,
    writable: boolean,
    work: (tx: WriteTx) => Result<T>,
  ): Promise<Result<T>> {
    if (closing)
      return Promise.resolve(fail("STORAGE_UNAVAILABLE", "存储已关闭"));
    if (inCallback)
      return Promise.resolve(fail("INVALID_INPUT", "禁止嵌套数据库操作"));
    const operation = tail.then((): Result<T> => {
      const auth = authorize(ctx);
      if (!auth.ok) return auth;
      let staged:ReturnType<Durability["prepare"]>|undefined;
      let committed=false;
      let active = true;
      const assertLive = () => {
        if (!active) throw new Error("Transaction handle expired");
      };
      const assertReadSql = (sql: string) => {
        assertLive();
        if (!/^\s*SELECT\b/i.test(sql))
          throw new Error("Read methods accept SELECT only");
      };
      const tx: WriteTx = {
        get<V>(
          sql: string,
          parameters: readonly SqlValue[] = [],
        ): V | undefined {
          assertReadSql(sql);
          return connection.prepare(sql).get(...parameters) as V | undefined;
        },
        all<V>(sql: string, parameters: readonly SqlValue[] = []): V[] {
          assertReadSql(sql);
          return connection.prepare(sql).all(...parameters) as V[];
        },
        run(
          sql: string,
          parameters: readonly SqlValue[] = [],
        ): { changes: number } {
          assertLive();
          if (!writable || !/^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(sql))
            throw new Error("Write operation denied");
          return {
            changes: Number(connection.prepare(sql).run(...parameters).changes),
          };
        },
      };
      try {
        if (!writable) connection.exec("PRAGMA query_only=ON");
        connection.exec(writable ? "BEGIN IMMEDIATE" : "BEGIN");
        if (writable) liveWrites.add(tx);
        inCallback = true;
        const result = work(tx);
        if (thenable(result) || (result?.ok && thenable(result.value))) {
          // Observe a rejected continuation; it cannot use the expired handle.
          Promise.resolve(thenable(result) ? result : result.value).catch(
            () => undefined,
          );
          throw new Error("Transaction callbacks must be synchronous");
        }
        if (!result || typeof result.ok !== "boolean")
          throw new Error("Invalid transaction result");
        inCallback = false;
        active = false;
        liveWrites.delete(tx);
        if(writable&&result.ok&&durability)staged=durability.prepare();
        connection.exec(result.ok ? "COMMIT" : "ROLLBACK");
        committed=result.ok;
        staged?.commit();
        return result;
      } catch {
        staged?.abort();
        if(committed&&durability){try{durability.restore();}catch{closing=true;}}
        try {
          connection.exec("ROLLBACK");
        } catch {
          /* BEGIN itself may have failed. */
        }
        return { ok: false, error: internalError("STORAGE_UNAVAILABLE") };
      } finally {
        inCallback = false;
        active = false;
        liveWrites.delete(tx);
        if (!writable) connection.exec("PRAGMA query_only=OFF");
      }
    });
    tail = operation.catch(() => undefined);
    return operation;
  }
  const db: DatabasePort = {
    read: <T>(ctx: CallContext, work: (tx: ReadTx) => T) =>
      enqueue(ctx, false, (tx) => {
        const value = work({ get: tx.get, all: tx.all });
        if (thenable(value)) {
          Promise.resolve(value).catch(() => undefined);
          throw new Error("Async read callback");
        }
        return ok(value);
      }),
    write: <T>(ctx: CallContext, work: (tx: WriteTx) => Result<T>) =>
      enqueue(ctx, true, work),
  };
  return {
    db,
    authorize,
    isWrite: (tx: WriteTx) => liveWrites.has(tx),
    close() {
      if (!closePromise) {
        closing = true;
        closePromise = tail.then(() => {try{connection.close();}finally{durability?.close();}});
      }
      return closePromise;
    },
  };
}
