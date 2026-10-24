import {
  canonicalJson,
  fail,
  ok,
  parseCompletionDecision,
  parseDto,
  type ReportAssessment,
  type ReportRecord,
  type ReportService,
  type Result,
  type ResultContext,
  type ResultPackage,
} from "@campussec/contracts";
import {
  authorize,
  contextIdentity,
  decodeReport,
  digest,
  findReport,
  resultAt,
  runAnchor,
  saveResult,
  within,
  type Dependencies,
  type ReportRow,
} from "./repositories.js";

const clip = (value: string, max = 2000) =>
  Array.from(value).slice(0, max).join("");
function limited(values: string[]): string[] {
  return values.length <= 10
    ? values
    : [...values.slice(0, 9), `另有 ${values.length - 9} 项，见完整本地报告`];
}
export function assessment(
  tx: Parameters<ReportService["assessInTx"]>[0],
  runId: string,
): ReportAssessment {
  const row = tx.get<ReportRow>(
    "SELECT * FROM report_drafts WHERE run_id=? ORDER BY version DESC LIMIT 1",
    [runId],
  );
  if (!row) return { validation: "missing" };
  const { record } = decodeReport(row);
  return { reportId: record.id, validation: record.validation };
}
function packageValue(
  context: ResultContext,
  decision: Parameters<ReportService["terminalWithoutRunInTx"]>[2]["decision"],
  report?: ReportRecord,
): ResultPackage {
  const candidate = report?.candidate;
  const claims =
    report?.validation !== "invalid" ? (candidate?.facts ?? []) : [];
  const gaps = [
    ...(candidate?.gaps ?? []),
    ...(report?.validationIssues ?? []),
  ];
  if (claims.length > 5)
    gaps.push(`主证据另有 ${claims.length - 5} 项，见完整本地报告`);
  if ((candidate?.followups.length ?? 0) > 10)
    gaps.push(`核查事项共 ${candidate!.followups.length} 项，见本地待办`);
  return {
    schemaVersion: "0.1.0",
    ...context,
    resultVersion: 1,
    terminalState: decision.terminalState,
    review: report?.review ?? "unreviewed",
    summary: clip(
      [
        decision.reason,
        candidate?.question,
        ...claims.slice(0, 2).map((s) => s.text),
      ]
        .filter(Boolean)
        .join("；"),
    ),
    ...(report ? { reportId: report.id } : {}),
    mainEvidence: claims.slice(0, 5),
    gaps: limited(gaps),
    followups: candidate?.followups.slice(0, 10) ?? [],
    ...(decision.error ? { error: decision.error } : {}),
  };
}
export function completion(
  deps: Dependencies,
): Pick<
  ReportService,
  | "assessInTx"
  | "finalizeInTx"
  | "terminalWithoutRunInTx"
  | "publishReviewedInTx"
