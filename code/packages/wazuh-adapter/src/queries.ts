import {
  canonicalJson,
  fail,
  ok,
  parseDto,
  parseWith,
  queryScopeSchema,
  platformQuerySchema,
  type CallContext,
  type Capability,
  type ConnectionService,
  type ConnectionProfile,
  type DeviceDetail,
  type DeviceDetailInput,
  type PlatformCall,
  type PlatformPage,
  type PlatformQuery,
  type Scope,
  type Result,
  type SourceRecord,
} from "@campussec/contracts";
import {
  count,
  coverage,
  field,
  indexRecords,
  number,
  object,
  resourceRecords,
  string,
} from "./mapping.js";
import { type Dependencies, type Connections } from "./connections.js";
type Cursor = {
  identity: string;
  generation: number;
  conditions: string;
  offset: number;
  ordinal: number;
  queryId: string;
  pageId: string;
  expires: string;
  reply?: PlatformPage;
  deviceReply?: Awaited<ReturnType<ConnectionService["deviceDetail"]>>;
  agentsReply?: Awaited<ReturnType<ConnectionService["agents"]>>;
};
export function createQueries(deps: Dependencies, connections: Connections) {
  const cursors = new Map<string, Cursor>();
  function identity(
    ctx: CallContext,
    p: ConnectionProfile,
    call?: PlatformCall,
  ) {
    return canonicalJson([
      ctx.actor.spaceId,
      ctx.actor.principalId,
      ctx.actor.identityEpoch,
      p.id,
      call?.runId ?? null,
    ]);
  }
  function cursor(
    ctx: CallContext,
    p: ConnectionProfile,
    conditions: unknown,
    token?: string,
    call?: PlatformCall,
  ): Result<Cursor> {
    if (!token)
      return ok({
        identity: identity(ctx, p, call),
        generation: p.generation,
        conditions: canonicalJson(conditions),
        offset: 0,
        ordinal: 0,
        queryId: deps.ids.next(),
        pageId: deps.ids.next(),
        expires: new Date(Date.parse(deps.clock.now()) + 600000).toISOString(),
      });
    const value = cursors.get(token);
    if (
      !value ||
      value.identity !== identity(ctx, p, call) ||
      value.generation !== p.generation ||
      value.conditions !== canonicalJson(conditions) ||
      value.expires <= deps.clock.now()
    )
      return fail("CURSOR_INVALID", "分页游标不属于当前查询、轮次或连接代次");
    return ok(value);
  }
  function next(previous: Cursor, amount: number) {
    for (const [key, value] of cursors)
      if (value.expires <= deps.clock.now()) cursors.delete(key);
    if (cursors.size >= 1000) return undefined;
    const key = deps.ids.next();
    cursors.set(key, {
      ...previous,
      offset: previous.offset + amount,
      ordinal: previous.ordinal + 1,
      pageId: deps.ids.next(),
      reply: undefined,
      deviceReply: undefined,
      agentsReply: undefined,
    });
    return key;
  }
  async function remember(
    ctx: CallContext,
    p: ConnectionProfile,
    name: Capability["name"],
    response: Result<unknown>,
    endpointKind: Capability["endpointKind"],
  ) {
    if (
      !response.ok &&
      ["CANCELLED", "IDENTITY_CHANGED", "BUDGET_EXHAUSTED"].includes(
        response.error.code,
      )
    )
      return;
    await connections.storeCapability(ctx, p, {
      name,
      endpointKind,
      checkedAt: deps.clock.now(),
      state: response.ok
        ? "available"
        : response.error.code === "UPSTREAM_DENIED"
          ? "denied"
          : response.error.code === "CAPABILITY_UNAVAILABLE"
            ? "unverified"
            : "unreachable",
      evidence: response.ok
        ? "该业务接口已返回结构有效的只读响应；不代表全设备权限或真实环境验收"
        : response.error.code,
    });
  }
  function serverItems(response: Record<string, unknown>): Result<{
    items: unknown[];
    total: number;
    failed: boolean;
  }> {
    if (response.error !== 0)
      return fail("UPSTREAM_UNAVAILABLE", "Server 返回业务错误");
    const data = object(response.data);
    if (
      !Array.isArray(data.affected_items) ||
      number(data.total_affected_items) === undefined ||
      number(data.total_failed_items) === undefined
    )
      return fail("UPSTREAM_UNAVAILABLE", "Server 分页结构无效");
    return ok({
      items: data.affected_items,
      total: data.total_affected_items as number,
      failed: (data.total_failed_items as number) > 0,
    });
  }
  const agents: ConnectionService["agents"] = async (ctx, input) => {
    if (!parseDto("PageRequest", input.page).ok)
      return fail("INVALID_INPUT", "设备分页参数无效");
    const profile = await connections.get(ctx, input.connectionId);
    if (!profile.ok) return profile;
    const p = profile.value,
      state = cursor(
        ctx,
        p,
        { kind: "agents", limit: input.page.limit },
        input.page.cursor,
      );
    if (!state.ok) return state;
    if (state.value.agentsReply) {
      const fresh = await connections.operation(ctx, p).fence();
      return fresh.ok ? state.value.agentsReply : fresh;
    }
    const operation = connections.operation(ctx, p);
    const response = await operation.request("server", ["agents"], {
      limit: String(input.page.limit),
      offset: String(state.value.offset),
      select: "id,name,status,version",
    });
    const data = response.ok ? serverItems(response.value) : response;
    await remember(ctx, p, "agents", data, "server");
    if (!data.ok) return data;
    if (data.value.failed)
      return fail("PARTIAL_RESULT", "设备列表存在部分权限或读取失败");
    const items = data.value.items.map((value) => {
      const row = object(value);
      return {
        id: string(row.id) ?? "",
        ...(string(row.name) ? { name: row.name as string } : {}),
        ...(string(row.status) ? { status: row.status as string } : {}),
        ...(string(row.version) ? { version: row.version as string } : {}),
      };
    });
    if (
      items.some((item) => !/^[A-Za-z0-9._:-]{1,128}$/.test(item.id)) ||
      items.length > input.page.limit ||
      (items.length === 0 && state.value.offset < data.value.total)
    )
      return fail("PARTIAL_RESULT", "设备分页出现缺口或非法身份");
    const nextCursor =
      state.value.offset + items.length < data.value.total
        ? next(state.value, items.length)
        : undefined;
    if (!nextCursor && state.value.offset + items.length < data.value.total)
      return fail("PARTIAL_RESULT", "设备游标容量已满");
    const result = ok({
      items,
      ...(nextCursor ? { nextCursor } : {}),
      total: { value: data.value.total, relation: "eq" as const },
    });
    state.value.agentsReply = result;
    return result;
  };
  async function device(
    ctx: CallContext,
    p: ConnectionProfile,
    input: DeviceDetailInput,
    call: PlatformCall,
    suppliedState?: Cursor,
    suppliedOperation?: ReturnType<Connections["operation"]>,
  ): Promise<Result<DeviceDetail>> {
    const conditions = {
      kind: "device",
      agentId: input.agentId,
      category: input.category,
      limit: input.page.limit,
    };
    const state = suppliedState
      ? ok(suppliedState)
      : cursor(ctx, p, conditions, input.page.cursor, call);
    if (!state.ok) return state;
    const operation = suppliedOperation ?? connections.operation(ctx, p, call);
    const checked = await operation.fence();
    if (!checked.ok) return checked;
    if (state.value.deviceReply) return state.value.deviceReply;
    const segments =
      input.category === "fim_objects"
        ? ["syscheck", input.agentId]
        : input.category === "sca"
          ? ["sca", input.agentId]
          : ["syscollector", input.agentId, input.category];
    const raw = await operation.request("server", segments, {
      limit: String(input.page.limit),
      offset: String(state.value.offset),
    });
    const response = raw.ok ? serverItems(raw.value) : raw;
    const name: Capability["name"] =
      input.category === "fim_objects"
        ? "fim_objects"
        : input.category === "sca"
          ? "sca"
          : `inventory_${input.category}`;
    await remember(ctx, p, name, response, "server");
    if (!response.ok) {
      if (response.error.code === "UPSTREAM_DENIED")
        return ok({
          agentId: input.agentId,
          category: input.category,
          items: [],
          retrievedAt: deps.clock.now(),
          status: "denied" as const,
          warnings: ["该设备类别权限受限，不能解释为零条记录"],
        });
      return response;
    }
    if (
      response.value.items.length > input.page.limit ||
      (response.value.items.length === 0 &&
        state.value.offset < response.value.total)
    )
      return fail("PARTIAL_RESULT", "设备清单分页存在缺口");
    if (
      response.value.items.some((item) => {
        const row = object(item);
        const agent = field(row, "agent.id") ?? row.agent_id ?? row.agentId;
        return agent !== undefined && agent !== input.agentId;
      })
    )
      return fail("SCOPE_EXCEEDED", "上游设备记录不属于请求设备");
    const mapped = resourceRecords(
      p,
      input.agentId,
      input.category,
      response.value.items,
      deps.clock.now(),
      input.category === "fim_objects"
        ? "fim"
        : input.category === "sca"
          ? "finding"
          : "inventory",
    );
    if (mapped.records.some((record) => !parseDto("SourceRecord", record).ok))
      return fail("PARTIAL_RESULT", "清单来源结构未通过契约校验");
    const more =
      state.value.offset + response.value.items.length < response.value.total;
    const nextCursor = more
      ? next(state.value, response.value.items.length)
      : undefined;
    const warnings = [
      ...mapped.warnings,
      ...(response.value.failed ? ["Server 返回局部失败"] : []),
      ...(state.value.ordinal ? ["offset 分页期间上游可能发生变化"] : []),
      ...(more && !nextCursor ? ["游标容量已满，结果截断"] : []),
    ];
    const result = ok({
      agentId: input.agentId,
      category: input.category,
      items: mapped.records,
      ...(nextCursor ? { nextCursor } : {}),
      total: { value: response.value.total, relation: "eq" as const },
      retrievedAt: deps.clock.now(),
      status: warnings.length || more ? ("partial" as const) : ("ok" as const),
      warnings,
    });
    state.value.deviceReply = result;
    return result;
  }
  const deviceDetail: ConnectionService["deviceDetail"] = async (
    ctx,
    input,
    call,
  ) => {
    const parsed = parseDto("DeviceDetailInput", input);
    if (!parsed.ok) return parsed;
    const p = await connections.get(ctx, input.connectionId);
    if (!p.ok) return p;
    return device(ctx, p.value, input, call);
  };
  const query: ConnectionService["query"] = async (ctx, input, call) => {
    const parsed = parseWith<PlatformQuery>(platformQuerySchema, input);
    if (!parsed.ok) return parsed;
    input = parsed.value;
    if (
      input.scope.agentIds.length > 5 ||
      Date.parse(input.scope.to) - Date.parse(input.scope.from) > 3600000
    )
      return fail("SCOPE_EXCEEDED", "调查最多五台设备和一小时");
    if (
      input.kind === "alerts" &&
      (input.fixedUpper > input.scope.to ||
        input.fixedUpper <= input.scope.from)
    )
      return fail("SCOPE_EXCEEDED", "查询固定上界无效");
    const profile = await connections.get(ctx, input.scope.connectionId);
    if (!profile.ok) return profile;
    const p = profile.value;
    if (input.kind === "authentication" || input.kind === "file_changes")
      return fail(
        "CAPABILITY_UNAVAILABLE",
        "认证事件或 FIM 事件字段映射尚未核实；对象清单不能替代事件历史",
      );
    const { page: _page, ...rest } = input;
    const state = cursor(
      ctx,
      p,
      { ...rest, limit: input.page.limit },
      input.page.cursor,
      call,
    );
    if (!state.ok) return state;
    if (state.value.ordinal >= 4) return fail("CURSOR_INVALID", "调查最多四页");
    const operation = connections.operation(ctx, p, call);
    const checked = await operation.fence();
    if (!checked.ok) return checked;
    if (state.value.reply)
      return ok({ ...state.value.reply, platformAttempts: 0 });
    let records: SourceRecord[] = [],
      warnings: string[] = [],
      total,
      nextCursor: string | undefined;
    if (
      input.kind === "inventory" ||
      (input.kind === "findings" && input.category === "sca")
    ) {
      const response = await device(
        ctx,
        p,
        {
          connectionId: p.id,
          agentId: input.scope.agentIds[0]!,
          category: input.kind === "inventory" ? input.category : "sca",
          page: input.page,
        },
        call,
        state.value,
        operation,
      );
      if (!response.ok) return response;
      records = response.value.items;
      warnings = response.value.warnings;
      total = response.value.total;
      // Device cursors are bound to a different method; wrap only the server offset in query state.
      if (response.value.nextCursor)
        nextCursor =
          state.value.ordinal < 3 ? response.value.nextCursor : undefined;
      if (response.value.nextCursor && !nextCursor)
        warnings.push("达到四页上限，查询未完整");
      if (response.value.status === "denied")
        return ok({
          status: "denied",
          queryId: state.value.queryId,
          pageId: state.value.pageId,
          pageOrdinal: state.value.ordinal,
          records: [],
          coverage: {
            ...coverage(input.scope, deps.clock.now(), 0, ["该类别权限受限"]),
            queryCompleteness: "not_executed",
          },
          warnings: response.value.warnings,
          platformAttempts: operation.attempts(),
        });
    } else {
      const index =
        input.kind === "alerts"
          ? p.alertsPattern
          : "wazuh-states-vulnerabilities-*";
      const upper = input.kind === "alerts" ? input.fixedUpper : input.scope.to;
      const filters: unknown[] = [
        { terms: { "agent.id": input.scope.agentIds } },
        { range: { timestamp: { gte: input.scope.from, lt: upper } } },
      ];
      if (input.kind === "alerts") {
        if (input.filter.ruleIds?.length)
          filters.push({ terms: { "rule.id": input.filter.ruleIds } });
        if (input.filter.ruleGroups?.length)
          filters.push({ terms: { "rule.groups": input.filter.ruleGroups } });
        if (input.filter.minLevel !== undefined)
          filters.push({
            range: { "rule.level": { gte: input.filter.minLevel } },
          });
      }
      const body =
        input.kind === "alerts"
          ? {
              size: input.page.limit,
              track_total_hits: true,
              query: { bool: { filter: filters } },
              sort: [{ timestamp: "asc" }],
              _source: [
                "timestamp",
                "@timestamp",
                "agent.id",
                "agent.name",
                "rule.id",
                "rule.level",
                "rule.groups",
                "rule.description",
                "data.srcip",
                "data.dstip",
                "data.srcuser",
                "data.dstuser",
                "decoder.name",
                "location",
              ],
            }
          : {
              size: 0,
              track_total_hits: true,
              query: {
                bool: {
                  filter: [{ terms: { "agent.id": input.scope.agentIds } }],
                },
              },
            };
      const response = await operation.request(
        "indexer",
        [index, "_search"],
        {},
        body,
      );
      if (!response.ok) {
        await remember(
          ctx,
          p,
          input.kind === "alerts" ? "alerts" : "vulnerabilities",
          response,
          "indexer",
        );
        if (response.error.code === "UPSTREAM_DENIED")
          return ok({
            status: "denied",
            queryId: state.value.queryId,
            pageId: state.value.pageId,
            pageOrdinal: state.value.ordinal,
            records: [],
            coverage: {
              ...coverage(input.scope, deps.clock.now(), 0, [
                "接口权限受限，不能解释为零匹配",
              ]),
              queryCompleteness: "not_executed",
            },
            warnings: ["接口权限受限"],
            platformAttempts: operation.attempts(),
          });
        return response;
      }
      if (input.kind === "findings")
        return fail(
          "CAPABILITY_UNAVAILABLE",
          "漏洞状态行映射尚未核实；权限探测成功不能代替调查材料",
        );
      const hits = object(response.value.hits);
      if (
        !Array.isArray(hits.hits) ||
        hits.hits.length > input.page.limit ||
        !count(hits.total)
      )
        return fail("UPSTREAM_UNAVAILABLE", "Indexer 搜索响应结构无效");
      const mapped = indexRecords(
        p,
        hits.hits,
        deps.clock.now(),
        input.kind === "alerts" ? "alert" : "finding",
      );
      records = mapped.records;
      warnings = mapped.warnings;
      total = count(hits.total);
      const indexPattern = new RegExp(
        "^" +
          index
            .split("*")
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*") +
          "$",
      );
      if (
        records.some(
          (record) =>
            !parseDto("SourceRecord", record).ok ||
            !indexPattern.test(record.source.index ?? ""),
        )
      )
        return fail("SCOPE_EXCEEDED", "上游材料结构或索引超出已配置范围");
      if (
        records.some(
          (r) =>
            !r.agentId ||
            !input.scope.agentIds.includes(r.agentId) ||
            (input.kind === "alerts" &&
              (!r.observedAt ||
                r.observedAt < input.scope.from ||
                r.observedAt >= upper)),
        )
      )
        return fail("SCOPE_EXCEEDED", "上游返回了范围外或时间不明确的事件");
      if (Array.isArray(response.value._campusWarnings))
        warnings.push(
          ...response.value._campusWarnings.filter(
            (v): v is string => typeof v === "string",
          ),
        );
      if (
        response.value.timed_out !== false ||
        (number(object(response.value._shards).failed) ?? 1) > 0
      )
        warnings.push("查询超时、分片失败或分片完成状态未知");
      if (total && (total.relation !== "eq" || total.value > records.length))
        warnings.push(
          "稳定 Indexer 分页尚未核实；仅返回固定窗口第一页，无后续游标",
        );
      await remember(ctx, p, "alerts", response, "indexer");
    }
    const effectiveScope =
      input.kind === "alerts"
        ? { ...input.scope, to: input.fixedUpper }
        : input.scope;
    if (effectiveScope.to < input.scope.to)
      warnings.push("固定查询上界早于请求结束时间，后续时间段未查询");
    const result: PlatformPage = {
      status: warnings.length || nextCursor ? "partial" : "ok",
      queryId: state.value.queryId,
      pageId: state.value.pageId,
      pageOrdinal: state.value.ordinal,
      records,
      coverage: {
        ...coverage(
          input.scope,
          deps.clock.now(),
          records.length,
          [...warnings, ...(nextCursor ? ["more_pages"] : [])],
          total,
        ),
        effectiveScope,
      },
      ...(nextCursor ? { nextCursor } : {}),
      warnings,
      platformAttempts: operation.attempts(),
    };
    state.value.reply = result;
    return ok(result);
  };
  const statistics: ConnectionService["statistics"] = async (
    ctx,
    scope,
    call,
  ) => {
    const valid = parseWith<Scope>(queryScopeSchema, scope);
    if (!valid.ok) return valid;
    scope = valid.value;
    if (Date.parse(scope.to) - Date.parse(scope.from) > 86400000)
      return fail("SCOPE_EXCEEDED", "统计窗口最多二十四小时");
    const p = await connections.get(ctx, scope.connectionId);
    if (!p.ok) return p;
    const operation = connections.operation(ctx, p.value, call);
    const response = await operation.request(
      "indexer",
      [p.value.alertsPattern, "_search"],
      {},
      {
        size: 0,
        track_total_hits: true,
        query: {
          bool: {
            filter: [
              { terms: { "agent.id": scope.agentIds } },
              { range: { timestamp: { gte: scope.from, lt: scope.to } } },
            ],
          },
        },
        aggs: {
          levels: { terms: { field: "rule.level", size: 16 } },
          hours: {
            date_histogram: {
              field: "timestamp",
              fixed_interval: "1h",
              time_zone: "UTC",
              min_doc_count: 0,
              extended_bounds: {
                min: scope.from,
                max: new Date(Date.parse(scope.to) - 1).toISOString(),
              },
            },
          },
        },
      },
    );
    if (!response.ok) return response;
    const total = count(field(response.value, "hits.total")),
      levels = object(field(response.value, "aggregations.levels")),
      hours = object(field(response.value, "aggregations.hours"));
    if (
      !total ||
      !Array.isArray(levels.buckets) ||
      !Array.isArray(hours.buckets)
    )
      return fail("UPSTREAM_UNAVAILABLE", "统计响应结构无效");
    const byLevel = levels.buckets.map((value) => {
        const v = object(value);
        return { level: Number(v.key), count: Number(v.doc_count) };
      }),
      byHour = hours.buckets.map((value) => {
        const v = object(value);
        const key = number(v.key);
        return {
          start:
            key !== undefined && key <= 8640000000000000
              ? new Date(key).toISOString()
              : "",
          count: number(v.doc_count) ?? -1,
        };
      });
    if (
      byLevel.length > 16 ||
      byLevel.some(
        (v) =>
          !Number.isInteger(v.level) ||
          v.level < 0 ||
          v.level > 15 ||
          !Number.isSafeInteger(v.count) ||
          v.count < 0,
      ) ||
      byHour.length > 1000 ||
      byHour.some(
        (v) => !v.start || !Number.isSafeInteger(v.count) || v.count < 0,
      )
    )
      return fail("UPSTREAM_UNAVAILABLE", "统计桶值无效");
    const reasons = [
      ...(Array.isArray(response.value._campusWarnings)
        ? response.value._campusWarnings.filter(
            (v): v is string => typeof v === "string",
          )
        : []),
      ...(total.relation !== "eq" ? ["总数为下界"] : []),
      ...(response.value.timed_out !== false ||
      (number(field(response.value, "_shards.failed")) ?? 1) > 0
        ? ["查询超时或分片状态不完整"]
        : []),
      ...((number(levels.sum_other_doc_count) ?? 1) > 0 ||
      (number(levels.doc_count_error_upper_bound) ?? 1) > 0
        ? ["等级聚合存在遗漏或误差"]
        : []),
    ];
    return ok({
      scope,
      total,
      byLevel,
      byHour,
      coverage: coverage(scope, deps.clock.now(), total.value, reasons, total),
    });
  };
  return { agents, deviceDetail, query, statistics };
}
