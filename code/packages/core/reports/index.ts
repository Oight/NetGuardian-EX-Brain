import {
  canonicalJson,
  fail,
  idSchema,
  ok,
  parseDto,
  parseReportCandidate,
  parseReportValidationInput,
  type DatabasePort,
  type ReportService,
  type ResultPackageReadPort,
} from "@campussec/contracts";
import { createInvestigationProfile } from "@campussec/investigation-profile";
import {
  authorize,
  contextIdentity,
  readResult,
  reports,
  resultAt,
  runAnchor,
  saveReport,
  type Dependencies,
} from "./repositories.js";
import { referencePolicy, validate } from "./validate.js";
import { completion } from "./completion.js";
import { human } from "./human.js";
import { exportCase } from "./export.js";
export type { Dependencies as ReportDependencies } from "./repositories.js";

export function createReportService(deps: Dependencies): ReportService {
  return {
    prepare: createInvestigationProfile().prepare,
    proposeInTx(tx, ctx, raw) {
      const auth = authorize(tx, ctx, ["system", "evidence"]);
      if (!auth.ok) return auth;
      const candidate = parseReportCandidate(raw.candidate),
        input = parseReportValidationInput(raw.validationInput);
      if (!candidate.ok) return candidate;
      if (!input.ok) return input;
      const run = runAnchor(tx, ctx, candidate.value.runId);
      if (!run.ok) return run;
      if (candidate.value.caseId !== run.value.caseId)
        return fail("FORBIDDEN", "候选案件与轮次不匹配");
      const found = deps.casesAtomic.getInTx(tx, ctx, run.value.caseId);
      if (!found.ok) return found;
      const view = deps.casesAtomic.inspectRunInTx(tx, ctx, run.value);
      if (!view.ok) return view;
      if (canonicalJson(view.value) !== canonicalJson(input.value.view))
        return fail("REVISION_CONFLICT", "证据校验快照已改变");
      const policy = referencePolicy(input.value, run.value);
      if (!policy.ok) return policy;
      const question = tx.get<{ initial_input_json: string }>(
        "SELECT initial_input_json FROM analysis_runs WHERE id=?",
        [run.value.id],
      );
      try {
        if (
          JSON.parse(question?.initial_input_json ?? "{}").question !==
          candidate.value.question
        )
          return fail("VALIDATION_FAILED", "候选问题与冻结输入不一致");
      } catch {
        return fail("VALIDATION_FAILED", "冻结问题损坏");
      }
      const version = tx.get<{ n: number }>(
        "SELECT COALESCE(MAX(version),0)+1 AS n FROM report_drafts WHERE run_id=?",
        [run.value.id],
      )!.n;
      return saveReport(
        deps,
        tx,
        ctx,
        {
          id: deps.ids.next(),
          caseId: run.value.caseId,
          runId: run.value.id,
          version,
          baseRevision: run.value.baseRevision,
          candidate: candidate.value,
          ...validate(candidate.value, view.value, policy.value),
          review: "unreviewed",
          createdAt: deps.clock.now(),
        },
        policy.value,
      );
    },
    ...completion(deps),
    ...human(deps),
    export: exportCase(deps),
    list(ctx, caseId) {
      if (!idSchema.safeParse(caseId).success)
        return Promise.resolve(fail("INVALID_INPUT", "案件标识无效"));
      return readResult(deps, ctx, (tx) => {
        const auth = authorize(tx, ctx, ["ui", "system"]);
        if (!auth.ok) return auth;
        const found = deps.casesAtomic.getInTx(tx, ctx, caseId);
        return found.ok ? ok(reports(tx, caseId)) : found;
      });
    },
  };
}

/** Internal read port. S11 must first authorize the source subscription in the same transaction. */
export function createResultPackageReader(_deps: {
  db: DatabasePort;
}): ResultPackageReadPort {
  return {
    getInTx(tx, ctx, input) {
      const auth = authorize(tx, ctx, ["ui", "system", "delegation"]);
      if (!auth.ok) return auth;
      if (
        !idSchema.safeParse(input.requestId).success ||
        (input.resultVersion !== undefined &&
          (!Number.isSafeInteger(input.resultVersion) ||
            input.resultVersion < 1))
      )
        return fail("INVALID_INPUT", "结果读取参数无效");
      const value = resultAt(tx, input.requestId, input.resultVersion);
      if (!value) return fail("RESULT_NOT_READY", "结果尚未生成");
      const identity = contextIdentity(tx, ctx, value.result);
      if (!identity.ok) return identity;
      if (ctx.actor.runId && ctx.actor.runId !== value.result.runId)
        return fail("FORBIDDEN", "结果轮次不匹配");
      return ok(value.result);
    },
  };
}
