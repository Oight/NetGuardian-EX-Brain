import type { CaseAtomicPort, CaseService } from '@campussec/contracts';
import { caseOperations } from './cases.js';
import { capture } from './queries.js';
import { projectionOperations } from './projections.js';
import { retentionOperations } from './retention.js';
import type { Dependencies } from './repositories.js';
/** S06 never constructs a scheduler, budget, gateway or report service. */
export function createCaseService(deps: Dependencies): {
    service: CaseService;
    atomic: CaseAtomicPort;
} {
    const cases = caseOperations(deps), projections = projectionOperations(deps);
    return { service: { ...cases.service, evidence: projections.evidence }, atomic: { ...cases.atomic, captureInTx: capture(deps), ...projections.atomic, ...retentionOperations(deps) } };
}
