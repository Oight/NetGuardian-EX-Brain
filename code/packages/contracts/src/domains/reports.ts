/** Engineering contract 0.2.0; declarations preserved from the source snapshot. */
import type {
  BusinessContext,
  ContextRef,
  DeliveredRef,
  EvidenceRef,
  RunEvidenceView,
} from "./cases.js";
import type {
  AppError,
  CallContext,
  Id,
  Instant,
  PageRequest,
  ReadTx,
  Result,
  Scope,
  WriteTx,
} from "./common.js";
import type { InvestigationProfileInput, PreparedProfile } from "./host.js";
import type { AnalysisRun } from "./investigations.js";

export type StopReason =
  | "answered_with_limits"
  | "evidence_unavailable"
  | "budget_exhausted"
  | "user_cancelled"
  | "execution_failed"
  | "scope_expansion_needed";

export interface ReportStatement {
  text: string;
  evidenceRefs: DeliveredRef[];
  queryIds: Id[];
  contextRefs: ContextRef[];
}

export interface FollowupDraft {
  question: string;
  suggestedAction: string;
  responsibleRole?: string;
}

export interface ReportCandidate {
  caseId: Id;
  runId: Id;
  question: string;
  facts: ReportStatement[];
  analysis: ReportStatement[];
  conflicts: ReportStatement[];
  gaps: string[];
  classification: "needs_investigation" | "explained" | "insufficient_evidence";
  stopReason: StopReason;
  followups: FollowupDraft[];
}

export interface ReportRecord {
  id: Id;
  caseId: Id;
  runId: Id;
  version: number;
  baseRevision: number;
  candidate: ReportCandidate;
  validation: "valid" | "invalid" | "needs_review";
  review: "unreviewed" | "accepted" | "revised" | "rejected";
  validationIssues: string[];
  createdAt: Instant;
}

export interface FollowupRecord extends FollowupDraft {
  id: Id;
  caseId: Id;
  reportId?: Id;
  revision: number;
  state: "open" | "waiting" | "completed";
  dueAt?: Instant;
  note?: string;
  evidenceRefs: EvidenceRef[];
}

export interface ReviewInput {
  reportId: Id;
  expectedCaseRevision: number;
  disposition: "accepted" | "revised" | "rejected";
  humanConclusion: "confirmed_attack" | "confirmed_benign" | "unknown";
  note: string;
  revisedCandidate?: ReportCandidate;
}

export interface ResultPackage {
  schemaVersion: "0.1.0";
  requestId: Id;
  jobId: Id;
  caseId: Id;
  runId?: Id;
  resultVersion: number;
  terminalState: "succeeded" | "needs_review" | "failed" | "cancelled";
  review: ReportRecord["review"];
  summary: string;
  reportId?: Id;
  mainEvidence: ReportStatement[];
  gaps: string[];
  followups: FollowupDraft[];
  scope: Scope;
  error?: AppError;
}

export interface ResultContext {
  requestId: Id;
  jobId: Id;
  caseId: Id;
  runId?: Id;
  scope: Scope;
}

export interface CompletionDecision {
  terminalState: ResultPackage["terminalState"];
  reason: string;
  error?: AppError;
}

export interface ReportAssessment {
  reportId?: Id;
  validation: ReportRecord["validation"] | "missing";
}

export interface ReportValidationInput {
  view: RunEvidenceView;
  contexts: { ref: ContextRef; context: BusinessContext }[];
}

export interface ReportService {
  prepare(
    ctx: CallContext,
    input: InvestigationProfileInput,
  ): Promise<Result<PreparedProfile>>;
  proposeInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: {
      candidate: ReportCandidate;
      validationInput: ReportValidationInput;
    },
  ): Result<ReportRecord>;
  assessInTx(
    tx: WriteTx,
    ctx: CallContext,
    runId: Id,
  ): Result<ReportAssessment>;
  finalizeInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: {
      run: AnalysisRun;
      context: ResultContext;
      decision: CompletionDecision;
      manifestHash: string;
      assessment: ReportAssessment;
    },
  ): Result<ResultPackage>;
  terminalWithoutRunInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: {
      context: Omit<ResultContext, "runId">;
      decision: CompletionDecision;
    },
  ): Result<ResultPackage>;
  review(ctx: CallContext, input: ReviewInput): Promise<Result<ReportRecord>>;
  publishReviewedInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: {
      context: ResultContext;
      reportId: Id;
      expectedCaseRevision: number;
      expectedResultVersion: number;
    },
  ): Result<ResultPackage>;
  list(ctx: CallContext, caseId: Id): Promise<Result<ReportRecord[]>>;
  followups(ctx: CallContext, caseId: Id): Promise<Result<FollowupRecord[]>>;
  searchFollowups(
    ctx: CallContext,
    input: { caseId?: Id; state?: FollowupRecord["state"]; page: PageRequest },
  ): Promise<Result<{ items: FollowupRecord[]; nextCursor?: string }>>;
  putFollowup(
    ctx: CallContext,
    input: { item: FollowupRecord; expectedRevision: number },
  ): Promise<Result<FollowupRecord>>;
  export(
    ctx: CallContext,
    input: { caseId: Id; caseRevision: number; format: "markdown" | "json" },
  ): Promise<Result<{ filename: string; mediaType: string; text: string }>>;
}

export type InvestigationProfilePort = Pick<ReportService, "prepare">;

export type ReportProposalPort = Pick<ReportService, "proposeInTx">;

export type ReportCompletionPort = Pick<
  ReportService,
  | "assessInTx"
  | "finalizeInTx"
  | "terminalWithoutRunInTx"
  | "publishReviewedInTx"
>;

export interface ResultPackageReadPort {
  getInTx(
    tx: ReadTx,
    ctx: CallContext,
    input: { requestId: Id; resultVersion?: number },
  ): Result<ResultPackage>;
}
