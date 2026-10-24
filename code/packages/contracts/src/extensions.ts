/** Additive maintenance contract. v4.2 / 0.2.0 / wire 0.1.0 remain the baseline. */
import type {
 AnalysisRun, CallContext, DeliveryRecord, EvidenceProjection, FrozenRunInput,
 Id, InvestigationRequest, JobRecord, PageRequest, PreparedProfile, ReadTx,
 Result, ResultContext, RunEvidenceView, TriggerPolicy,
} from './types.js';

export const MAINTENANCE_CONTRACT_REVISION = '2026-10-24' as const;
export type PolicySnapshot = { configured: false } | { configured: true; policy: TriggerPolicy };
export interface AlertPolicyReadPort {
  getPolicy(ctx: CallContext, connectionId: Id): Promise<Result<PolicySnapshot>>;
}
export interface DeliveryRecoveryInput {
  deliveryId: Id;
  expectedState: 'blocked' | 'uncertain' | 'retryable_failed';
  expectedAttempts: number;
  reason: string;
}
export interface DeliveryRecoveryPort {
  recover(ctx: CallContext, input: DeliveryRecoveryInput): Promise<Result<DeliveryRecord>>;
}
export interface DeliveryRetrySafetyPort {
  // true requires a trusted adapter guarantee, never a user assertion or mere search miss.
  canRetryAbsent(ctx: CallContext, input: { bindingId: Id; deliveryKey: string }): Promise<Result<boolean>>;
}
export interface InvestigationHistoryItem {
  request: InvestigationRequest;
  job?: JobRecord;
  run?: AnalysisRun;
}
export interface InvestigationHistorySnapshot {
  run: AnalysisRun;
  job: JobRecord;
  initialInput: FrozenRunInput;
  preparedProfile?: PreparedProfile;
  projections: EvidenceProjection[];
  queries: RunEvidenceView['queries'];
  nextCursor?: string;
}
export interface InvestigationHistoryInput { caseId: Id; page: PageRequest; }
export interface InvestigationHistorySnapshotInput { runId: Id; page: PageRequest; }
export interface InvestigationHistoryPort {
  list(ctx: CallContext, input: { caseId: Id; page: PageRequest }): Promise<Result<{ items: InvestigationHistoryItem[]; nextCursor?: string }>>;
  snapshot(ctx: CallContext, input: { runId: Id; page: PageRequest }): Promise<Result<InvestigationHistorySnapshot>>;
}
export interface ReportAnchorReadPort {
  runInTx(tx: ReadTx, ctx: CallContext, runId: Id): Result<{ run: AnalysisRun; question: string }>;
  contextInTx(tx: ReadTx, ctx: CallContext, context: ResultContext): Result<{ hasRun: boolean }>;
}
export interface MaintenanceDesktopMethodMap {
  'alerts.getPolicy': { input: { connectionId: Id }; output: PolicySnapshot };
  'deliveries.recover': { input: DeliveryRecoveryInput; output: DeliveryRecord };
  'investigations.history': { input: { caseId: Id; page: PageRequest }; output: { items: InvestigationHistoryItem[]; nextCursor?: string } };
  'investigations.input': { input: { runId: Id; page: PageRequest }; output: InvestigationHistorySnapshot };
}

// Additive methods are separate from the frozen 0.2.0 declaration snapshot.
declare module './domains/desktop.js' {
  interface DesktopMethodMap extends MaintenanceDesktopMethodMap {}
}
