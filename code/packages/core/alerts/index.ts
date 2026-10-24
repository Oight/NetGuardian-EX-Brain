import { createHash } from "node:crypto";
import {
  DEFAULT_LIMITS,
  canonicalJson,
  decodeCursor,
  encodeCursor,
  fail,
  ok,
  parseDesktopInput,
  parseDto,
  type AlertService,
  type AutoCandidate,
  type CallContext,
  type CaseAtomicPort,
  type ClockPort,
  type ConnectionReadPort,
  type DatabasePort,
  type EventPort,
  type IdPort,
  type InboxAlert,
  type NotificationPort,
  type PlatformQueryPort,
  type RequestAtomicPort,
  type Result,
  type Scope,
  type SourceLocator,
  type TriggerPolicy,
} from "@campussec/contracts";
interface Dependencies {
  db: DatabasePort;
  events: EventPort;
  clock: ClockPort;
  ids: IdPort;
  cases: CaseAtomicPort;
  connections: ConnectionReadPort;
  query: PlatformQueryPort;
  requests: RequestAtomicPort;
  notification: NotificationPort;
  revokeRun(ctx: CallContext, runId: string): Promise<Result<void>>;
}
interface Row {
  id: string;
  connection_id: string;
  source_key: string;
  receive_seq: number;
  kind: InboxAlert["kind"];
  evidence_id: string;
  evidence_version: number;
  agent_id: string | null;
  rule_id: string | null;
  rule_groups_json: string;
  level: number | null;
  observed_at: string | null;
  received_at: string;
  is_read: number;
  decision_reason: string;
}
const hash = (v: unknown) =>
  createHash("sha256").update(canonicalJson(v)).digest("hex");
const sourceKey = (s: SourceLocator) =>
  hash(
    s.kind === "index_document"
      ? [s.platformInstanceId, "index", s.index!, s.documentId!]
      : [
          s.platformInstanceId,
          "resource",
          s.resource!,
          s.agentId!,
          s.collectionIdentity!,
        ],
  );
