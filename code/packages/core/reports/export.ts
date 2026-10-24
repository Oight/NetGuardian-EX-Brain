import {
  canonicalJson,
  fail,
  ok,
  parseDesktopInput,
  utf8Bytes,
  type Json,
  type ReportService,
} from "@campussec/contracts";
import {
  authorize,
  followup,
  reports,
  type Dependencies,
} from "./repositories.js";
import { snapshot } from "./human.js";

function redact(value: Json, paths: string[], path = ""): Json {
  if (Array.isArray(value))
    return value.map((v, i) => redact(v, paths, `${path}/${i}`));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const name = `${path}/${key}`;
        if (
          /password|secret|authorization|credential|private.?key|api.?key|cookie|token/i.test(
            key,
          )
        ) {
          paths.push(name);
          return [key, "[已隐藏的敏感字段]"];
        }
        return [key, redact(item, paths, name)];
      }),
    );
  return value;
}
export function exportCase(deps: Dependencies): ReportService["export"] {
  return async (ctx, raw) => {
    const parsed = parseDesktopInput("cases.export", raw);
    if (!parsed.ok) return parsed;
    const input = parsed.value;
    const result = await deps.db.read(ctx, (tx) => {
      const auth = authorize(tx, ctx, ["ui"]);
      if (!auth.ok) return auth;
      const view = snapshot(deps, tx, ctx, input.caseId);
      if (!view.ok) return view;
      if (view.value.case.revision !== input.caseRevision)
        return fail("REVISION_CONFLICT", "导出前案件版本已改变");
      const redactedPaths: string[] = [];
      const responseNotes = tx
        .all<Record<string, unknown>>(
          "SELECT * FROM response_notes WHERE case_id=? ORDER BY created_at,id",
          [input.caseId],
        )
        .map((row) => ({
          id: row.id,
          followupId: row.followup_id,
          source: row.source,
          text: row.text,
          authorId: row.author_id,
          createdAt: row.created_at,
          evidenceRefs: JSON.parse(row.evidence_refs_json as string),
        }));
      const payload = {
        schemaVersion: "0.1.0",
        ...view.value,
        reports: reports(tx, input.caseId),
        reviews: tx.all(
          "SELECT * FROM reviews WHERE report_id IN (SELECT id FROM report_drafts WHERE case_id=?) ORDER BY created_at,id",
          [input.caseId],
        ),
        followups: tx
          .all<Record<string, unknown>>(
            "SELECT * FROM followups WHERE case_id=? ORDER BY due_at IS NULL,due_at,id",
            [input.caseId],
          )
          .map(followup),
        responseNotes,
        exportedAt: deps.clock.now(),
        warnings: [
          "人工审核和人工备注不等于新的观测事实。",
          "查询覆盖来自案件当前快照（最多最近100条）；不是全部历史查询。",
        ],
      };
      const safe = redact(
        JSON.parse(canonicalJson(payload)),
        redactedPaths,
      ) as Record<string, Json>;
      safe.redactedPaths = redactedPaths;
      if (redactedPaths.length)
        (safe.warnings as Json[]).push(
          "导出隐藏了敏感字段；原始内容摘要继续指向本地原件。",
        );
      const json = JSON.stringify(safe, null, 2) + "\n";
      if (utf8Bytes(json) > 4 * 1048576)
        return fail("INVALID_INPUT", "案件导出超过4MiB，请先缩小材料范围");
      let fenceLength = 3;
      for (const match of json.matchAll(/~+/g))
        fenceLength = Math.max(fenceLength, match[0].length + 1);
      const fence = "~".repeat(fenceLength);
      const text =
        input.format === "json"
          ? json
          : `# 校安智脑案件交接\n\n案件 ID：${view.value.case.id}\n\n审核状态、覆盖缺口及人工记录见下列同一快照。\n\n${fence}json\n${json}${fence}\n`;
      if (utf8Bytes(text) > 4 * 1048576)
        return fail("INVALID_INPUT", "导出正文超过4MiB，请先缩小材料范围");
      return ok({
        filename: `campussec-case-${view.value.case.id}-r${input.caseRevision}.${input.format === "json" ? "json" : "md"}`,
        mediaType:
          input.format === "json" ? "application/json" : "text/markdown",
        text,
      });
    });
    return result.ok ? result.value : result;
  };
}
