import {
  canonicalJson,
  decodeCursor,
  encodeCursor,
  fail,
  ok,
  parseDesktopInput,
  type CaseSnapshot,
  type Json,
  type ReadTx,
  type ReportRecord,
  type ReportService,
  type Result,
  type CallContext,
} from "@campussec/contracts";
import {
  authorize,
  contextKey,
  digest,
  findReport,
  followup,
  refKey,
  reportEvent,
  runAnchor,
  saveReport,
  type Dependencies,
} from "./repositories.js";
import { validate } from "./validate.js";

export function snapshot(
  deps: Dependencies,
  tx: ReadTx,
  ctx: CallContext,
  caseId: string,
): Result<CaseSnapshot> {
  const first = deps.casesAtomic.snapshotInTx(tx, ctx, {
    caseId,
    evidencePage: { limit: 50 },
  });
  if (!first.ok) return first;
  const { nextEvidenceCursor: _cursor, ...value } = first.value;
  let cursor = first.value.nextEvidenceCursor;
  const visited = new Set<string>();
  while (cursor) {
    if (visited.has(cursor)) return fail("VALIDATION_FAILED", "证据分页未前进");
    visited.add(cursor);
    const next = deps.casesAtomic.snapshotInTx(tx, ctx, {
      caseId,
      evidencePage: { limit: 50, cursor },
    });
    if (!next.ok) return next;
    value.evidence.push(...next.value.evidence);
    cursor = next.value.nextEvidenceCursor;
  }
  return ok(value);
}
export function human(
  deps: Dependencies,
): Pick<
  ReportService,
  "review" | "followups" | "searchFollowups" | "putFollowup"
