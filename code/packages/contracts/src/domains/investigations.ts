/** Engineering contract 0.2.0; declarations preserved from the source snapshot. */
import type {
  AppError,
  CallContext,
  Id,
  Instant,
  Result,
  Scope,
  WriteTx,
} from "./common.js";
import type { CleanupPlan, EvidenceRef } from "./cases.js";
import type { DeliveryState } from "./delivery.js";
import type { ReportRecord, ResultPackage } from "./reports.js";
import type { AutoCandidate } from "./alerts.js";

export type Origin = "alert_auto" | "client_user" | "teleagent_user";

export type RequestState =
  | "awaiting_scope"
  | "accepted"
  | "rejected"
  | "withdrawn";

export type JobState =
  | "coalescing"
  | "queued"
  | "preparing"
  | "submitting"
  | "running"
  | "verifying"
  | "succeeded"
  | "needs_review"
  | "failed"
  | "cancel_requested"
  | "cancelled"
  | "uncertain";

export interface CreateRequest {
  origin: Origin;
  connectionId: Id;
  question: string;
  requestedScope?: Scope;
  seedRefs: EvidenceRef[];
  caseId?: Id;
  idempotencyKey: string;
  originBindingId?: Id;
  autoCandidateId?: Id;
}

export interface InvestigationRequest {
  id: Id;
  origin: Origin;
  state: RequestState;
  connectionId: Id;
  question: string;
  requestedScope?: Scope;
  effectiveScope?: Scope;
  seedRefs: EvidenceRef[];
  caseId?: Id;
  jobId?: Id;
  originBindingId?: Id;
  autoCandidateId?: Id;
  missingFields: string[];
  createdAt: Instant;
  expiresAt: Instant;
}

export interface AnalysisRun {
  id: Id;
  jobId: Id;
  caseId: Id;
  baseRevision: number;
  scope: Scope;
  connectionGeneration: number;
  identityEpoch: number;
  profileVersion: string;
  toolEpoch: number;
  expiresAt: Instant;
  manifestHash?: string;
}

export interface JobRecord {
  id: Id;
  requestId: Id;
  caseId: Id;
  runId?: Id;
  origin: Origin;
  state: JobState;
  revision: number;
  createdAt: Instant;
  updatedAt: Instant;
  expiresAt: Instant;
  recoveryHold: boolean;
  policyId?: Id;
  policyEpoch?: number;
  error?: AppError;
}

export interface BudgetReservation {
  id: Id;
  runId: Id;
  toolName: string;
  toolOrdinal: number;
  expiresAt: Instant;
  toolEpoch: number;
  identityEpoch: number;
  connectionGeneration: number;
}

export interface BudgetState {
  runId: Id;
  toolsUsed: number;
  readsUsed: number;
  platformAttempts: number;
  distinctEvents: number;
  deadline: Instant;
  closed: boolean;
}

export interface RequestStatus {
  request: InvestigationRequest;
  job?: JobRecord;
  budget?: BudgetState;
  deliveryState?: DeliveryState;
  subscriptionCancelled?: boolean;
}

export interface RunSnapshot {
  run: AnalysisRun;
  job: JobRecord;
  steps: {
    id: Id;
    phase: string;
    summary: string;
    purpose?: string;
    createdAt: Instant;
  }[];
  report?: ReportRecord;
  budget: BudgetState;
}

export interface RequestService {
  create(
    ctx: CallContext,
    input: CreateRequest,
  ): Promise<Result<RequestStatus>>;
  provideInput(
    ctx: CallContext,
    input: {
      requestId: Id;
      scope?: Scope;
      text?: string;
      idempotencyKey: string;
    },
  ): Promise<Result<RequestStatus>>;
  status(ctx: CallContext, requestId: Id): Promise<Result<RequestStatus>>;
  runSnapshot(ctx: CallContext, runId: Id): Promise<Result<RunSnapshot>>;
  cancel(
    ctx: CallContext,
    input: { requestId: Id; reason: string },
  ): Promise<Result<RequestStatus>>;
  resume(
    ctx: CallContext,
    input: { requestId: Id; expectedJobRevision: number },
  ): Promise<Result<RequestStatus>>;
  abandon(
    ctx: CallContext,
    input: { requestId: Id; expectedJobRevision: number; reason: string },
  ): Promise<Result<RequestStatus>>;
  reconcile(
    ctx: CallContext,
    input: { requestId: Id; expectedJobRevision: number },
  ): Promise<Result<RequestStatus>>;
  tick(ctx: CallContext): Promise<Result<{ startedJobId?: Id }>>;
}

export interface RequestAtomicPort {
  createAutoInTx(
    tx: WriteTx,
    ctx: CallContext,
    candidate: AutoCandidate,
  ): Result<RequestStatus>;
  cancelPolicyInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { policyId: Id; obsoleteEpoch: number },
  ): Result<{ revokeRunIds: Id[] }>;
}

export type RequestCommandPort = Pick<
  RequestService,
  "create" | "provideInput" | "cancel"
>;

export type RequestReadPort = Pick<RequestService, "status">;

export interface RunBudgetPort {
  assertRunOpen(ctx: CallContext, runId: Id): Promise<Result<AnalysisRun>>;
  reservePlatformAttempt(
    ctx: CallContext,
    reservationId: Id,
  ): Promise<Result<void>>;
}

export interface RunBudgetAtomicPort {
  reserveToolInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { runId: Id; toolName: string; isRead: boolean },
  ): Result<BudgetReservation>;
  assertRunOpenInTx(
    tx: WriteTx,
    ctx: CallContext,
    runId: Id,
  ): Result<AnalysisRun>;
  recordEventsInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { runId: Id; sourceKeys: string[] },
  ): Result<void>;
}

export interface RetentionService {
  preview(
    ctx: CallContext,
    input: { caseIds: Id[]; olderThan: Instant },
  ): Promise<Result<CleanupPlan>>;
  apply(
    ctx: CallContext,
    input: { planId: Id; expectedPlanHash: string },
  ): Promise<Result<{ expiredVersions: number }>>;
}

export interface ReviewPublicationPort {
  publishReview(
    ctx: CallContext,
    input: {
      requestId: Id;
      reportId: Id;
      expectedCaseRevision: number;
      expectedResultVersion: number;
    },
  ): Promise<Result<ResultPackage>>;
}