> {
  return {
    assessInTx(tx, ctx, runId) {
      const auth = authorize(tx, ctx, ["system"]);
      if (!auth.ok) return auth;
      const run = runAnchor(deps, tx, ctx, runId);
      if (!run.ok) return run;
      const found = deps.casesAtomic.getInTx(tx, ctx, run.value.caseId);
      return found.ok ? ok(assessment(tx, runId)) : found;
    },
    finalizeInTx(tx, ctx, input) {
      const auth = authorize(tx, ctx, ["system"]);
      if (!auth.ok) return auth;
      const run = parseDto("AnalysisRun", input.run),
        context = parseDto("ResultContext", input.context),
        decision = parseCompletionDecision(input.decision),
        asked = parseDto("ReportAssessment", input.assessment);
      if (!run.ok) return run;
      if (!context.ok) return context;
      if (!decision.ok) return decision;
      if (!asked.ok) return asked;
      const identity = contextIdentity(deps, tx, ctx, context.value);
      if (!identity.ok) return identity;
      if (!/^[a-f0-9]{64}$/.test(input.manifestHash))
        return fail("INVALID_INPUT", "封存摘要无效");
      const live = runAnchor(deps, tx, ctx, run.value.id);
      if (!live.ok) return live;
      const anchor = (v: typeof run.value) => ({
        id: v.id,
        jobId: v.jobId,
        caseId: v.caseId,
        baseRevision: v.baseRevision,
        scope: v.scope,
        identityEpoch: v.identityEpoch,
        connectionGeneration: v.connectionGeneration,
        profileVersion: v.profileVersion,
      });
      if (
        canonicalJson(anchor(live.value)) !==
          canonicalJson(anchor(run.value)) ||
        context.value.runId !== run.value.id ||
        context.value.jobId !== run.value.jobId ||
        context.value.caseId !== run.value.caseId ||
        canonicalJson(context.value.scope) !== canonicalJson(run.value.scope) ||
        (live.value.manifestHash &&
          live.value.manifestHash !== input.manifestHash) ||
        (run.value.manifestHash &&
          run.value.manifestHash !== input.manifestHash)
      )
        return fail("FORBIDDEN", "结果关联或封存摘要不匹配");
      const found = deps.casesAtomic.getInTx(tx, ctx, run.value.caseId);
      if (!found.ok) return found;
      const fingerprint = digest({
        kind: "completion",
        run: anchor(run.value),
        context: context.value,
        decision: decision.value,
        manifestHash: input.manifestHash,
        assessment: asked.value,
      });
      const existing = resultAt(tx, context.value.requestId, 1);
      if (existing)
        return existing.fingerprint === fingerprint
          ? ok(existing.result)
          : fail("CONFLICT", "已按其他完成内容生成结果");
      const latest = assessment(tx, run.value.id);
      if (canonicalJson(latest) !== canonicalJson(asked.value))
        return fail("REVISION_CONFLICT", "报告评估已改变");
      if (
        decision.value.terminalState === "succeeded" &&
        latest.validation !== "valid"
      )
        return fail(
          "VALIDATION_FAILED",
          "成功决定需要有效草案，请协调者重新决定",
        );
      const report = latest.reportId
        ? findReport(tx, latest.reportId)?.record
        : undefined;
      const saved = saveResult(
        deps,
        tx,
        packageValue(context.value, decision.value, report),
        fingerprint,
      );
      if (!saved.ok) return saved;
      for (const draft of report?.candidate.followups ?? []) {
        tx.run(
          "INSERT INTO followups(id,case_id,report_id,revision,state,question,suggested_action,responsible_role,evidence_refs_json) VALUES(?,?,?,1,'open',?,?,?,?)",
          [
            deps.ids.next(),
            run.value.caseId,
            report!.id,
            draft.question,
            draft.suggestedAction,
            draft.responsibleRole ?? null,
            "[]",
          ],
        );
      }
      return saved;
    },
    terminalWithoutRunInTx(tx, ctx, input) {
      const auth = authorize(tx, ctx, ["system"]);
      if (!auth.ok) return auth;
      const context = parseDto("ResultContext", input.context),
        decision = parseCompletionDecision(input.decision);
      if (!context.ok) return context;
      if (!decision.ok) return decision;
      const identity = contextIdentity(deps, tx, ctx, context.value);
      if (!identity.ok) return identity;
      if (context.value.runId || decision.value.terminalState === "succeeded")
        return fail("INVALID_INPUT", "未启动结果不能携带轮次或宣称调查成功");
      if (identity.value.hasRun)
        return fail("FORBIDDEN", "已建立轮次的任务必须保留真实 runId");
      const found = deps.casesAtomic.getInTx(tx, ctx, context.value.caseId);
      if (!found.ok) return found;
      if (!within(context.value.scope, found.value.scope))
        return fail("SCOPE_EXCEEDED", "结果范围超出案件");
      const fingerprint = digest({
        kind: "without_run",
        context: context.value,
        decision: decision.value,
      });
      const existing = resultAt(tx, context.value.requestId, 1);
      if (existing)
        return existing.fingerprint === fingerprint
          ? ok(existing.result)
          : fail("CONFLICT", "请求已有其他结果");
      return saveResult(
        deps,
        tx,
        packageValue(context.value, decision.value),
        fingerprint,
      );
    },
    publishReviewedInTx(tx, ctx, input) {
      const auth = authorize(tx, ctx, ["system"]);
      if (!auth.ok) return auth;
      const context = parseDto("ResultContext", input.context);
      if (!context.ok) return context;
      const identity = contextIdentity(deps, tx, ctx, context.value);
      if (!identity.ok) return identity;
      if (
        !Number.isSafeInteger(input.expectedResultVersion) ||
        input.expectedResultVersion < 1 ||
        !Number.isSafeInteger(input.expectedCaseRevision) ||
        input.expectedCaseRevision < 1
      )
        return fail("INVALID_INPUT", "发布版本无效");
      const found = deps.casesAtomic.getInTx(tx, ctx, context.value.caseId);
      if (!found.ok) return found;
      const report = findReport(tx, input.reportId)?.record;
      if (
        !report ||
        report.caseId !== context.value.caseId ||
        report.runId !== context.value.runId
      )
        return fail("FORBIDDEN", "报告不属于原结果的轮次");
      if (
        !["accepted", "revised"].includes(report.review) ||
        report.validation === "invalid"
      )
        return fail("VALIDATION_FAILED", "报告尚未获人工认可或仍有引用错误");
      const original = resultAt(
        tx,
        context.value.requestId,
        input.expectedResultVersion,
      );
      if (
        !original ||
        original.result.caseId !== context.value.caseId ||
        original.result.runId !== context.value.runId ||
        original.result.jobId !== context.value.jobId ||
        canonicalJson(original.result.scope) !==
          canonicalJson(context.value.scope)
      )
        return fail("FORBIDDEN", "原结果关联不匹配");
      const fingerprint = digest({
        kind: "review",
        context: context.value,
        reportId: report.id,
        expectedCaseRevision: input.expectedCaseRevision,
        expectedResultVersion: input.expectedResultVersion,
      });
      const retry = resultAt(
        tx,
        context.value.requestId,
        input.expectedResultVersion + 1,
      );
      if (retry)
        return retry.fingerprint === fingerprint
          ? ok(retry.result)
          : fail("CONFLICT", "该结果版本已用于其他发布");
      if (
        found.value.revision !== input.expectedCaseRevision ||
        resultAt(tx, context.value.requestId)?.result.resultVersion !==
          input.expectedResultVersion
      )
        return fail("REVISION_CONFLICT", "案件或结果版本已改变");
      const result = packageValue(
        context.value,
        {
          terminalState: original.result.terminalState,
          reason: "人工审核后的修订结果",
          ...(original.result.error ? { error: original.result.error } : {}),
        },
        report,
      );
      return saveResult(
        deps,
        tx,
        { ...result, resultVersion: input.expectedResultVersion + 1 },
        fingerprint,
      );
    },
  };
}
