import {
  canonicalJson,
  fail,
  ok,
  instantSchema,
  idSchema,
  type CaseAtomicPort,
  type CallContext,
  type CleanupPlan,
  type ReadTx,
  type Result,
} from "@campussec/contracts";
import { getCase, hash, type Dependencies } from "./repositories.js";
type Candidate = {
  evidence_id: string;
  version: number;
  content_hash: string;
  availability: string;
  bytes: number;
  blocked: boolean;
  projections: string[];
  links: string[];
  runs: string[];
};
function inspect(
  tx: ReadTx,
  ctx: CallContext,
  caseIds: string[],
  olderThan: string,
  protectedRunIds: string[],
): Result<{
  revisions: {
    caseId: string;
    revision: number;
  }[];
  candidates: Candidate[];
  protectedRunIds: string[];
}> {
  if (!["ui", "system"].includes(ctx.actor.role))
    return fail("FORBIDDEN", "当前入口不能清理证据");
  if (
    !caseIds.length ||
    caseIds.length > 100 ||
    new Set(caseIds).size !== caseIds.length ||
    !instantSchema.safeParse(olderThan).success ||
    caseIds.some((id) => !idSchema.safeParse(id).success) ||
    protectedRunIds.some((id) => !idSchema.safeParse(id).success)
  )
    return fail("INVALID_INPUT", "清理参数无效");
  const revisions = [];
  for (const caseId of [...caseIds].sort()) {
    const found = getCase(tx, ctx, caseId);
    if (!found.ok) return found;
    revisions.push({ caseId, revision: found.value.revision });
  }
  const candidates: Candidate[] = [];
  const rows = tx.all<{
    evidence_id: string;
    version: number;
    content_hash: string;
    availability: string;
    fields_json: string;
  }>(
    "SELECT evidence_id,version,content_hash,availability,fields_json FROM evidence_versions WHERE retrieved_at<? AND availability=? ORDER BY evidence_id,version",
    [olderThan, "available"],
  );
  for (const row of rows) {
    const links = tx
      .all<{
        case_id: string;
      }>(
        "SELECT case_id FROM evidence_links WHERE evidence_id=? AND evidence_version=? AND removed_revision IS NULL ORDER BY case_id",
        [row.evidence_id, row.version],
      )
      .map((v) => v.case_id);
    const runs = tx.all<{
      run_id: string;
      case_id: string;
    }>(
      "SELECT r.run_id,a.case_id FROM run_evidence r JOIN analysis_runs a ON a.id=r.run_id WHERE r.evidence_id=? AND r.evidence_version=? ORDER BY r.run_id",
      [row.evidence_id, row.version],
    );
    if (
      ![...links, ...runs.map((r) => r.case_id)].some((id) =>
        caseIds.includes(id),
      )
    )
      continue;
    const projections = tx
      .all<{
        id: string;
      }>(
        "SELECT id FROM evidence_projections WHERE evidence_id=? AND evidence_version=? AND availability=? ORDER BY id",
        [row.evidence_id, row.version, "available"],
      )
      .map((v) => v.id);
    candidates.push({
      evidence_id: row.evidence_id,
      version: row.version,
      content_hash: row.content_hash,
      availability: row.availability,
      bytes: new TextEncoder().encode(row.fields_json).byteLength,
      blocked:
        links.some((id) => !caseIds.includes(id)) ||
        runs.some(
          (r) =>
            !caseIds.includes(r.case_id) || protectedRunIds.includes(r.run_id),
        ),
      projections,
      links,
      runs: runs.map((r) => r.run_id),
    });
  }
  return ok({
    revisions,
    candidates,
    protectedRunIds: [...new Set(protectedRunIds)].sort(),
  });
}
export function retentionOperations(deps: Dependencies) {
  const previewCleanupInTx: CaseAtomicPort["previewCleanupInTx"] = (
    tx,
    ctx,
    input,
  ) => {
    const inspected = inspect(
      tx,
      ctx,
      input.caseIds,
      input.olderThan,
      input.protectedRunIds,
    );
    if (!inspected.ok) return inspected;
    const details = {
      caseIds: [...input.caseIds].sort(),
      olderThan: input.olderThan,
      ...inspected.value,
    };
    const plan: CleanupPlan = {
      id: deps.ids.next(),
      planHash: hash(details),
      expiresAt: new Date(Date.parse(deps.clock.now()) + 600000).toISOString(),
      caseIds: details.caseIds,
      caseRevisions: details.revisions,
      removableVersions: details.candidates.filter((c) => !c.blocked).length,
      blockedVersions: details.candidates.filter((c) => c.blocked).length,
      approximateBytes: details.candidates
        .filter((c) => !c.blocked)
        .reduce((n, c) => n + c.bytes, 0),
    };
    tx.run(
      "INSERT INTO cleanup_plans(id,plan_hash,plan_json,state,expires_at,created_at) VALUES(?,?,?,?,?,?)",
      [
        plan.id,
        plan.planHash,
        canonicalJson({ plan, details }),
        "preview",
        plan.expiresAt,
        deps.clock.now(),
      ],
    );
    return ok(plan);
  };
  const applyCleanupInTx: CaseAtomicPort["applyCleanupInTx"] = (
    tx,
    ctx,
    input,
  ) => {
    const row = tx.get<{
      plan_hash: string;
      plan_json: string;
      state: string;
      expires_at: string;
    }>("SELECT * FROM cleanup_plans WHERE id=?", [input.planId]);
    if (!row) return fail("NOT_FOUND", "清理计划不存在");
    if (row.state !== "preview") return fail("CONFLICT", "清理计划已经使用");
    if (row.expires_at <= deps.clock.now())
      return fail("EXPIRED", "清理计划已过期，请重新预览");
    if (row.plan_hash !== input.expectedPlanHash)
      return fail("CONFLICT", "清理计划哈希不一致");
    const saved = JSON.parse(row.plan_json) as {
      plan: CleanupPlan;
      details: {
        caseIds: string[];
        olderThan: string;
      };
    };
    const current = inspect(
      tx,
      ctx,
      saved.details.caseIds,
      saved.details.olderThan,
      input.protectedRunIds,
    );
    if (!current.ok) return current;
    const details = {
      caseIds: saved.details.caseIds,
      olderThan: saved.details.olderThan,
      ...current.value,
    };
    if (hash(details) !== row.plan_hash)
      return fail("CONFLICT", "案件、引用或活动保护集合已变化，请重新预览");
    let expiredVersions = 0;
    const projectionIds: string[] = [];
    for (const candidate of current.value.candidates.filter(
      (c) => !c.blocked,
    )) {
      expiredVersions += tx.run(
        "UPDATE evidence_versions SET fields_json=?,availability=? WHERE evidence_id=? AND version=? AND availability=?",
        [
          "{}",
          "expired",
          candidate.evidence_id,
          candidate.version,
          "available",
        ],
      ).changes;
      for (const id of candidate.projections) {
        tx.run(
          "UPDATE evidence_projections SET content_json=?,availability=? WHERE id=?",
          ["{}", "expired", id],
        );
        projectionIds.push(id);
      }
    }
    tx.run("UPDATE cleanup_plans SET state=? WHERE id=?", [
      "applied",
      input.planId,
    ]);
    return ok({ expiredVersions, projectionIds });
  };
  return { previewCleanupInTx, applyCleanupInTx };
}
