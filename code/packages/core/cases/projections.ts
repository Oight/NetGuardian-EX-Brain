import { canonicalJson, fail, ok, parseDesktopInput, parseDto, type CaseAtomicPort, type CaseService, type EvidenceProjection, type EvidenceRef, type DeliveredRef, type JsonObject, type ReadTx, type CallContext, } from '@campussec/contracts';
import { contexts, getCase, getEvidence, hash, historical, linked, mutable, readResult, runView, uniqueRefs, within, change, type Dependencies } from './repositories.js';
import { queryViews } from './queries.js';
type ProjectionRow = {
    id: string;
    run_id: string;
    evidence_id: string;
    evidence_version: number;
    content_json: string;
    content_hash: string;
    state: EvidenceProjection['state'];
    prepared_at: string;
    released_at: string | null;
    availability: EvidenceProjection['availability'];
};
export function projection(row: ProjectionRow): EvidenceProjection {
    return { id: row.id, runId: row.run_id, ref: { evidenceId: row.evidence_id, version: row.evidence_version }, content: JSON.parse(row.content_json) as JsonObject, contentHash: row.content_hash, state: row.state, preparedAt: row.prepared_at, ...(row.released_at ? { releasedAt: row.released_at } : {}), availability: row.availability };
}
export const projections = (tx: ReadTx, runId: string) => tx.all<ProjectionRow>('SELECT * FROM evidence_projections WHERE run_id=? ORDER BY id', [runId]).map(projection);
export function projectionOperations(deps: Dependencies) {
    const evidence: CaseService['evidence'] = async (ctx, input) => {
        const parsed = parseDesktopInput('evidence.get', input);
        if (!parsed.ok)
            return parsed;
        return readResult(deps.db, ctx, tx => {
            const found = getCase(tx, ctx, input.caseId);
            if (!found.ok)
                return found;
            if (!linked(tx, input.caseId, input.ref) && !historical(tx, ctx, input.caseId, input.ref))
                return fail('FORBIDDEN', '材料不属于获准案件或历史轮次');
            if (ctx.actor.runId && !historical(tx, ctx, input.caseId, input.ref))
                return fail('FORBIDDEN', '材料不属于当前轮次');
            const item = getEvidence(tx, ctx, input.ref);
            if (!item.ok)
                return item;
            let delivered: EvidenceProjection | undefined;
            if (input.projectionId) {
                const row = tx.get<ProjectionRow>('SELECT p.* FROM evidence_projections p JOIN analysis_runs a ON a.id=p.run_id WHERE p.id=? AND a.case_id=? AND p.evidence_id=? AND p.evidence_version=?', [input.projectionId, input.caseId, input.ref.evidenceId, input.ref.version]);
                if (!row || (ctx.actor.runId && row.run_id !== ctx.actor.runId))
                    return fail('FORBIDDEN', '投影不属于获准轮次与材料版本');
                delivered = projection(row);
            }
            return ok({ evidence: item.value, ...(delivered ? { projection: delivered } : {}) });
        });
    };
    const initializeRunInTx: CaseAtomicPort['initializeRunInTx'] = (tx, ctx, input) => {
        const valid = parseDto('AnalysisRun', input.run);
        if (!valid.ok)
            return valid;
        input = { ...input, run: valid.value };
        const run = runView(tx, ctx, input.run.id);
        if (!run.ok)
            return run;
        if (run.value.caseId !== input.run.caseId || run.value.baseRevision !== input.run.baseRevision || canonicalJson(run.value.scope) !== canonicalJson(input.run.scope) || run.value.case.revision !== input.run.baseRevision)
            return fail('REVISION_CONFLICT', '冻结输入前案件或轮次已变化');
        const writable = mutable(tx, input.run.id);
        if (!writable.ok)
            return writable;
        if (!within(input.run.scope, run.value.case.scope))
            return fail('SCOPE_EXCEEDED', '轮次范围超出案件');
        const value = { question: input.question.trim(), scope: input.run.scope, seedRefs: uniqueRefs(input.seedRefs), contexts: contexts(tx, run.value.case).filter(c => c.verification !== 'rejected' && c.agentIds.some(id => input.run.scope.agentIds.includes(id)) && c.from < input.run.scope.to && c.to > input.run.scope.from), capabilities: input.capabilities };
        const parsed = parseDto('FrozenRunInput', value);
        if (!parsed.ok)
            return parsed;
        for (const ref of value.seedRefs) {
            if (!linked(tx, input.run.caseId, ref))
                return fail('FORBIDDEN', '种子不属于案件');
            const item = getEvidence(tx, ctx, ref);
            if (!item.ok)
                return item;
            if (item.value.availability !== 'available')
                return fail('EXPIRED', '种子正文已过期');
        }
        for (const ref of value.seedRefs)
            tx.run('INSERT OR IGNORE INTO run_evidence(run_id,evidence_id,evidence_version,source) VALUES(?,?,?,?)', [input.run.id, ref.evidenceId, ref.version, 'seed']);
        return ok(value);
    };
    const inspectRunInTx: CaseAtomicPort['inspectRunInTx'] = (tx, ctx, run) => {
        const found = runView(tx, ctx, run.id);
        if (!found.ok)
            return found;
        if (found.value.caseId !== run.caseId || canonicalJson(found.value.scope) !== canonicalJson(run.scope))
            return fail('FORBIDDEN', '轮次身份不匹配');
        return ok({ runId: run.id, caseId: run.caseId, scope: found.value.scope, projections: projections(tx, run.id), queries: queryViews(tx, run.caseId, run.id) });
    };
    const projectInTx: CaseAtomicPort['projectInTx'] = (tx, ctx, input) => {
        const found = runView(tx, ctx, input.runId);
        if (!found.ok)
            return found;
        const writable = mutable(tx, input.runId);
        if (!writable.ok)
            return writable;
        if (input.refs.length > 300 || !input.fieldNames.length || input.fieldNames.length > 100 || input.fieldNames.some(name => !name || /(?:password|secret|authorization|token|credential)/i.test(name)))
            return fail('INVALID_INPUT', '投影字段或数量无效');
        const result: EvidenceProjection[] = [];
        for (const ref of uniqueRefs(input.refs)) {
            if (!tx.get('SELECT run_id FROM run_evidence WHERE run_id=? AND evidence_id=? AND evidence_version=?', [input.runId, ref.evidenceId, ref.version]))
                return fail('FORBIDDEN', '材料不属于当前轮次');
            const evidence = getEvidence(tx, ctx, ref);
            if (!evidence.ok)
                return evidence;
            if (evidence.value.availability !== 'available')
                return fail('EXPIRED', '材料正文已过期');
            const content = Object.fromEntries(input.fieldNames.filter(name => Object.hasOwn(evidence.value.fields, name)).map(name => [name, evidence.value.fields[name]!])) as JsonObject;
            const contentHash = hash(content);
            const old = tx.get<ProjectionRow>('SELECT * FROM evidence_projections WHERE run_id=? AND evidence_id=? AND evidence_version=? AND content_hash=? AND availability=? ORDER BY id LIMIT 1', [input.runId, ref.evidenceId, ref.version, contentHash, 'available']);
            if (old) {
                result.push(projection(old));
                continue;
            }
            const value: EvidenceProjection = { id: deps.ids.next(), runId: input.runId, ref, content, contentHash, state: 'prepared', preparedAt: deps.clock.now(), availability: 'available' };
            tx.run('INSERT INTO evidence_projections(id,run_id,evidence_id,evidence_version,content_json,content_hash,state,prepared_at) VALUES(?,?,?,?,?,?,?,?)', [value.id, input.runId, ref.evidenceId, ref.version, canonicalJson(content), contentHash, 'prepared', value.preparedAt]);
            result.push(value);
        }
        return ok(result);
    };
    const releaseInTx: CaseAtomicPort['releaseInTx'] = (tx, ctx, input) => {
        const found = runView(tx, ctx, input.runId);
        if (!found.ok)
            return found;
        const writable = mutable(tx, input.runId);
        if (!writable.ok)
            return writable;
        if (!['released', 'uncertain'].includes(input.outcome) || input.projectionIds.length > 1000)
            return fail('INVALID_INPUT', '释放状态无效');
        for (const id of new Set(input.projectionIds)) {
            const row = tx.get<ProjectionRow>('SELECT * FROM evidence_projections WHERE id=? AND run_id=?', [id, input.runId]);
            if (!row)
                return fail('FORBIDDEN', '投影不属于当前轮次');
            if (row.availability !== 'available')
                return fail('EXPIRED', '投影已过期');
            if (row.state === 'released' && input.outcome === 'uncertain')
                return fail('CONFLICT', '已确认释放的投影不能降级');
            if (row.state !== input.outcome)
                tx.run('UPDATE evidence_projections SET state=?,released_at=? WHERE id=?', [input.outcome, deps.clock.now(), id]);
        }
        return ok(undefined);
    };
    const sealInTx: CaseAtomicPort['sealInTx'] = (tx, ctx, input) => {
        const found = runView(tx, ctx, input.runId);
        if (!found.ok)
            return found;
        const valid = parseDto('RunManifestMetadata', input.metadata);
        if (!valid.ok)
            return valid;
        input = { ...input, metadata: valid.value };
        if (canonicalJson(input.metadata.initialInput.scope) !== canonicalJson(found.value.scope))
            return fail('SCOPE_EXCEEDED', '封存范围与轮次不一致');
        const metadataHash = hash(input.metadata);
        const old = tx.get<{
            metadata_hash: string;
            manifest_hash: string;
            refs_json: string;
        }>('SELECT metadata_hash,manifest_hash,refs_json FROM case_run_manifests WHERE run_id=?', [input.runId]);
        if (old)
            return old.metadata_hash === metadataHash ? ok({ manifestHash: old.manifest_hash, refs: JSON.parse(old.refs_json) as DeliveredRef[] }) : fail('CONFLICT', '轮次已按不同内容封存');
        const views = projections(tx, input.runId);
        const refs = views.filter(p => p.state === 'released').map(p => ({ ...p.ref, projectionId: p.id }));
        const evidence = tx.all<{
            evidence_id: string;
            evidence_version: number;
            content_hash: string;
        }>('SELECT r.evidence_id,r.evidence_version,v.content_hash FROM run_evidence r JOIN evidence_versions v ON v.evidence_id=r.evidence_id AND v.version=r.evidence_version WHERE r.run_id=? ORDER BY r.evidence_id,r.evidence_version', [input.runId]);
        // A manifest retains identities and hashes, never an extra copy of expirable projection bodies.
        const manifest = { runId: input.runId, caseId: found.value.caseId, metadata: input.metadata, evidence, projections: views.map(({ content: _content, ...summary }) => summary), queries: queryViews(tx, found.value.caseId, input.runId) };
        const manifestHash = hash(manifest);
        tx.run('INSERT INTO case_run_manifests(run_id,case_id,metadata_hash,manifest_hash,manifest_json,refs_json,created_at) VALUES(?,?,?,?,?,?,?)', [input.runId, found.value.caseId, metadataHash, manifestHash, canonicalJson(manifest), canonicalJson(refs), deps.clock.now()]);
        tx.run('UPDATE query_runs SET sealed=1 WHERE run_id=?', [input.runId]);
        return ok({ manifestHash, refs });
    };
    const applyRunInTx: CaseAtomicPort['applyRunInTx'] = (tx, ctx, input) => {
        const found = runView(tx, ctx, input.run.id);
        if (!found.ok)
            return found;
        if (found.value.caseId !== input.run.caseId || found.value.baseRevision !== input.run.baseRevision)
            return fail('FORBIDDEN', '轮次身份不一致');
        if (!tx.get('SELECT run_id FROM case_run_manifests WHERE run_id=?', [input.run.id]))
            return fail('CONFLICT', '轮次尚未封存');
        if (!tx.get('SELECT id FROM report_drafts WHERE id=? AND run_id=? AND case_id=?', [input.reportId, input.run.id, input.run.caseId]))
            return fail('FORBIDDEN', '报告不属于本轮案件');
        const record = found.value.case;
        if (record.currentReportId === input.reportId)
            return ok({ applied: true, revision: record.revision });
        if (record.revision !== input.run.baseRevision) {
            tx.run('UPDATE cases SET latest_report_id=? WHERE id=?', [input.reportId, record.id]);
            deps.events.appendInTx(tx, ctx, { type: 'case.changed', aggregateId: record.id, revision: record.revision, payload: { caseId: record.id, revision: record.revision, reason: '保留旧输入的历史候选' } });
            return ok({ applied: false, revision: record.revision });
        }
        const changed = change(deps, tx, ctx, record, record.revision, '附入本轮材料与报告');
        if (!changed.ok)
            return changed;
        for (const row of tx.all<{
            evidence_id: string;
            evidence_version: number;
        }>('SELECT evidence_id,evidence_version FROM run_evidence WHERE run_id=?', [input.run.id]))
            tx.run('INSERT INTO evidence_links(case_id,evidence_id,evidence_version,attached_revision) VALUES(?,?,?,?) ON CONFLICT(case_id,evidence_id,evidence_version) DO UPDATE SET attached_revision=excluded.attached_revision,removed_revision=NULL', [record.id, row.evidence_id, row.evidence_version, changed.value]);
        tx.run('UPDATE cases SET current_report_id=?,latest_report_id=? WHERE id=?', [input.reportId, input.reportId, record.id]);
        return ok({ applied: true, revision: changed.value });
    };
    return { evidence, atomic: { initializeRunInTx, inspectRunInTx, projectInTx, releaseInTx, sealInTx, applyRunInTx } };
}
