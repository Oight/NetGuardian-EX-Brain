import {
  fail,
  type DatabasePort,
  type CallContext,
  type Result,
  type ReadTx,
  type WriteTx,
  type SqlValue,
} from "@campussec/contracts";
import { isThenable } from "./clock.js";

type Operation = {
  kind: "get" | "all" | "run";
  sql: string;
  parameters: readonly SqlValue[];
  value: unknown;
};
/** Ordered SQL expectations only, deliberately not an alternate database/business implementation. */
export class SqlScript {
  private operations: Operation[] = [];
  expectGet(sql: string, parameters: readonly SqlValue[], row: unknown) {
    this.operations.push({ kind: "get", sql, parameters, value: row });
    return this;
  }
  expectAll(sql: string, parameters: readonly SqlValue[], rows: unknown[]) {
    this.operations.push({ kind: "all", sql, parameters, value: rows });
    return this;
  }
  expectRun(sql: string, parameters: readonly SqlValue[], changes: number) {
    this.operations.push({ kind: "run", sql, parameters, value: { changes } });
    return this;
  }
  pending() {
    return this.operations.length;
  }
  take(
    kind: Operation["kind"],
    sql: string,
    parameters: readonly SqlValue[] = [],
  ) {
    const next = this.operations[0];
    const equal = (a: SqlValue, b: SqlValue) =>
      a instanceof Uint8Array && b instanceof Uint8Array
        ? a.length === b.length && a.every((v, i) => v === b[i])
        : a === b;
    if (
      !next ||
      next.kind !== kind ||
      next.sql !== sql ||
      next.parameters.length !== parameters.length ||
      !parameters.every((v, i) => equal(v, next.parameters[i]!))
    )
      throw new Error("SQL script mismatch or unscripted SQL");
    this.operations.shift();
    return next.value;
  }
}
export function createScriptedDatabase() {
  const scripts: { writable: boolean; script: SqlScript }[] = [];
  const calls: {
    ctx: CallContext;
    writable: boolean;
    outcome: "committed" | "rolled_back" | "read";
    operations: number;
  }[] = [];
  let running = false;
  async function execute<T>(
    ctx: CallContext,
    writable: boolean,
    work: (tx: WriteTx) => Result<T>,
  ): Promise<Result<T>> {
    if (running)
      return Promise.resolve(
        fail("INVALID_INPUT", "Nested scripted transactions are forbidden"),
      );
    const entry = scripts.shift();
    if (!entry || entry.writable !== writable)
      return Promise.reject(new Error("Unscripted database transaction"));
    let active = true,
      operations = 0;
    const record: (typeof calls)[number] = {
      ctx,
      writable,
      outcome: "rolled_back",
      operations: 0,
    };
    calls.push(record);
    function take(
      kind: Operation["kind"],
      sql: string,
      parameters?: readonly SqlValue[],
    ) {
      if (!active) throw new Error("Expired transaction handle");
      if (
        kind === "run" &&
        (!writable || !/^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(sql))
      )
        throw new Error("Write operation denied");
      if (kind !== "run" && !/^\s*SELECT\b/i.test(sql))
        throw new Error("Read methods accept SELECT only");
      operations++;
      return entry!.script.take(kind, sql, parameters);
    }
    const tx: WriteTx = {
      get: <V>(sql: string, args?: readonly SqlValue[]) =>
        take("get", sql, args) as V | undefined,
      all: <V>(sql: string, args?: readonly SqlValue[]) =>
        take("all", sql, args) as V[],
      run: (sql, args) => take("run", sql, args) as { changes: number },
    };
    try {
      running = true;
      const result = work(tx);
      if (isThenable(result) || (result.ok && isThenable(result.value))) {
        void Promise.resolve(
          isThenable(result) ? result : result.ok ? result.value : undefined,
        ).catch(() => undefined);
        return Promise.resolve(
          fail("INVALID_INPUT", "Transaction callbacks must be synchronous"),
        );
      }
      if (entry.script.pending()) throw new Error("Unused SQL script steps");
      record.outcome = result.ok
        ? writable
          ? "committed"
          : "read"
        : "rolled_back";
      return Promise.resolve(result);
    } finally {
      active = false;
      running = false;
      record.operations = operations;
    }
  }
  const port: DatabasePort = {
    read: (ctx, work) =>
      execute(ctx, false, (tx) => ({
        ok: true,
        value: work({ get: tx.get, all: tx.all } satisfies ReadTx),
      })),
    write: (ctx, work) => execute(ctx, true, work),
  };
  return {
    port,
    calls,
    read: (script: SqlScript) => scripts.push({ writable: false, script }),
    write: (script: SqlScript) => scripts.push({ writable: true, script }),
    pending: () => scripts.length,
  };
}
