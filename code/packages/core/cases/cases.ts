import {
  canonicalJson,
  decodeCursor,
  encodeCursor,
  fail,
  ok,
  parseDesktopInput,
  parseDto,
  type CaseAtomicPort,
  type CaseRecord,
  type CaseService,
  type EvidenceRef,
  type Json,
  type ReadTx,
  type Result,
  type CallContext,
} from "@campussec/contracts";
import {
  audit,
  authorized,
  caseRecord,
  change,
  contexts,
  contextMatches,
  getContext,
  evidenceRecord,
  getCase,
  getEvidence,
  hash,
  historical,
  linked,
  readResult,
  uniqueRefs,
  type CaseRow,
  type Dependencies,
  type EvidenceRow,
} from "./repositories.js";
import { queryViews } from "./queries.js";
function pageKeys(
  cursor: string | undefined,
  ctx: CallContext,
  queryHash: string,
): Result<Json[]> {
  if (!cursor) return ok([]);
  const parsed = decodeCursor(cursor, {
    spaceId: ctx.actor.spaceId,
    queryHash,
  });
  return parsed.ok ? ok(parsed.value.lastKeys) : parsed;
}
export function caseOperations(deps: Dependencies) {
  const getInTx: CaseAtomicPort["getInTx"] = getCase;
  const recordChangeInTx: CaseAtomicPort["recordChangeInTx"] = (
    tx,
    ctx,
    input,
  ) => {
    const found = getCase(tx, ctx, input.caseId);
    if (!found.ok) return found;
    return change(
      deps,
      tx,
      ctx,
      found.value,
      input.expectedRevision,
      input.reason,
    );
  };
  const createInTx: CaseAtomicPort["createInTx"] = (tx, ctx, input) => {
    const auth = authorized(tx, ctx);
    if (!auth.ok) return auth;
    if (!["ui", "system"].includes(ctx.actor.role))
      return fail("FORBIDDEN", "当前入口不能直接创建案件");
    const parsed = parseDesktopInput("cases.create", input);
    if (!parsed.ok) return parsed;
    input = parsed.value;
    if (!input.title.trim()) return fail("INVALID_INPUT", "案件标题不能为空");
    if (
      !tx.get("SELECT id FROM connections WHERE id=?", [
        input.scope.connectionId,
      ])
    )
      return fail("NOT_FOUND", "请先配置连接");
    for (const ref of uniqueRefs(input.seedRefs)) {
      const evidence = getEvidence(tx, ctx, ref);
      if (!evidence.ok) return evidence;
      const visible =
        tx.get(
          "SELECT case_id FROM evidence_links WHERE evidence_id=? AND evidence_version=? AND removed_revision IS NULL",
          [ref.evidenceId, ref.version],
        ) ||
        tx.get(
          "SELECT id FROM alerts_inbox WHERE evidence_id=? AND evidence_version=?",
          [ref.evidenceId, ref.version],
        );
      if (!visible) return fail("FORBIDDEN", "种子材料未被授权");
      const sourceAgent =
        evidence.value.source.agentId ??
        (evidence.value.fields["agent.id"] as string | undefined);
      if (
        evidence.value.connectionId !== input.scope.connectionId ||
        !sourceAgent ||
        !input.scope.agentIds.includes(sourceAgent) ||
        (["alert", "authentication", "fim"].includes(evidence.value.kind) &&
          evidence.value.observedAt &&
          (evidence.value.observedAt < input.scope.from ||
            evidence.value.observedAt >= input.scope.to))
      )
        return fail("SCOPE_EXCEEDED", "种子材料超出案件范围或缺少设备身份");
      if (evidence.value.availability === "expired")
        return fail("EXPIRED", "种子材料正文已过期");
    }
    const value: CaseRecord = {
      id: deps.ids.next(),
      spaceId: ctx.actor.spaceId,
      revision: 1,
      title: input.title.trim(),
      scope: input.scope,
      status: "pending",
      createdAt: deps.clock.now(),
      updatedAt: deps.clock.now(),
    };
    tx.run(
      "INSERT INTO cases(id,revision,title,connection_id,scope_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      [
        value.id,
        1,
        value.title,
        value.scope.connectionId,
        canonicalJson(value.scope),
        value.status,
        value.createdAt,
        value.updatedAt,
      ],
    );
    for (const ref of uniqueRefs(input.seedRefs))
      tx.run(
        "INSERT INTO evidence_links(case_id,evidence_id,evidence_version,attached_revision) VALUES(?,?,?,?)",
        [value.id, ref.evidenceId, ref.version, 1],
      );
    audit(deps, tx, ctx, value.id, 1, "创建案件");
    return ok(value);
  };
  const snapshotInTx: CaseAtomicPort["snapshotInTx"] = (tx, ctx, input) => {
    if (!["ui", "system"].includes(ctx.actor.role))
      return fail("FORBIDDEN", "当前入口不能读取完整案件快照");
    const parsed = parseDesktopInput("cases.snapshot", input);
    if (!parsed.ok) return parsed;
    input = parsed.value;
    const found = getCase(tx, ctx, input.caseId);
    if (!found.ok) return found;
    const queryHash = hash({
      view: "evidence",
      caseId: input.caseId,
      revision: found.value.revision,
    });
    const keys = pageKeys(input.evidencePage.cursor, ctx, queryHash);
    if (!keys.ok) return keys;
    if (
      keys.value.length &&
      (keys.value.length !== 2 ||
        typeof keys.value[0] !== "string" ||
        typeof keys.value[1] !== "number")
    )
      return fail("CURSOR_INVALID", "材料游标无效");
    const rows = tx.all<EvidenceRow>(
      "SELECT v.*,s.connection_id,s.locator_json FROM evidence_links l JOIN evidence_versions v ON v.evidence_id=l.evidence_id AND v.version=l.evidence_version JOIN evidence_sources s ON s.evidence_id=v.evidence_id WHERE l.case_id=? AND l.removed_revision IS NULL" +
        (keys.value.length
          ? " AND (v.evidence_id>? OR (v.evidence_id=? AND v.version>?))"
          : "") +
        " ORDER BY v.evidence_id,v.version LIMIT ?",
      [
        input.caseId,
        ...(keys.value.length
          ? [
              keys.value[0] as string,
              keys.value[0] as string,
              keys.value[1] as number,
            ]
          : []),
        input.evidencePage.limit + 1,
      ],
    );
    const evidence = rows
      .slice(0, input.evidencePage.limit)
      .map((row) => evidenceRecord(row, ctx));
    const last = evidence.at(-1);
    return ok({
      case: found.value,
      evidence,
      contexts: contexts(tx, found.value),
      queries: queryViews(tx, input.caseId),
      ...(rows.length > evidence.length && last
        ? {
            nextEvidenceCursor: encodeCursor({
              version: "0.1.0",
              spaceId: ctx.actor.spaceId,
              queryHash,
              lastKeys: [last.id, last.version],
            }),
          }
        : {}),
    });
  };
  const setStatusInTx: CaseAtomicPort["setStatusInTx"] = (tx, ctx, input) => {
    const parsed = parseDesktopInput("cases.setStatus", input);
    if (!parsed.ok) return parsed;
    input = parsed.value;
    const found = getCase(tx, ctx, input.caseId);
    if (!found.ok) return found;
    if (!["ui", "system"].includes(ctx.actor.role))
      return fail("FORBIDDEN", "当前入口不能决定案件状态");
    const allowed: Record<CaseRecord["status"], CaseRecord["status"][]> = {
      pending: ["investigating"],
      investigating: ["pending", "resolved"],
      resolved: ["reopened"],
      reopened: ["investigating", "resolved"],
    };
    if (!allowed[found.value.status].includes(input.status))
      return fail("CONFLICT", "不允许该案件状态转换");
    const changed = change(
      deps,
      tx,
      ctx,
      found.value,
      input.expectedRevision,
      input.reason,
    );
    if (!changed.ok) return changed;
    tx.run("UPDATE cases SET status=? WHERE id=?", [
      input.status,
      input.caseId,
    ]);
    return getCase(tx, ctx, input.caseId);
  };
  const attachInTx: CaseAtomicPort["attachInTx"] = (tx, ctx, input) => {
    const found = getCase(tx, ctx, input.caseId);
    if (!found.ok) return found;
    if (
      input.refs.length > 300 ||
      input.refs.some((ref) => !parseDto("EvidenceRef", ref).ok)
    )
      return fail("INVALID_INPUT", "材料引用无效");
    for (const ref of input.refs) {
      const evidence = getEvidence(tx, ctx, ref);
      if (!evidence.ok) return evidence;
      if (evidence.value.connectionId !== found.value.scope.connectionId)
        return fail("SCOPE_EXCEEDED", "材料连接与案件不一致");
      const inbox =
        ["ui", "system"].includes(ctx.actor.role) &&
        !!tx.get(
          "SELECT id FROM alerts_inbox WHERE evidence_id=? AND evidence_version=?",
          [ref.evidenceId, ref.version],
        );
      if (inbox) {
        const agent =
          evidence.value.source.agentId ??
          (evidence.value.fields["agent.id"] as string | undefined);
        if (
          !agent ||
          !found.value.scope.agentIds.includes(agent) ||
          (evidence.value.observedAt &&
            (evidence.value.observedAt < found.value.scope.from ||
              evidence.value.observedAt >= found.value.scope.to))
        )
          return fail("SCOPE_EXCEEDED", "收件箱材料超出案件范围或缺少设备身份");
      }
      if (
        !linked(tx, input.caseId, ref) &&
        !historical(tx, ctx, input.caseId, ref) &&
        !inbox
      )
        return fail("FORBIDDEN", "材料未获案件或历史轮次授权");
    }
    const changed = change(
      deps,
      tx,
      ctx,
      found.value,
      input.expectedRevision,
      input.reason,
    );
    if (!changed.ok) return changed;
    for (const ref of uniqueRefs(input.refs))
      tx.run(
        "INSERT INTO evidence_links(case_id,evidence_id,evidence_version,attached_revision) VALUES(?,?,?,?) ON CONFLICT(case_id,evidence_id,evidence_version) DO UPDATE SET attached_revision=excluded.attached_revision,removed_revision=NULL",
        [input.caseId, ref.evidenceId, ref.version, changed.value],
      );
    return changed;
  };
  const service: Pick<
    CaseService,
    "list" | "create" | "snapshot" | "setStatus" | "moveEvidence" | "putContext"
  > = {
    async list(ctx, input) {
      const parsed = parseDesktopInput("cases.list", input);
      if (!parsed.ok) return parsed;
      input = parsed.value;
      if (!["ui", "system"].includes(ctx.actor.role))
        return fail("FORBIDDEN", "当前入口不能浏览全部案件");
      return readResult(deps.db, ctx, (tx) => {
        const queryHash = hash({
          view: "cases",
          connectionId: input.connectionId ?? null,
          status: input.status ?? null,
          text: input.text ?? "",
        });
        const keys = pageKeys(input.page.cursor, ctx, queryHash);
        if (!keys.ok) return keys;
        if (
          keys.value.length &&
          (keys.value.length !== 2 ||
            !keys.value.every((k) => typeof k === "string"))
        )
          return fail("CURSOR_INVALID", "案件游标无效");
        const where: string[] = [],
          params: (string | number)[] = [];
        if (input.connectionId) {
          where.push("connection_id=?");
          params.push(input.connectionId);
        }
        if (input.status) {
          where.push("status=?");
          params.push(input.status);
        }
        if (input.text) {
          where.push("title LIKE ? ESCAPE '\\'");
          params.push("%" + input.text.replace(/[\\%_]/g, "\\$&") + "%");
        }
        if (keys.value.length) {
          where.push("(updated_at<? OR (updated_at=? AND id<?))");
          params.push(
            keys.value[0] as string,
            keys.value[0] as string,
            keys.value[1] as string,
          );
        }
        const rows = tx.all<CaseRow>(
          "SELECT * FROM cases" +
            (where.length ? " WHERE " + where.join(" AND ") : "") +
            " ORDER BY updated_at DESC,id DESC LIMIT ?",
          [...params, input.page.limit + 1],
        );
        const items = rows
          .slice(0, input.page.limit)
          .map((row) => caseRecord(row, ctx));
        const last = items.at(-1);
        return ok({
          items,
          ...(rows.length > items.length && last
            ? {
                nextCursor: encodeCursor({
                  version: "0.1.0",
                  spaceId: ctx.actor.spaceId,
                  queryHash,
                  lastKeys: [last.updatedAt, last.id],
                }),
              }
            : {}),
        });
      });
    },
    create: (ctx, input) =>
      deps.db.write(ctx, (tx) => createInTx(tx, ctx, input)),
    snapshot: (ctx, input) =>
      readResult(deps.db, ctx, (tx) => snapshotInTx(tx, ctx, input)),
    setStatus: (ctx, input) =>
      deps.db.write(ctx, (tx) => setStatusInTx(tx, ctx, input)),
    async moveEvidence(ctx, input) {
      const parsed = parseDesktopInput("cases.moveEvidence", input);
      if (!parsed.ok) return parsed;
      input = parsed.value;
      if (ctx.actor.role !== "ui")
        return fail("FORBIDDEN", "拆案只允许人工操作");
      return deps.db.write(ctx, (tx) => {
        if (
          input.sourceCaseId === input.targetCaseId ||
          !input.reason.trim() ||
          !input.refs.length
        )
          return fail("INVALID_INPUT", "请选择不同案件、材料并填写理由");
        const source = getCase(tx, ctx, input.sourceCaseId),
          target = getCase(tx, ctx, input.targetCaseId);
        if (!source.ok) return source;
        if (!target.ok) return target;
        if (source.value.scope.connectionId !== target.value.scope.connectionId)
          return fail("SCOPE_EXCEEDED", "不能跨连接移动材料");
        if (
          source.value.revision !== input.sourceRevision ||
          target.value.revision !== input.targetRevision
        )
          return fail("REVISION_CONFLICT", "案件已更新，请重新读取");
        for (const ref of input.refs) {
          if (!linked(tx, input.sourceCaseId, ref))
            return fail("FORBIDDEN", "材料不属于源案件");
          const item = getEvidence(tx, ctx, ref);
          if (!item.ok) return item;
          const agent =
            item.value.source.agentId ?? item.value.fields["agent.id"];
          if (
            typeof agent !== "string" ||
            !target.value.scope.agentIds.includes(agent) ||
            (["alert", "authentication", "fim"].includes(item.value.kind) &&
              item.value.observedAt &&
              (item.value.observedAt < target.value.scope.from ||
                item.value.observedAt >= target.value.scope.to))
          )
            return fail("SCOPE_EXCEEDED", "材料超出目标案件范围");
        }
        const a = change(
          deps,
          tx,
          ctx,
          source.value,
          input.sourceRevision,
          input.reason,
        );
        if (!a.ok) return a;
        const b = change(
          deps,
          tx,
          ctx,
          target.value,
          input.targetRevision,
          input.reason,
        );
        if (!b.ok) return b;
        for (const ref of uniqueRefs(input.refs)) {
          tx.run(
            "UPDATE evidence_links SET removed_revision=? WHERE case_id=? AND evidence_id=? AND evidence_version=?",
            [a.value, source.value.id, ref.evidenceId, ref.version],
          );
          tx.run(
            "INSERT INTO evidence_links(case_id,evidence_id,evidence_version,attached_revision) VALUES(?,?,?,?) ON CONFLICT(case_id,evidence_id,evidence_version) DO UPDATE SET attached_revision=excluded.attached_revision,removed_revision=NULL",
            [target.value.id, ref.evidenceId, ref.version, b.value],
          );
        }
        return ok({ sourceRevision: a.value, targetRevision: b.value });
      });
    },
    async putContext(ctx, input) {
      const parsed = parseDesktopInput("cases.putContext", input);
      if (!parsed.ok) return parsed;
      input = parsed.value;
      if (!["ui", "system"].includes(ctx.actor.role))
        return fail("FORBIDDEN", "当前入口不能修改人工背景");
      return deps.db.write(ctx, (tx) => {
        const found = getCase(tx, ctx, input.caseId);
        if (!found.ok) return found;
        if (found.value.revision !== input.expectedRevision)
          return fail("REVISION_CONFLICT", "案件已更新，请重新读取并审阅");
        if (
          (input.context.caseId && input.context.caseId !== input.caseId) ||
          input.context.connectionId !== found.value.scope.connectionId ||
          !input.context.agentIds.some((id) =>
            found.value.scope.agentIds.includes(id),
          ) ||
          input.context.from >= found.value.scope.to ||
          input.context.to <= found.value.scope.from
        )
          return fail("SCOPE_EXCEEDED", "人工背景与案件范围不相交");
        if (!input.context.text.trim() || !input.context.sourceLabel.trim())
          return fail("INVALID_INPUT", "背景正文和来源不能为空");
        const old = input.contextId
          ? tx.get<{
              id: string;
              latest_version: number;
              case_id: string | null;
              connection_id: string;
            }>("SELECT * FROM business_context WHERE id=?", [input.contextId])
          : undefined;
        if (input.contextId && !old) return fail("NOT_FOUND", "背景不存在");
        if (
          old &&
          (old.connection_id !== input.context.connectionId ||
            old.case_id !== (input.context.caseId ?? null))
        )
          return fail("CONFLICT", "背景目标不可变；请新增背景");
        const id = old?.id ?? deps.ids.next(),
          version = (old?.latest_version ?? 0) + 1;
        const oldContext = old ? getContext(tx, old.id) : undefined;
        const affected = tx
          .all<CaseRow>("SELECT * FROM cases WHERE connection_id=?", [
            input.context.connectionId,
          ])
          .map((row) => caseRecord(row, ctx))
          .filter((c) =>
            [input.context, ...(oldContext ? [oldContext] : [])].some((value) =>
              contextMatches(value, c),
            ),
          );
        if (
          affected.some((c) => {
            const current = contexts(tx, c);
            return (
              contextMatches(input.context, c) &&
              !current.some((value) => value.id === old?.id) &&
              current.length >= 100
            );
          })
        )
          return fail("SCOPE_EXCEEDED", "案件背景数量达到上限");
        if (!old)
          tx.run(
            "INSERT INTO business_context(id,case_id,connection_id,latest_version) VALUES(?,?,?,?)",
            [
              id,
              input.context.caseId ?? null,
              input.context.connectionId,
              version,
            ],
          );
        else
          tx.run("UPDATE business_context SET latest_version=? WHERE id=?", [
            version,
            id,
          ]);
        const value = {
          ...input.context,
          id,
          version,
          authorId: ctx.actor.principalId,
        };
        tx.run(
          "INSERT INTO context_versions(context_id,version,agent_ids_json,text,department,purpose,valid_from,valid_to,source_label,verification,author_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          [
            id,
            version,
            canonicalJson(value.agentIds),
            value.text,
            value.department ?? null,
            value.purpose ?? null,
            value.from,
            value.to,
            value.sourceLabel,
            value.verification,
            value.authorId,
          ],
        );
        for (const c of affected) {
          const changed = change(
            deps,
            tx,
            ctx,
            c,
            c.revision,
            "保存人工背景版本",
          );
          if (!changed.ok) return changed;
        }
        return ok(value);
      });
    },
  };
  return {
    service,
    atomic: {
      getInTx,
      snapshotInTx,
      createInTx,
      setStatusInTx,
      recordChangeInTx,
      attachInTx,
    },
  };
}
