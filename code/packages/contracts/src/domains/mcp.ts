/** Engineering contract 0.2.0; declarations preserved from the source snapshot. */
import type { CallContext, Coverage, Id, JsonObject, Result, Scope, WriteTx } from "./common.js";
import type { Capability, PlatformPage } from "./platform.js";
import type { BusinessContext, ContextRef, DeliveredRef } from "./cases.js";
import type { AnalysisRun, BudgetState } from "./investigations.js";
import type { ChannelHandle } from "./host.js";

export interface ToolInvocation {
  transportBindingId: Id; callId: string; toolName: string; arguments: JsonObject;
}

export interface ToolReply {
  isError: boolean; text: string; structured?: JsonObject;
  preparedProjectionIds: Id[];
}

export interface EvidenceToolEnvelope {
  schemaVersion: '0.1.0';
  status: PlatformPage['status']; queryId?: Id;
  records: { ref: DeliveredRef; content: JsonObject }[];
  coverage?: Coverage; nextCursor?: string; budget: BudgetState; warnings: string[];
  context?: {
    question: string; scope: Scope; capabilities: Capability[];
    backgrounds: { ref: ContextRef; context: BusinessContext }[];
  };
}

export interface ControlToolEnvelope {
  schemaVersion: '0.1.0'; status: 'ok' | 'needs_input' | 'failed';
  data: JsonObject; budget?: BudgetState; warnings: string[];
}

export interface InvestigationStepInput {
  phase: 'orientation' | 'querying' | 'evaluating' | 'stopped';
  summary: string; purpose?: string; evidenceRefs: DeliveredRef[];
}

export interface McpGatewayPort {
  start(ctx: CallContext): Promise<Result<{ endpoint?: string }>>;
  stop(ctx: CallContext): Promise<Result<void>>;
  invoke(ctx: CallContext, input: ToolInvocation): Promise<Result<ToolReply>>;
}

export interface EvidenceChannelPort {
  openChannel(ctx: CallContext, run: AnalysisRun): Promise<Result<ChannelHandle>>;
  bindChannel(ctx: CallContext, input: { channelId: Id; runId: Id; trustedSessionBindingId: Id }): Promise<Result<ChannelHandle>>;
  revoke(ctx: CallContext, runId: Id): Promise<Result<void>>;
  revokeAll(ctx: CallContext): Promise<Result<void>>;
}

export type EvidenceChannelBindingPort = Pick<EvidenceChannelPort, 'bindChannel'>;

export type EvidenceChannelControlPort = Pick<EvidenceChannelPort, 'openChannel' | 'revoke'>;

export interface InvestigationToolPort {
  invoke(ctx: CallContext, input: ToolInvocation): Promise<Result<ToolReply>>;
  acknowledgeReply(ctx: CallContext, input: { transportBindingId: Id; callId: string; outcome: 'released' | 'uncertain' }): Promise<Result<void>>;
}

export interface ToolReplyAtomicPort {
  expireRepliesInTx(tx: WriteTx, ctx: CallContext, input: { projectionIds: Id[] }): Result<void>;
}
