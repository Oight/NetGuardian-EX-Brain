import {
  canonicalJson,
  dtoSchemas,
  fail,
  ok,
  parseWith,
  type CallContext,
  type DatabasePort,
  type EventPort,
  type Result,
  type RuntimeSettings,
} from "@campussec/contracts";

export function createSettings(deps: { db: DatabasePort; events: EventPort }) {
  function decode(
    row: { revision: number; value_json: string } | undefined,
  ): RuntimeSettings {
    if (!row)
      return {
        revision: 1,
        trayEnabled: false,
        budgetTimeZone: "Asia/Shanghai",
      };
    const parsed = parseWith(dtoSchemas.RuntimeSettings, {
      ...(JSON.parse(row.value_json) as object),
      revision: row.revision,
    });
    if (!parsed.ok) throw new Error("Invalid persisted settings");
    return parsed.value;
  }
  return {
    read(ctx: CallContext): Promise<Result<RuntimeSettings>> {
      return deps.db.read(ctx, (tx) =>
        decode(
          tx.get(
            "SELECT revision,value_json FROM runtime_settings WHERE key=?",
            ["runtime"],
          ),
        ),
      );
    },
    initialize(ctx: CallContext): Promise<Result<RuntimeSettings>> {
      return deps.db.write(ctx, (tx) => {
        const row = tx.get<{ revision: number; value_json: string }>(
          "SELECT revision,value_json FROM runtime_settings WHERE key=?",
          ["runtime"],
        );
        const value = decode(row);
        if (!row) {
          const { revision, ...rest } = value;
          tx.run(
            "INSERT INTO runtime_settings(key,revision,value_json) VALUES(?,?,?)",
            ["runtime", revision, canonicalJson(rest)],
          );
        }
        return ok(value);
      });
    },
    configure(
      ctx: CallContext,
      input: {
        expectedRevision: number;
        settings: Omit<RuntimeSettings, "revision">;
      },
    ): Promise<Result<RuntimeSettings>> {
      if (ctx.actor.role !== "ui")
        return Promise.resolve(fail("FORBIDDEN", "设置仅允许用户修改"));
      return deps.db.write(ctx, (tx) => {
        const parsed = parseWith(dtoSchemas.RuntimeSettings, {
          ...input.settings,
          revision: input.expectedRevision + 1,
        });
        if (!parsed.ok) return parsed;
        const { revision, ...rest } = parsed.value;
        if (
          tx.run(
            "UPDATE runtime_settings SET revision=?,value_json=? WHERE key=? AND revision=?",
            [revision, canonicalJson(rest), "runtime", input.expectedRevision],
          ).changes !== 1
        )
          return fail("REVISION_CONFLICT", "设置已改变，请刷新后重新审阅");
        deps.events.appendInTx(tx, ctx, {
          type: "runtime.changed",
          aggregateId: ctx.actor.spaceId,
          revision,
          payload: { state: "degraded" },
        });
        return ok(parsed.value);
      });
    },
  };
}