const system = (c: CallContext): CallContext => ({
  traceId: c.traceId,
  actor: {
    spaceId: c.actor.spaceId,
    principalId: c.actor.principalId,
    identityEpoch: c.actor.identityEpoch,
    role: "system",
  },
});
function decode(r: Row): InboxAlert {
  return {
    id: r.id,
    connectionId: r.connection_id,
    sourceKey: r.source_key,
    receiveSeq: r.receive_seq,
    kind: r.kind,
    evidence: { evidenceId: r.evidence_id, version: r.evidence_version },
    ruleGroups: JSON.parse(r.rule_groups_json),
    receivedAt: r.received_at,
    read: !!r.is_read,
    decisionReason: r.decision_reason,
    ...(r.agent_id ? { agentId: r.agent_id } : {}),
    ...(r.rule_id ? { ruleId: r.rule_id } : {}),
    ...(r.level !== null ? { level: r.level } : {}),
    ...(r.observed_at ? { observedAt: r.observed_at } : {}),
  };
}
export function createAlertService(d: Dependencies): AlertService {
  const seen = new Set<string>();
  const polls = new Map<
    string,
    Promise<
      Result<{
        inserted: number;
        complete: boolean;
      }>
    >
  >();
  async function poll(
    ctx: CallContext,
    connectionId: string,
  ): Promise<
    Result<{
      inserted: number;
      complete: boolean;
    }>
  > {
    if (ctx.actor.role !== "system")
      return fail("FORBIDDEN", "轮询仅允许系统调用");
    const agents: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await d.connections.agents(ctx, {
        connectionId,
        page: { limit: 50, ...(cursor ? { cursor } : {}) },
      });
      if (!page.ok) return page;
      agents.push(...page.value.items.map((a) => a.id));
      cursor = page.value.nextCursor;
      if (agents.length >= 1000 && cursor)
        return fail("SCOPE_EXCEEDED", "设备清单超过轮询上限，不能宣称全部覆盖");
    } while (cursor);
    if (!agents.length) return fail("NEEDS_INPUT", "没有可轮询的设备");
    const saved = await d.db.read(ctx, (tx) =>
      tx.get<{
        completed_upper: string | null;
        state: string;
      }>("SELECT * FROM watch_checkpoints WHERE connection_id=?", [
        connectionId,
      ]),
    );
    if (!saved.ok) return saved;
    const restarting = !!saved.value && !seen.has(connectionId);
    seen.add(connectionId);
    const upper = d.clock.now(),
      start = new Date(
        Math.max(
          Date.parse(upper) - DEFAULT_LIMITS.recoveryWindowMs,
          saved.value?.completed_upper
            ? Date.parse(saved.value.completed_upper) -
                (restarting ? 0 : DEFAULT_LIMITS.watchOverlapMs)
            : 0,
        ),
      ).toISOString();
    const scope: Scope = {
      connectionId,
      agentIds: [...new Set(agents)],
      from: start,
      to: upper,
      timeZone: "UTC",
    };
    const kind: InboxAlert["kind"] = !saved.value
      ? "history"
      : !restarting &&
          saved.value.state === "complete" &&
          Date.parse(upper) - Date.parse(saved.value.completed_upper!) <= 30000
        ? "realtime"
        : "recovery";
    const begun = await d.db.write(ctx, (tx) => {
      tx.run(
        "INSERT INTO watch_checkpoints(connection_id,completed_upper,receive_seq,state,gap_json,updated_at) VALUES(?,?,0,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET state=excluded.state,gap_json=excluded.gap_json,updated_at=excluded.updated_at",
        [
          connectionId,
          saved.value?.completed_upper ?? null,
          "gap",
          canonicalJson({ from: start, to: upper, reason: "poll_incomplete" }),
          d.clock.now(),
        ],
      );
      return ok(undefined);
    });
    if (!begun.ok) return begun;
    let inserted = 0,
      complete = false,
      attempts = 0;
    cursor = undefined;
    for (let pageIndex = 0; pageIndex < DEFAULT_LIMITS.maxPages; pageIndex++) {
      const query = {
        kind: "alerts" as const,
        scope,
        filter: {},
        page: { limit: 50, ...(cursor ? { cursor } : {}) },
        fixedUpper: upper,
      };
      const response = await d.query.query(ctx, query, {
        signal: AbortSignal.timeout(DEFAULT_LIMITS.queryTimeoutMs),
        beforeAttempt: async () =>
          ++attempts <= DEFAULT_LIMITS.platformAttempts
            ? ok(undefined)
            : fail("BUDGET_EXHAUSTED", "轮询请求预算耗尽"),
      });
      if (!response.ok) return response;
      const page = response.value;
      if (["denied", "failed", "unavailable"].includes(page.status))
        return fail(
          page.status === "denied" ? "UPSTREAM_DENIED" : "UPSTREAM_UNAVAILABLE",
          "告警查询未完成，不能记为零告警",
        );
      const stored = await d.db.write(ctx, (tx) => {
        const captured = d.cases.captureInTx(tx, ctx, {
          connectionId,
          query,
          page,
        });
        if (!captured.ok) return captured;
        if (captured.value.length !== page.records.length)
          return fail("VALIDATION_FAILED", "告警页来源重复或引用数量不匹配");
        let n = 0;
        for (let i = 0; i < page.records.length; i++) {
          const record = page.records[i]!,
            key = sourceKey(record.source);
          if (
            tx.get(
              "SELECT id FROM alerts_inbox WHERE connection_id=? AND source_key=?",
              [connectionId, key],
            )
          )
            continue;
          const id = d.ids.next(),
            seq = tx.get<{
              n: number;
            }>(
              "SELECT COALESCE(MAX(receive_seq),0)+1 AS n FROM alerts_inbox",
            )!.n;
          const f = record.fields,
            ruleId =
              typeof f["rule.id"] === "string" ? f["rule.id"] : undefined,
            level =
              typeof f["rule.level"] === "number" ? f["rule.level"] : undefined,
            groups = Array.isArray(f["rule.groups"])
              ? f["rule.groups"].filter(
                  (g): g is string => typeof g === "string",
                )
              : [];
          let reason =
            kind === "realtime"
              ? "自动调查未启用"
              : "历史或恢复材料，仅提醒，不补派调查";
          tx.run(
            "INSERT INTO alerts_inbox(id,connection_id,source_key,receive_seq,kind,evidence_id,evidence_version,agent_id,rule_id,rule_groups_json,level,observed_at,received_at,is_read,decision_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)",
            [
              id,
              connectionId,
              key,
              seq,
              kind,
              captured.value[i]!.evidenceId,
              captured.value[i]!.version,
              record.agentId ?? null,
              ruleId ?? null,
              canonicalJson(groups),
              level ?? null,
              record.observedAt ?? null,
              d.clock.now(),
              reason,
            ],
          );
          const policyRow = tx.get<{
            policy_json: string;
            enabled: number;
            epoch: number;
          }>("SELECT * FROM trigger_policies WHERE connection_id=?", [
            connectionId,
          ]);
          if (policyRow?.enabled && kind === "realtime") {
            const parsed = parseDto(
              "TriggerPolicy",
              JSON.parse(policyRow.policy_json),
            );
            if (!parsed.ok) return parsed;
            const policy = parsed.value;
            const match =
              record.agentId &&
              record.observedAt &&
              policy.agentIds.includes(record.agentId) &&
              seq > policy.enabledAfterReceiveSeq &&
              (!policy.filter.minLevel ||
                (level !== undefined && level >= policy.filter.minLevel)) &&
              (!policy.filter.ruleIds?.length ||
                (ruleId !== undefined &&
                  policy.filter.ruleIds.includes(ruleId))) &&
              (!policy.filter.ruleGroups?.length ||
                groups.some((g) => policy.filter.ruleGroups!.includes(g)));
            if (match) {
              const namespace =
                  typeof f["user.namespace"] === "string"
                    ? f["user.namespace"]
                    : undefined,
                name =
                  typeof f["user.name"] === "string"
                    ? f["user.name"]
                    : undefined;
              const family = groups.length ? [...groups].sort() : ruleId;
              const group = hash([
                policy.id,
                policy.epoch,
                record.source.platformInstanceId,
                record.agentId,
                family ?? key,
                namespace && name ? [namespace, name] : key,
              ]);
              let old = tx.get<{
                id: string;
                candidate_json: string;
                case_id: string;
                state: string;
              }>(
                "SELECT * FROM auto_candidates WHERE group_key=? AND (state='dispatched' OR state='collecting' AND expires_at>?) ORDER BY last_received_at DESC LIMIT 1",
                [group, d.clock.now()],
              );
              let candidate: AutoCandidate;
              if (old) {
                const prior = JSON.parse(old.candidate_json) as AutoCandidate;
                if (
                  Date.parse(d.clock.now()) -
                    Date.parse(prior.firstReceivedAt) >=
                    1800000 ||
                  Date.parse(d.clock.now()) -
                    Date.parse(prior.lastReceivedAt) >=
                    600000 ||
                  record.observedAt! < prior.scope.from ||
                  record.observedAt! >= prior.scope.to
                )
                  old = undefined;
              }
              if (old) {
                candidate = JSON.parse(old.candidate_json);
                candidate.alertIds.push(id);
                candidate.lastReceivedAt = d.clock.now();
                candidate.coalesceUntil = new Date(
                  Date.parse(candidate.firstReceivedAt) +
                    DEFAULT_LIMITS.coalesceMs,
                ).toISOString();
                const found = d.cases.getInTx(tx, ctx, candidate.caseId);
                if (!found.ok) return found;
                const attached = d.cases.attachInTx(tx, ctx, {
                  caseId: candidate.caseId,
                  refs: [captured.value[i]!],
                  expectedRevision: found.value.revision,
                  reason: "合并实时告警",
                });
                if (!attached.ok) return attached;
              } else {
                const runScope: Scope = {
                  ...scope,
                  agentIds: [record.agentId!],
                  from: new Date(
                    Date.parse(record.observedAt!) - 300000,
                  ).toISOString(),
                  to: new Date(
                    Date.parse(record.observedAt!) + 300000,
                  ).toISOString(),
                };
                const made = d.cases.createInTx(tx, ctx, {
                  title: "告警初查 " + (ruleId ?? "未分类"),
                  scope: runScope,
                  seedRefs: [captured.value[i]!],
                });
                if (!made.ok) return made;
                candidate = {
                  id: d.ids.next(),
                  policyId: policy.id,
                  policyEpoch: policy.epoch,
                  caseId: made.value.id,
                  alertIds: [id],
                  scope: runScope,
                  question: "核查本次告警的依据、影响与覆盖缺口",
                  firstReceivedAt: d.clock.now(),
                  lastReceivedAt: d.clock.now(),
                  coalesceUntil: new Date(
                    Date.parse(d.clock.now()) + DEFAULT_LIMITS.coalesceMs,
                  ).toISOString(),
                  expiresAt: new Date(
                    Date.parse(d.clock.now()) + DEFAULT_LIMITS.autoQueueTtlMs,
                  ).toISOString(),
                };
              }
              tx.run(
                "INSERT INTO auto_candidates(id,policy_id,policy_epoch,case_id,group_key,first_received_at,last_received_at,coalesce_until,expires_at,state,candidate_json) VALUES(?,?,?,?,?,?,?,?,?,'collecting',?) ON CONFLICT(id) DO UPDATE SET last_received_at=excluded.last_received_at,coalesce_until=excluded.coalesce_until,candidate_json=excluded.candidate_json",
                [
                  candidate.id,
                  policy.id,
                  policy.epoch,
                  candidate.caseId,
                  group,
                  candidate.firstReceivedAt,
                  candidate.lastReceivedAt,
                  candidate.coalesceUntil,
                  candidate.expiresAt,
                  canonicalJson(candidate),
                ],
              );
              reason =
                old?.state === "dispatched"
                  ? "已有调查或初查，材料已附案，仅提醒，不自动复查"
                  : "已进入实时告警合并窗口";
              tx.run("UPDATE alerts_inbox SET decision_reason=? WHERE id=?", [
                reason,
                id,
              ]);
              tx.run(
                "INSERT INTO trigger_decisions(id,alert_id,policy_id,policy_epoch,decision,reason,candidate_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
                [
                  d.ids.next(),
                  id,
                  policy.id,
                  policy.epoch,
                  old?.state === "dispatched" ? "attached" : "candidate",
                  reason,
                  candidate.id,
                  d.clock.now(),
                ],
              );
            }
          }
          tx.run(
            "INSERT INTO notifications(id,notification_key,alert_ids_json,state,created_at) VALUES(?,?,?,'pending',?)",
            [d.ids.next(), "alert:" + id, canonicalJson([id]), d.clock.now()],
          );
          d.events.appendInTx(tx, ctx, {
            type: "alerts.received",
            aggregateId: connectionId,
            revision: seq,
            payload: { connectionId, alertIds: [id], receiveSeq: seq },
          });
          n++;
        }
        return ok(n);
      });
      if (!stored.ok) return stored;
      inserted += stored.value;
      cursor = page.nextCursor;
      if (!cursor) {
        complete =
          page.status === "ok" &&
          page.coverage.queryCompleteness === "complete";
        break;
      }
    }
    const checkpoint = await d.db.write(ctx, (tx) => {
      tx.run(
        "INSERT INTO watch_checkpoints(connection_id,completed_upper,receive_seq,state,gap_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET completed_upper=excluded.completed_upper,receive_seq=excluded.receive_seq,state=excluded.state,gap_json=excluded.gap_json,updated_at=excluded.updated_at",
        [
          connectionId,
          complete ? upper : (saved.value?.completed_upper ?? null),
          tx.get<{
            n: number;
          }>("SELECT COALESCE(MAX(receive_seq),0) AS n FROM alerts_inbox")!.n,
          complete ? "complete" : "gap",
          complete
            ? null
            : canonicalJson({
                from: start,
                to: upper,
                reason: cursor ? "page_limit" : "incomplete_upstream",
              }),
          d.clock.now(),
        ],
      );
      return ok(undefined);
    });
    if (!checkpoint.ok) return checkpoint;
    const notified = await notify(ctx);
    return notified.ok ? ok({ inserted, complete }) : notified;
  }
  async function notify(ctx: CallContext): Promise<Result<void>> {
    const rows = await d.db.write(ctx, (tx) => {
      const pending = tx.all<{
        id: string;
        alert_ids_json: string;
      }>(
        "SELECT * FROM notifications WHERE state='pending' ORDER BY created_at LIMIT 50",
      );
      for (const n of pending)
        tx.run("UPDATE notifications SET state='uncertain' WHERE id=?", [n.id]);
      return ok(pending);
    });
    if (!rows.ok) return rows;
    for (const n of rows.value) {
      try {
        const shown = await d.notification.show({
          notificationId: n.id,
          title: "校安智脑安全提醒",
          body: "收到安全告警，请在工作台核查；提醒不代表确认攻击。",
          alertIds: JSON.parse(n.alert_ids_json),
        });
        if (shown.ok && shown.value.shown) {
          const saved = await d.db.write(ctx, (tx) => {
            tx.run("UPDATE notifications SET state='shown' WHERE id=?", [n.id]);
            return ok(undefined);
          });
          if (!saved.ok) return saved;
        }
      } catch {
        /* Already uncertain: never duplicate a possibly visible notification. */
      }
    }
    return ok(undefined);
  }
  return {
    async pollOnce(ctx, id) {
      if (ctx.actor.role !== "system")
        return fail("FORBIDDEN", "轮询仅允许系统调用");
      if (polls.has(id)) return polls.get(id)!;
      const task = poll(ctx, id);
      polls.set(id, task);
      try {
        return await task;
      } finally {
        polls.delete(id);
      }
    },
    async list(ctx, input) {
      const parsed = parseDesktopInput("alerts.list", input);
      if (!parsed.ok) return parsed;
      if (!["ui", "system"].includes(ctx.actor.role))
        return fail("FORBIDDEN", "告警入口未授权");
      const queryHash = hash(
        input.scope
          ? {
              connectionId: input.connectionId,
              scope: input.scope,
              filter: input.filter ?? {},
              read: input.read ?? null,
            }
          : {
              connectionId: input.connectionId,
              filter: input.filter ?? {},
              read: input.read ?? null,
            },
      );
      let after = Number.MAX_SAFE_INTEGER;
      if (input.page.cursor) {
        const cursor = decodeCursor(input.page.cursor, {
          spaceId: ctx.actor.spaceId,
          queryHash,
        });
        if (!cursor.ok) return cursor;
        if (typeof cursor.value.lastKeys[0] !== "number")
          return fail("CURSOR_INVALID", "告警游标无效");
        after = cursor.value.lastKeys[0];
      }
      return d.db.read(ctx, (tx) => {
        const where = ["connection_id=?", "receive_seq<?"],
          args: import("@campussec/contracts").SqlValue[] = [
            input.connectionId,
            after,
          ];
        if (input.read !== undefined) {
          where.push("is_read=?");
          args.push(input.read ? 1 : 0);
        }
        if (input.filter?.minLevel !== undefined) {
          where.push("level>=?");
          args.push(input.filter.minLevel);
        }
        if (input.scope) {
          where.push(
            "agent_id IN (" +
              input.scope.agentIds.map(() => "?").join(",") +
              ")",
            "observed_at>=?",
            "observed_at<?",
          );
          args.push(...input.scope.agentIds, input.scope.from, input.scope.to);
        }
        const rows = tx
          .all<Row>(
            "SELECT * FROM alerts_inbox WHERE " +
              where.join(" AND ") +
              " ORDER BY receive_seq DESC",
            args,
          )
          .filter(
            (r) =>
              (!input.filter?.ruleIds?.length ||
                (r.rule_id !== null &&
                  input.filter.ruleIds.includes(r.rule_id))) &&
              (!input.filter?.ruleGroups?.length ||
                JSON.parse(r.rule_groups_json).some((g: string) =>
                  input.filter!.ruleGroups!.includes(g),
                )),
          );
        const selected = rows.slice(0, input.page.limit);
        return {
          items: selected.map(decode),
          ...(rows.length > selected.length
            ? {
                nextCursor: encodeCursor({
                  version: "0.1.0",
                  spaceId: ctx.actor.spaceId,
                  queryHash,
                  lastKeys: [selected.at(-1)!.receive_seq],
                }),
              }
            : {}),
        };
      });
    },
    async markRead(ctx, ids) {
      if (
        !["ui", "system"].includes(ctx.actor.role) ||
        !ids.length ||
        ids.length > 1000
      )
        return fail("INVALID_INPUT", "告警选择无效");
      return d.db.write(ctx, (tx) => {
        for (const id of ids)
          if (
            !tx.run("UPDATE alerts_inbox SET is_read=1 WHERE id=?", [id])
              .changes
          )
            return fail("NOT_FOUND", "告警不存在");
        return ok(undefined);
      });
    },
    async setPolicy(ctx, input) {
      const parsed = parseDesktopInput("alerts.setPolicy", input);
      if (!parsed.ok) return parsed;
      if (!["ui", "system"].includes(ctx.actor.role))
        return fail("FORBIDDEN", "策略入口未授权");
      const saved = await d.db.write(ctx, (tx) => {
        const old = tx.get<{
          revision: number;
          epoch: number;
          id: string;
        }>("SELECT * FROM trigger_policies WHERE connection_id=?", [
          input.policy.connectionId,
        ]);
        if (
          (old?.revision ?? 0) !== input.expectedRevision ||
          (old && old.id !== input.policy.id)
        )
          return fail("REVISION_CONFLICT", "策略已改变");
        const policy: TriggerPolicy = {
          ...input.policy,
          revision: (old?.revision ?? 0) + 1,
          epoch: (old?.epoch ?? 0) + 1,
          enabledAfterReceiveSeq: tx.get<{
            n: number;
          }>("SELECT COALESCE(MAX(receive_seq),0) AS n FROM alerts_inbox")!.n,
        };
        const cancelled = old
          ? d.requests.cancelPolicyInTx(tx, system(ctx), {
              policyId: old.id,
              obsoleteEpoch: old.epoch,
            })
          : ok({ revokeRunIds: [] });
        if (!cancelled.ok) return cancelled;
        tx.run(
          "INSERT INTO trigger_policies(id,connection_id,revision,epoch,enabled,enabled_after_receive_seq,policy_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,epoch=excluded.epoch,enabled=excluded.enabled,enabled_after_receive_seq=excluded.enabled_after_receive_seq,policy_json=excluded.policy_json",
          [
            policy.id,
            policy.connectionId,
            policy.revision,
            policy.epoch,
            policy.enabled ? 1 : 0,
            policy.enabledAfterReceiveSeq,
            canonicalJson(policy),
          ],
        );
        d.events.appendInTx(tx, system(ctx), {
          type: "policy.changed",
          aggregateId: policy.id,
          revision: policy.revision,
          payload: {
            policyId: policy.id,
            epoch: policy.epoch,
            enabled: policy.enabled,
          },
        });
        return ok({ policy, revoke: cancelled.value.revokeRunIds });
      });
      if (!saved.ok) return saved;
      for (const run of saved.value.revoke) {
        const revoked = await d.revokeRun(system(ctx), run);
        if (!revoked.ok) return revoked;
      }
      return ok(saved.value.policy);
    },
    async flushCandidates(ctx) {
      if (ctx.actor.role !== "system")
        return fail("FORBIDDEN", "自动调度仅允许系统调用");
      const rows = await d.db.read(ctx, (tx) =>
        tx.all<{
          id: string;
          candidate_json: string;
        }>(
          "SELECT id,candidate_json FROM auto_candidates WHERE state='collecting' AND coalesce_until<=? ORDER BY first_received_at",
          [d.clock.now()],
        ),
      );
      if (!rows.ok) return rows;
      let count = 0;
      for (const r of rows.value) {
        const result = await d.db.write(ctx, (tx) => {
          const row = tx.get<{
            state: string;
            candidate_json: string;
          }>("SELECT * FROM auto_candidates WHERE id=?", [r.id]);
          if (row?.state !== "collecting") return ok(false);
          const candidate = parseDto(
            "AutoCandidate",
            JSON.parse(row.candidate_json),
          );
          if (!candidate.ok) return candidate;
          const created = d.requests.createAutoInTx(tx, ctx, candidate.value);
          if (!created.ok) return created;
          tx.run("UPDATE auto_candidates SET state='dispatched' WHERE id=?", [
            r.id,
          ]);
          return ok(true);
        });
        if (result.ok) {
          if (result.value) count++;
        } else {
          const recorded = await d.db.write(ctx, (tx) => {
            tx.run(
              "UPDATE auto_candidates SET state='rejected' WHERE id=? AND state='collecting'",
              [r.id],
            );
            const candidate = JSON.parse(r.candidate_json) as AutoCandidate;
            for (const id of candidate.alertIds)
              tx.run("UPDATE alerts_inbox SET decision_reason=? WHERE id=?", [
                "自动调查未受理：" + result.error.code,
                id,
              ]);
            return ok(undefined);
          });
          if (!recorded.ok) return recorded;
        }
      }
      return ok(count);
    },
  };
}
