/** Engineering contract 0.2.0; declarations preserved from the source snapshot. */
import type { AppError, CallContext, Id, Instant, Result } from "./common.js";
import type {
  ContextRef,
  EvidenceProjection,
  FrozenRunInput,
} from "./cases.js";
import type { AnalysisRun } from "./investigations.js";

export interface HostCapability {
  name:
    | "signedApi"
    | "dedicatedProfile"
    | "isolatedEvidenceChannel"
    | "trustedOrigin"
    | "asyncDelivery"
    | "deliveryReconcile";
  state: "available" | "unavailable" | "unverified";
  version: string;
  checkedAt: Instant;
  evidence: string;
}

export interface OriginBinding {
  id: Id;
  spaceId: Id;
  principalId: Id;
  hostId: Id;
  hostAccountId: Id;
  workspaceId: Id;
  sessionId: string;
  requestMessageId: string;
  state: "active" | "revoked" | "expired";
  createdAt: Instant;
  expiresAt: Instant;
}

export interface ChannelHandle {
  id: Id;
  runId: Id;
  transport: "streamable-http" | "stdio";
  endpoint?: string;
  secretRef: Id;
  expiresAt: Instant;
  state: "pending" | "active" | "revoked";
}

export interface PreparedProfile {
  version: string;
  systemText: string;
  userText: string;
  allowedTools: string[];
  seedProjectionIds: Id[];
  contextRefs: ContextRef[];
}

export interface InvestigationProfileInput {
  run: AnalysisRun;
  initialInput: FrozenRunInput;
  seedProjections: EvidenceProjection[];
}

export interface ExecutionSnapshot {
  runId: Id;
  sessionId?: string;
  userMessageId?: string;
  resultMessageId?: string;
  phase:
    | "not_submitted"
    | "submitted"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "uncertain";
  verification: "verified" | "unverified";
  observedAt: Instant;
  finishReason?: string;
  error?: AppError;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    estimated: boolean;
    costKnown: boolean;
  };
}

export interface HostReceipt {
  messageId: string;
  visible: boolean;
  observedAt: Instant;
}

export interface HostMessage {
  kind: "external_investigation_result";
  mediaType: "application/json";
  text: string;
}

export interface HostCapabilitiesPort {
  capabilities(ctx: CallContext): Promise<Result<HostCapability[]>>;
}

export interface TrustedOriginPort {
  resolveOrigin(
    ctx: CallContext,
    trustedTransportBindingId: Id,
  ): Promise<Result<OriginBinding>>;
}

export interface HostDeliveryPort {
  binding(ctx: CallContext, bindingId: Id): Promise<Result<OriginBinding>>;
  deliver(
    ctx: CallContext,
    input: {
      binding: OriginBinding;
      deliveryKey: string;
      message: HostMessage;
    },
  ): Promise<Result<HostReceipt>>;
  reconcileDelivery(
    ctx: CallContext,
    input: { binding: OriginBinding; deliveryKey: string },
  ): Promise<
    Result<{ state: "found" | "absent" | "unknown"; receipt?: HostReceipt }>
  >;
}

export interface HostAccessPort
  extends HostCapabilitiesPort, TrustedOriginPort, HostDeliveryPort {}

export interface ExecutionPort {
  start(
    ctx: CallContext,
    input: {
      run: AnalysisRun;
      profile: PreparedProfile;
      channel: ChannelHandle;
    },
  ): Promise<Result<ExecutionSnapshot>>;
  inspect(ctx: CallContext, runId: Id): Promise<Result<ExecutionSnapshot>>;
  abort(ctx: CallContext, runId: Id): Promise<Result<ExecutionSnapshot>>;
}
