/** Engineering contract 0.2.0; declarations preserved from the source snapshot. */
import type {
  CallContext,
  Coverage,
  Id,
  Instant,
  JsonObject,
  PageRequest,
  ReadTx,
  Result,
  Scope,
  WriteTx,
} from "./common.js";
import type {
  Capability,
  PlatformPage,
  PlatformQuery,
  SourceLocator,
  SourceRecord,
} from "./platform.js";
import type { InvestigationStepInput } from "./mcp.js";
import type { StopReason } from "./reports.js";
import type { AnalysisRun } from "./investigations.js";

export interface EvidenceRef {
  evidenceId: Id;
  version: number;
}

export interface ContextRef {
  contextId: Id;
  version: number;
}

export interface DeliveredRef extends EvidenceRef {
  projectionId: Id;
}

export interface EvidenceRecord {
  id: Id;
  spaceId: Id;
  connectionId: Id;
  version: number;
  source: SourceLocator;
  kind: SourceRecord["kind"] | "human_context";
  observedAt?: Instant;
  timeQuality: SourceRecord["timeQuality"];
  retrievedAt: Instant;
  contentHash: string;
  fields: JsonObject;
  availability: "available" | "expired";
}

export interface EvidenceProjection {
  id: Id;
  runId: Id;
  ref: EvidenceRef;
  content: JsonObject;
  contentHash: string;
  state: "prepared" | "released" | "uncertain";
  preparedAt: Instant;
  releasedAt?: Instant;
  availability: "available" | "expired";
}

export interface CaseRecord {
  id: Id;
  spaceId: Id;
  revision: number;
  title: string;
  scope: Scope;
  status: "pending" | "investigating" | "resolved" | "reopened";
  currentReportId?: Id;
  latestReportId?: Id;
  createdAt: Instant;
  updatedAt: Instant;
}

export interface BusinessContext {
  id: Id;
  caseId?: Id;
  connectionId: Id;
  agentIds: string[];
  version: number;
  text: string;
  department?: string;
  purpose?: string;
  from: Instant;
  to: Instant;
  sourceLabel: string;
  verification: "unverified" | "verified" | "rejected";
  authorId: Id;
}

export interface CaseSnapshot {
  case: CaseRecord;
  evidence: EvidenceRecord[];
  contexts: BusinessContext[];
  queries: { queryId: Id; coverage: Coverage }[];
  nextEvidenceCursor?: string;
}

export interface QueryCapture {
  runId?: Id;
  caseId?: Id;
  connectionId: Id;
  query: PlatformQuery;
  page: PlatformPage;
}

export interface CleanupPlan {
  id: Id;
  planHash: string;
  expiresAt: Instant;
  caseIds: Id[];
  caseRevisions: { caseId: Id; revision: number }[];
  removableVersions: number;
  blockedVersions: number;
  approximateBytes: number;
}

export interface CaseService {
  list(
    ctx: CallContext,
    input: {
      connectionId?: Id;
      text?: string;
      status?: CaseRecord["status"];
      page: PageRequest;
    },
  ): Promise<Result<{ items: CaseRecord[]; nextCursor?: string }>>;
  create(
    ctx: CallContext,
    input: { title: string; scope: Scope; seedRefs: EvidenceRef[] },
  ): Promise<Result<CaseRecord>>;
  snapshot(
    ctx: CallContext,
    input: { caseId: Id; evidencePage: PageRequest },
  ): Promise<Result<CaseSnapshot>>;
  evidence(
    ctx: CallContext,
    input: { caseId: Id; ref: EvidenceRef; projectionId?: Id },
  ): Promise<
    Result<{ evidence: EvidenceRecord; projection?: EvidenceProjection }>
  >;
  setStatus(
    ctx: CallContext,
    input: {
      caseId: Id;
      expectedRevision: number;
      status: CaseRecord["status"];
      reason: string;
    },
  ): Promise<Result<CaseRecord>>;
  moveEvidence(
    ctx: CallContext,
    input: {
      sourceCaseId: Id;
      targetCaseId: Id;
      sourceRevision: number;
      targetRevision: number;
      refs: EvidenceRef[];
      reason: string;
    },
  ): Promise<Result<{ sourceRevision: number; targetRevision: number }>>;
  putContext(
    ctx: CallContext,
    input: {
      caseId: Id;
      contextId?: Id;
      expectedRevision: number;
      context: Omit<BusinessContext, "id" | "version" | "authorId">;
    },
  ): Promise<Result<BusinessContext>>;
}

export type CaseReadPort = Pick<CaseService, "snapshot" | "evidence">;

export interface FrozenRunInput {
  question: string;
  scope: Scope;
  seedRefs: EvidenceRef[];
  contexts: BusinessContext[];
  capabilities: Capability[];
}

export interface RunEvidenceView {
  runId: Id;
  caseId: Id;
  scope: Scope;
  projections: EvidenceProjection[];
  queries: { queryId: Id; coverage: Coverage }[];
}

export interface RunManifestMetadata {
  initialInput: FrozenRunInput;
  profileVersion: string;
  mappingVersion: string;
  steps: { id: Id; input: InvestigationStepInput }[];
  stopReason?: StopReason;
}

export interface CaseAtomicPort {
  getInTx(tx: ReadTx, ctx: CallContext, caseId: Id): Result<CaseRecord>;
  snapshotInTx(
    tx: ReadTx,
    ctx: CallContext,
    input: { caseId: Id; evidencePage: PageRequest },
  ): Result<CaseSnapshot>;
  recordChangeInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { caseId: Id; expectedRevision: number; reason: string },
  ): Result<number>;
  createInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { title: string; scope: Scope; seedRefs: EvidenceRef[] },
  ): Result<CaseRecord>;
  setStatusInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: {
      caseId: Id;
      expectedRevision: number;
      status: CaseRecord["status"];
      reason: string;
    },
  ): Result<CaseRecord>;
  captureInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: QueryCapture,
  ): Result<EvidenceRef[]>;
  initializeRunInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: {
      run: AnalysisRun;
      seedRefs: EvidenceRef[];
      question: string;
      capabilities: Capability[];
    },
  ): Result<FrozenRunInput>;
  inspectRunInTx(
    tx: ReadTx,
    ctx: CallContext,
    run: AnalysisRun,
  ): Result<RunEvidenceView>;
  attachInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: {
      caseId: Id;
      refs: EvidenceRef[];
      expectedRevision: number;
      reason: string;
    },
  ): Result<number>;
  projectInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { runId: Id; refs: EvidenceRef[]; fieldNames: string[] },
  ): Result<EvidenceProjection[]>;
  releaseInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: {
      runId: Id;
      projectionIds: Id[];
      outcome: "released" | "uncertain";
    },
  ): Result<void>;
  sealInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { runId: Id; metadata: RunManifestMetadata },
  ): Result<{ manifestHash: string; refs: DeliveredRef[] }>;
  applyRunInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { run: AnalysisRun; reportId: Id },
  ): Result<{ applied: boolean; revision: number }>;
  previewCleanupInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { caseIds: Id[]; olderThan: Instant; protectedRunIds: Id[] },
  ): Result<CleanupPlan>;
  applyCleanupInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { planId: Id; expectedPlanHash: string; protectedRunIds: Id[] },
  ): Result<{ expiredVersions: number; projectionIds: Id[] }>;
}
