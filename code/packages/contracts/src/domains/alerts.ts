/** Engineering contract 0.2.0; declarations preserved from the source snapshot. */
import type { CallContext, Id, Instant, PageRequest, Result, Scope } from "./common.js";
import type { EvidenceRef } from "./cases.js";
import type { AlertFilter } from "./platform.js";

export interface InboxAlert {
  id: Id; connectionId: Id; sourceKey: string; receiveSeq: number;
  kind: 'realtime' | 'history' | 'recovery'; evidence: EvidenceRef;
  agentId?: string; ruleId?: string; ruleGroups: string[]; level?: number;
  observedAt?: Instant; receivedAt: Instant; read: boolean; decisionReason: string;
}

export interface TriggerPolicy {
  id: Id; connectionId: Id; revision: number; epoch: number; enabled: boolean;
  agentIds: string[]; filter: AlertFilter; enabledAfterReceiveSeq: number;
  dailyAttemptLimit: number; timeZone: string;
  dailyTokenLimit?: number;
}

export interface AutoCandidate {
  id: Id; policyId: Id; policyEpoch: number; caseId: Id; alertIds: Id[];
  scope: Scope; question: string; firstReceivedAt: Instant; lastReceivedAt: Instant;
  coalesceUntil: Instant; expiresAt: Instant;
}

export interface AlertService {
  pollOnce(ctx: CallContext, connectionId: Id): Promise<Result<{ inserted: number; complete: boolean }>>;
  list(ctx: CallContext, input: { connectionId: Id; page: PageRequest; scope?: Scope; filter?: AlertFilter; read?: boolean }): Promise<Result<{ items: InboxAlert[]; nextCursor?: string }>>;
  markRead(ctx: CallContext, alertIds: Id[]): Promise<Result<void>>;
  setPolicy(ctx: CallContext, input: { expectedRevision: number; policy: TriggerPolicy }): Promise<Result<TriggerPolicy>>;
  flushCandidates(ctx: CallContext): Promise<Result<number>>;
}

export interface NotificationPort {
  show(input: { notificationId: Id; title: string; body: string; alertIds: Id[] }): Promise<Result<{ shown: boolean }>>;
}
