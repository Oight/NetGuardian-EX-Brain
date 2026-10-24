import {
  canonicalJson,
  fail,
  ok,
  parseReportValidationInput,
  type AnalysisRun,
  type ReportCandidate,
  type ReportRecord,
  type ReportValidationInput,
  type Result,
  type RunEvidenceView,
} from "@campussec/contracts";
import {
  contextKey,
  digest,
  refKey,
  type ReferencePolicy,
} from "./repositories.js";

export function referencePolicy(
  raw: ReportValidationInput,
  run: AnalysisRun,
): Result<ReferencePolicy> {
  const parsed = parseReportValidationInput(raw);
  if (!parsed.ok) return parsed;
  if (
    parsed.value.view.runId !== run.id ||
    parsed.value.view.caseId !== run.caseId ||
    canonicalJson(parsed.value.view.scope) !== canonicalJson(run.scope)
  )
    return fail("FORBIDDEN", "报告校验快照不属于本轮");
  const seen = new Set<string>(),
    uncertainContexts: string[] = [];
  for (const { ref, context } of parsed.value.contexts) {
    const key = contextKey(ref);
    if (
      seen.has(key) ||
      ref.contextId !== context.id ||
      ref.version !== context.version ||
      (context.caseId && context.caseId !== run.caseId) ||
      context.connectionId !== run.scope.connectionId ||
      !context.agentIds.some((id) => run.scope.agentIds.includes(id)) ||
      context.from >= run.scope.to ||
      context.to <= run.scope.from
    )
      return fail("FORBIDDEN", "已交付背景的身份或范围无效");
    seen.add(key);
    if (context.verification !== "verified") uncertainContexts.push(key);
  }
  return ok({
    contextRefs: parsed.value.contexts.map((v) => v.ref),
    uncertainContexts,
  });
}
export function validate(
  candidate: ReportCandidate,
  view: RunEvidenceView,
  policy: ReferencePolicy,
): Pick<ReportRecord, "validation" | "validationIssues"> {
  const invalid = new Set<string>(),
    review = new Set<string>();
  const projections = new Map(view.projections.map((v) => [v.id, v]));
  const queries = new Map(view.queries.map((v) => [v.queryId, v.coverage]));
  const contexts = new Set(policy.contextRefs.map(contextKey));
  let limited = view.queries.some(
    ({ coverage }) =>
      coverage.queryCompleteness !== "complete" ||
      coverage.collectionCoverage !== "known",
  );
  for (const statement of [
    ...candidate.facts,
    ...candidate.analysis,
    ...candidate.conflicts,
  ]) {
    for (const ref of statement.evidenceRefs) {
      const projection = projections.get(ref.projectionId);
      if (
        !projection ||
        projection.runId !== candidate.runId ||
        refKey(projection.ref) !== refKey(ref)
      )
        invalid.add("引用不属于本轮证据投影");
      else if (projection.state !== "released") invalid.add("引用尚未确认交付");
      else if (projection.availability !== "available")
        invalid.add("引用正文已过期");
      else if (digest(projection.content) !== projection.contentHash)
        invalid.add("投影内容摘要不匹配");
    }
    for (const id of statement.queryIds) {
      const coverage = queries.get(id);
      if (!coverage) invalid.add("查询引用不属于本轮");
      else if (
        coverage.queryCompleteness !== "complete" ||
        coverage.collectionCoverage !== "known"
      )
        limited = true;
    }
    for (const ref of statement.contextRefs) {
      if (!contexts.has(contextKey(ref))) invalid.add("背景版本未在本轮交付");
      else if (policy.uncertainContexts.includes(contextKey(ref)))
        review.add("引用了尚未核实或被否定的人工背景");
    }
  }
  if (
    candidate.facts.some(
      (s) =>
        !s.evidenceRefs.length && !s.queryIds.length && !s.contextRefs.length,
    )
  )
    review.add("事实陈述缺少可复核引用");
  if (
    candidate.classification === "explained" &&
    (limited || !candidate.facts.length)
  )
    review.add("解释性结论的证据覆盖或事实依据需要人工核查");
  if (
    candidate.classification === "insufficient_evidence" &&
    !candidate.gaps.length
  )
    review.add("证据不足但未列明缺口");
  const issues = [...invalid, ...review];
  return {
    validation: invalid.size
      ? "invalid"
      : review.size
        ? "needs_review"
        : "valid",
    validationIssues: issues.slice(0, 100),
  };
}
