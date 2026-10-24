import {
  canonicalJson,
  fail,
  ok,
  parseDto,
  type CallContext,
  type CaseAtomicPort,
  type Coverage,
  type EvidenceRef,
  type PlatformQuery,
  type QueryCapture,
  type ReadTx,
  type Result,
  type SourceLocator,
  type SourceRecord,
  type WriteTx,
} from "@campussec/contracts";
import {
  authorized,
  change,
  getCase,
  hash,
  mutable,
  runView,
  uniqueRefs,
  within,
  type Dependencies,
} from "./repositories.js";
function sourceKey(source: SourceLocator): Result<string> {
  if (source.kind === "index_document") {
    if (
      !source.index ||
      !source.documentId ||
      source.resource ||
      source.collectionIdentity
    )
      return fail("INVALID_INPUT", "索引材料缺少原生身份");
    return ok(
      hash([
        source.platformInstanceId,
        "index",
        source.index,
        source.documentId,
      ]),
    );
  }
  if (
    !source.resource ||
    !source.agentId ||
    !source.collectionIdentity ||
    source.index ||
    source.documentId
  )
    return fail("INVALID_INPUT", "资源缺少稳定采集身份");
  return ok(
    hash([
      source.platformInstanceId,
      "resource",
      source.resource,
      source.agentId,
      source.collectionIdentity,
    ]),
  );
}
export function logicalQuery(query: PlatformQuery) {
  const { page: _page, ...conditions } = query;
  return { ...conditions, pageSize: query.page.limit };
}
export function queryViews(tx: ReadTx, caseId: string, runId?: string) {
  return tx
    .all<{
      id: string;
      coverage_json: string;
    }>(
      "SELECT id,coverage_json FROM query_runs WHERE " +
        (runId
          ? "run_id=?"
          : "(case_id=? OR run_id IN (SELECT id FROM analysis_runs WHERE case_id=?))") +
        " ORDER BY created_at DESC,id DESC LIMIT 100",
      runId ? [runId] : [caseId, caseId],
    )
    .map((row) => ({
      queryId: row.id,
      coverage: JSON.parse(row.coverage_json) as Coverage,
    }));
}
export function capture(deps: Dependencies): CaseAtomicPort["captureInTx"] {
  return (tx, ctx, input) => {
    const auth = authorized(tx, ctx);
    if (!auth.ok) return auth;
    const parsed = parseDto("QueryCapture", input);
    if (!parsed.ok) return parsed;
    input = parsed.value;
    const { query, page } = input;
    if (
      input.connectionId !== query.scope.connectionId ||
      page.pageOrdinal > 3 ||
      page.coverage.returned !== page.records.length ||
      (page.pageOrdinal === 0 && query.page.cursor)
    )
      return fail("INVALID_INPUT", "查询或页身份不一致");
    if (
      ctx.actor.role === "evidence" &&
      (!input.runId || ctx.actor.runId !== input.runId)
    )
      return fail("FORBIDDEN", "证据通道必须绑定当前轮次");
    if (
      !within(page.coverage.effectiveScope, query.scope) ||
      canonicalJson(page.coverage.requestedScope) !== canonicalJson(query.scope)
    )
      return fail("SCOPE_EXCEEDED", "返回覆盖超出查询范围");
    let record;
    if (input.runId) {
      const run = runView(tx, ctx, input.runId);
      if (!run.ok) return run;
      const allowed = mutable(tx, input.runId);
      if (!allowed.ok) return allowed;
      if (
        !within(query.scope, run.value.scope) ||
        (input.caseId && input.caseId !== run.value.caseId)
      )
        return fail("SCOPE_EXCEEDED", "查询超出轮次范围");
    } else if (input.caseId) {
      const found = getCase(tx, ctx, input.caseId);
      if (!found.ok) return found;
      if (!within(query.scope, found.value.scope))
        return fail("SCOPE_EXCEEDED", "查询超出案件范围");
      record = found.value;
    } else if (ctx.actor.role !== "system")
      return fail("FORBIDDEN", "无案件采集只允许系统入口");
    const connection = tx.get<{
      platform_instance_id: string;
    }>("SELECT platform_instance_id FROM connections WHERE id=?", [
      input.connectionId,
    ]);
    if (!connection) return fail("NOT_FOUND", "连接不存在");
    const normalized = canonicalJson(logicalQuery(query));
    const existing = tx.get<{
      connection_id: string;
      run_id: string | null;
      case_id: string | null;
      query_json: string;
      sealed: number;
    }>("SELECT * FROM query_runs WHERE id=?", [page.queryId]);
    if (
      existing &&
      (existing.sealed ||
        existing.connection_id !== input.connectionId ||
        existing.run_id !== (input.runId ?? null) ||
        existing.case_id !== (input.caseId ?? null) ||
        existing.query_json !== normalized)
    )
      return fail("CONFLICT", "查询身份已被其他内容使用或已经封存");
    const pageHash = hash(page);
    const savedPage = tx.get<{
      page_id: string;
      query_id: string;
      content_hash: string;
    }>(
      "SELECT page_id,query_id,content_hash FROM query_pages WHERE page_id=? OR (query_id=? AND page_ordinal=?)",
      [page.pageId, page.queryId, page.pageOrdinal],
    );
    if (savedPage) {
      if (
        savedPage.page_id !== page.pageId ||
        savedPage.query_id !== page.queryId ||
        savedPage.content_hash !== pageHash
      )
        return fail("CONFLICT", "同页响应变化，原始快照已保留");
      const refs = tx.get<{
        refs_json: string;
      }>("SELECT refs_json FROM case_query_page_refs WHERE page_id=?", [
        page.pageId,
      ]);
      return refs
        ? ok(JSON.parse(refs.refs_json) as EvidenceRef[])
        : fail("CONFLICT", "旧页缺少精确引用映射，不能推定本页材料");
    }
    const sources: {
      record: SourceRecord;
      key: string;
    }[] = [];
    const kinds = {
      alerts: "alert",
      authentication: "authentication",
      inventory: "inventory",
      file_changes: "fim",
      findings: "finding",
    } as const;
    for (const value of page.records) {
      const key = sourceKey(value.source);
      if (!key.ok) return key;
      const agent = value.agentId ?? value.source.agentId;
      if (
        value.source.platformInstanceId !== connection.platform_instance_id ||
        value.kind !== kinds[query.kind] ||
        !agent ||
        !query.scope.agentIds.includes(agent) ||
        (value.agentId &&
          value.source.agentId &&
          value.agentId !== value.source.agentId)
      )
        return fail("SCOPE_EXCEEDED", "材料来源或设备不属于本次查询");
      if (
        ["alerts", "authentication", "file_changes"].includes(query.kind) &&
        value.observedAt &&
        (value.observedAt < query.scope.from ||
          value.observedAt >=
            (query.kind === "alerts" ? query.fixedUpper : query.scope.to))
      )
        return fail("SCOPE_EXCEEDED", "材料事件时间超出查询范围");
      sources.push({ record: value, key: key.value });
    }
    if (!existing)
      tx.run(
        "INSERT INTO query_runs(id,connection_id,run_id,case_id,query_json,coverage_json,status,created_at) VALUES(?,?,?,?,?,?,?,?)",
        [
          page.queryId,
          input.connectionId,
          input.runId ?? null,
          input.caseId ?? null,
          normalized,
          canonicalJson(page.coverage),
          page.status,
          deps.clock.now(),
        ],
      );
    const refs: EvidenceRef[] = [];
    for (const { record: value, key } of sources) {
      const contentHash = hash({
        kind: value.kind,
        observedAt: value.observedAt ?? null,
        timeQuality: value.timeQuality,
        fields: value.fields,
      });
      const source = tx.get<{
        evidence_id: string;
        connection_id: string;
      }>(
        "SELECT evidence_id,connection_id FROM evidence_sources WHERE source_key=?",
        [key],
      );
      if (source && source.connection_id !== input.connectionId)
        return fail("CONFLICT", "同一平台材料不能跨连接复用身份");
      const evidenceId = source?.evidence_id ?? deps.ids.next();
      if (!source)
        tx.run(
          "INSERT INTO evidence_sources(source_key,evidence_id,connection_id,locator_json) VALUES(?,?,?,?)",
          [
            key,
            evidenceId,
            input.connectionId,
            canonicalJson({
              ...value.source,
              agentId: value.agentId ?? value.source.agentId,
            }),
          ],
        );
      const latest = tx.get<{
        version: number;
        content_hash: string;
        availability: string;
      }>(
        "SELECT version,content_hash,availability FROM evidence_versions WHERE evidence_id=? ORDER BY version DESC LIMIT 1",
        [evidenceId],
      );
      const reuse =
        latest?.content_hash === contentHash &&
        latest.availability === "available";
      const version = reuse ? latest.version : (latest?.version ?? 0) + 1;
      if (!reuse)
        tx.run(
          "INSERT INTO evidence_versions(evidence_id,version,kind,observed_at,time_quality,retrieved_at,content_hash,fields_json) VALUES(?,?,?,?,?,?,?,?)",
          [
            evidenceId,
            version,
            value.kind,
            value.observedAt ?? null,
            value.timeQuality,
            value.retrievedAt,
            contentHash,
            canonicalJson(value.fields),
          ],
        );
      tx.run(
        "INSERT INTO evidence_retrievals(id,evidence_id,version,retrieved_at,query_id) VALUES(?,?,?,?,?)",
        [deps.ids.next(), evidenceId, version, value.retrievedAt, page.queryId],
      );
      tx.run(
        "INSERT OR IGNORE INTO query_evidence(query_id,evidence_id,evidence_version) VALUES(?,?,?)",
        [page.queryId, evidenceId, version],
      );
      if (input.runId)
        tx.run(
          "INSERT OR IGNORE INTO run_evidence(run_id,evidence_id,evidence_version,source) VALUES(?,?,?,?)",
          [input.runId, evidenceId, version, "tool"],
        );
      refs.push({ evidenceId, version });
    }
    const paginationOnly =
      page.status === "partial" &&
      !!page.nextCursor &&
      page.warnings.length === 0 &&
      page.coverage.reasons.every((reason) => reason === "more_pages");
    const coverage = {
      ...page.coverage,
      queryCompleteness:
        page.status === "ok" ? page.coverage.queryCompleteness : "partial",
      reasons: [
        ...page.coverage.reasons,
        ...page.warnings,
        ...(page.status === "ok" || paginationOnly
          ? []
          : [`page_status:${page.status}`]),
      ],
    };
    tx.run(
      "INSERT INTO query_pages(page_id,query_id,page_ordinal,content_hash,coverage_json,next_cursor_ref) VALUES(?,?,?,?,?,?)",
      [
        page.pageId,
        page.queryId,
        page.pageOrdinal,
        pageHash,
        canonicalJson(coverage),
        page.nextCursor ?? null,
      ],
    );
    tx.run("INSERT INTO case_query_page_refs(page_id,refs_json) VALUES(?,?)", [
      page.pageId,
      canonicalJson(uniqueRefs(refs)),
    ]);
    const pages = tx.all<{
      page_ordinal: number;
      coverage_json: string;
      next_cursor_ref: string | null;
    }>(
      "SELECT page_ordinal,coverage_json,next_cursor_ref FROM query_pages WHERE query_id=? ORDER BY page_ordinal",
      [page.queryId],
    );
    const parts = pages.map((row) => JSON.parse(row.coverage_json) as Coverage);
    const last = pages.at(-1)!;
    const reasons = [...new Set(parts.flatMap((part) => part.reasons))];
    const complete =
      pages.every(
        (p, i) =>
          p.page_ordinal === i &&
          (i === pages.length - 1 || !!p.next_cursor_ref),
      ) &&
      !last.next_cursor_ref &&
      parts.every((p, i) =>
        i === parts.length - 1
          ? p.queryCompleteness === "complete"
          : p.queryCompleteness !== "not_executed" &&
            p.reasons.every((r) => r === "more_pages"),
      );
    const combined: Coverage = {
      ...page.coverage,
      queryCompleteness: complete ? "complete" : "partial",
      collectionCoverage: parts.every((p) => p.collectionCoverage === "known")
        ? "known"
        : "unknown",
      reasons: complete
        ? reasons.filter((r) => r !== "more_pages")
        : [...new Set([...reasons, "页不连续、未完成或存在截断"])],
      returned: tx.get<{
        n: number;
      }>("SELECT COUNT(*) AS n FROM query_evidence WHERE query_id=?", [
        page.queryId,
      ])!.n,
    };
    tx.run("UPDATE query_runs SET coverage_json=?,status=? WHERE id=?", [
      canonicalJson(combined),
      complete ? "ok" : "partial",
      page.queryId,
    ]);
    if (record) {
      const revision = change(
        deps,
        tx,
        ctx,
        record,
        record.revision,
        "保存查询材料",
      );
      if (!revision.ok) return revision;
      for (const ref of uniqueRefs(refs))
        tx.run(
          "INSERT INTO evidence_links(case_id,evidence_id,evidence_version,attached_revision) VALUES(?,?,?,?) ON CONFLICT(case_id,evidence_id,evidence_version) DO UPDATE SET removed_revision=NULL,attached_revision=excluded.attached_revision",
          [record.id, ref.evidenceId, ref.version, revision.value],
        );
    }
    return ok(uniqueRefs(refs));
  };
}