> {
  return {
    async review(ctx, raw) {
      const parsed = parseDesktopInput("reports.review", raw);
      if (!parsed.ok) return parsed;
      const input = parsed.value;
      return deps.db.write(ctx, (tx) => {
        const auth = authorize(tx, ctx, ["ui"]);
        if (!auth.ok) return auth;
        const original = findReport(tx, input.reportId);
        if (!original) return fail("NOT_FOUND", "报告不存在");
        const found = deps.casesAtomic.getInTx(tx, ctx, original.record.caseId);
        if (!found.ok) return found;
        if (found.value.revision !== input.expectedCaseRevision)
          return fail("REVISION_CONFLICT", "案件已更新，请重新核查");
        let record: ReportRecord;
        if (input.disposition === "revised") {
          const candidate = input.revisedCandidate!;
          if (
            candidate.caseId !== original.record.caseId ||
            candidate.runId !== original.record.runId ||
            candidate.question !== original.record.candidate.question
          )
            return fail("FORBIDDEN", "人工修订不能替换案件、轮次或调查问题");
          const run = runAnchor(tx, ctx, candidate.runId);
          if (!run.ok) return run;
          const view = deps.casesAtomic.inspectRunInTx(tx, ctx, run.value);
          if (!view.ok) return view;
          const version = tx.get<{ version: number }>(
            "SELECT MAX(version)+1 AS version FROM report_drafts WHERE run_id=?",
            [candidate.runId],
          )!.version;
          record = {
            ...original.record,
            id: deps.ids.next(),
            candidate,
            version,
            review: "revised",
            createdAt: deps.clock.now(),
            ...validate(candidate, view.value, original.policy),
          };
          const saved = saveReport(deps, tx, ctx, record, original.policy);
          if (!saved.ok) return saved;
        } else record = { ...original.record, review: input.disposition };
        const changed = deps.casesAtomic.recordChangeInTx(tx, ctx, {
          caseId: record.caseId,
          expectedRevision: input.expectedCaseRevision,
          reason: `人工审核报告：${input.disposition}；${input.humanConclusion}`,
        });
        if (!changed.ok) return changed;
        tx.run("UPDATE report_drafts SET review=? WHERE id=?", [
          input.disposition,
          original.record.id,
        ]);
        tx.run(
          "INSERT INTO reviews(id,report_id,case_revision,disposition,human_conclusion,note,revised_report_id,author_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
          [
            deps.ids.next(),
            original.record.id,
            changed.value,
            input.disposition,
            input.humanConclusion,
            input.note,
            input.disposition === "revised" ? record.id : null,
            ctx.actor.principalId,
            deps.clock.now(),
          ],
        );
        if (input.disposition !== "revised") reportEvent(deps, tx, ctx, record);
        return ok(record);
      });
    },
    async followups(ctx, caseId) {
      const parsed = parseDesktopInput("followups.list", { caseId });
      if (!parsed.ok) return parsed;
      const value = await deps.db.read(ctx, (tx) => {
        const auth = authorize(tx, ctx, ["ui", "system"]);
        if (!auth.ok) return auth;
        const found = deps.casesAtomic.getInTx(tx, ctx, caseId);
        if (!found.ok) return found;
        return ok(
          tx
            .all<Record<string, unknown>>(
              "SELECT * FROM followups WHERE case_id=? ORDER BY due_at IS NULL,due_at,id",
              [caseId],
            )
            .map(followup),
        );
      });
      return value.ok ? value.value : value;
    },
    async searchFollowups(ctx, raw) {
      const parsed = parseDesktopInput("followups.search", raw);
      if (!parsed.ok) return parsed;
      const input = parsed.value;
      const value = await deps.db.read(ctx, (tx) => {
        const auth = authorize(tx, ctx, ["ui", "system"]);
        if (!auth.ok) return auth;
        if (input.caseId) {
          const found = deps.casesAtomic.getInTx(tx, ctx, input.caseId);
          if (!found.ok) return found;
        }
        const queryHash = digest({
          principalId: ctx.actor.principalId,
          identityEpoch: ctx.actor.identityEpoch,
          caseId: input.caseId ?? null,
          state: input.state ?? null,
        });
        const decoded = input.page.cursor
          ? decodeCursor(input.page.cursor, {
              spaceId: ctx.actor.spaceId,
              queryHash,
            })
          : ok({ lastKeys: [] as Json[] });
        if (!decoded.ok) return decoded;
        const keys = decoded.value.lastKeys;
        if (
          keys.length &&
          (keys.length !== 3 ||
            ![0, 1].includes(keys[0] as number) ||
            typeof keys[1] !== "string" ||
            typeof keys[2] !== "string")
        )
          return fail("CURSOR_INVALID", "待办游标无效");
        const clauses: string[] = [],
          params: (string | number)[] = [];
        if (input.caseId) {
          clauses.push("case_id=?");
          params.push(input.caseId);
        }
        if (input.state) {
          clauses.push("state=?");
          params.push(input.state);
        }
        if (keys.length) {
          clauses.push(
            "((due_at IS NULL)>? OR ((due_at IS NULL)=? AND (COALESCE(due_at,'')>? OR (COALESCE(due_at,'')=? AND id>?))))",
          );
          params.push(
            keys[0] as number,
            keys[0] as number,
            keys[1] as string,
            keys[1] as string,
            keys[2] as string,
          );
        }
        const rows = tx.all<Record<string, unknown>>(
          "SELECT * FROM followups" +
            (clauses.length ? " WHERE " + clauses.join(" AND ") : "") +
            " ORDER BY due_at IS NULL,due_at,id LIMIT ?",
          [...params, input.page.limit + 1],
        );
        const items = rows.slice(0, input.page.limit).map(followup),
          last = items.at(-1);
        return ok({
          items,
          ...(rows.length > input.page.limit && last
            ? {
                nextCursor: encodeCursor({
                  version: "0.1.0",
                  spaceId: ctx.actor.spaceId,
                  queryHash,
                  lastKeys: [last.dueAt ? 0 : 1, last.dueAt ?? "", last.id],
                }),
              }
            : {}),
        });
      });
      return value.ok ? value.value : value;
    },
    async putFollowup(ctx, raw) {
      const parsed = parseDesktopInput("followups.put", raw);
      if (!parsed.ok) return parsed;
      const input = parsed.value;
      return deps.db.write(ctx, (tx) => {
        const auth = authorize(tx, ctx, ["ui"]);
        if (!auth.ok) return auth;
        const found = deps.casesAtomic.getInTx(tx, ctx, input.item.caseId);
        if (!found.ok) return found;
        const oldRow = tx.get<Record<string, unknown>>(
          "SELECT * FROM followups WHERE id=?",
          [input.item.id],
        );
        const old = oldRow ? followup(oldRow) : undefined;
        if (
          (old?.revision ?? 0) !== input.expectedRevision ||
          input.item.revision !== Math.max(1, input.expectedRevision)
        )
          return fail("REVISION_CONFLICT", "待办版本已改变");
        if (old && old.caseId !== input.item.caseId)
          return fail("FORBIDDEN", "不能把待办移至其他案件");
        if (!input.item.question.trim() || !input.item.suggestedAction.trim())
          return fail("INVALID_INPUT", "核查问题和动作不能为空");
        if (input.item.reportId) {
          const report = findReport(tx, input.item.reportId);
          if (!report || report.record.caseId !== input.item.caseId)
            return fail("FORBIDDEN", "报告不属于待办案件");
        }
        const visible = snapshot(deps, tx, ctx, input.item.caseId);
        if (!visible.ok) return visible;
        const available = new Set(
          visible.value.evidence.map((v) =>
            refKey({ evidenceId: v.id, version: v.version }),
          ),
        );
        if (input.item.evidenceRefs.some((ref) => !available.has(refKey(ref))))
          return fail("FORBIDDEN", "待办引用未获案件授权");
        const item = { ...input.item, revision: input.expectedRevision + 1 };
        tx.run(
          `INSERT INTO followups(id,case_id,report_id,revision,state,question,suggested_action,responsible_role,due_at,note,evidence_refs_json)
          VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET report_id=excluded.report_id,revision=excluded.revision,
          state=excluded.state,question=excluded.question,suggested_action=excluded.suggested_action,responsible_role=excluded.responsible_role,
          due_at=excluded.due_at,note=excluded.note,evidence_refs_json=excluded.evidence_refs_json`,
          [
            item.id,
            item.caseId,
            item.reportId ?? null,
            item.revision,
            item.state,
            item.question,
            item.suggestedAction,
            item.responsibleRole ?? null,
            item.dueAt ?? null,
            item.note ?? null,
            canonicalJson(item.evidenceRefs),
          ],
        );
        if (item.note !== old?.note) {
          tx.run(
            "INSERT INTO response_notes(id,case_id,followup_id,source,text,evidence_refs_json,author_id,created_at) VALUES(?,?,?,'human_statement',?,?,?,?)",
            [
              deps.ids.next(),
              item.caseId,
              item.id,
              item.note ?? "",
              canonicalJson(item.evidenceRefs),
              ctx.actor.principalId,
              deps.clock.now(),
            ],
          );
        }
        const changed = deps.casesAtomic.recordChangeInTx(tx, ctx, {
          caseId: item.caseId,
          expectedRevision: found.value.revision,
          reason: "保存人工核查事项",
        });
        return changed.ok ? ok(item) : changed;
      });
    },
  };
}
