/** Engineering contract 0.2.0; declarations preserved from the source snapshot. */

export type Id = string;

export const ENGINEERING_CONTRACT_VERSION = "0.2.0" as const;

export const WIRE_SCHEMA_VERSION = "0.1.0" as const;

export type Instant = string;

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };

export type JsonObject = { [key: string]: Json };

export type ErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "REVISION_CONFLICT"
  | "NEEDS_INPUT"
  | "QUEUE_FULL"
  | "SCOPE_EXCEEDED"
  | "CAPABILITY_UNAVAILABLE"
  | "HOST_UNAVAILABLE"
  | "BUDGET_EXHAUSTED"
  | "EXPIRED"
  | "CANCELLED"
  | "UNCERTAIN"
  | "UPSTREAM_AUTH"
  | "UPSTREAM_DENIED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "TLS_UNTRUSTED"
  | "PARTIAL_RESULT"
  | "CURSOR_INVALID"
  | "RESULT_NOT_READY"
  | "VALIDATION_FAILED"
  | "SECRET_STORE_UNAVAILABLE"
  | "IDENTITY_CHANGED"
  | "STORAGE_UNAVAILABLE"
  | "INTERNAL";

export interface AppError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: JsonObject;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

export interface Actor {
  spaceId: Id;
  principalId: Id;
  identityEpoch: number;
  role: "ui" | "system" | "delegation" | "evidence";
  originBindingId?: Id;
  runId?: Id;
}

export interface CallContext {
  actor: Actor;
  traceId: Id;
}

export interface ClockPort {
  now(): Instant;
  monotonicMs(): number;
}

export interface IdPort {
  next(): Id;
}

export const DEFAULT_LIMITS = {
  activeInvestigations: 1,
  queueCapacity: 20,
  maxRunAgents: 5,
  maxRunWindowMs: 3600000,
  requestTtlMs: 900000,
  autoQueueTtlMs: 900000,
  runTtlMs: 300000,
  queryTimeoutMs: 10000,
  toolCalls: 12,
  readCalls: 10,
  platformAttempts: 20,
  distinctEvents: 300,
  toolTextBytes: 16384,
  platformConcurrency: 2,
  pageSize: 50,
  maxPages: 4,
  watchIntervalMs: 10000,
  watchOverlapMs: 30000,
  recoveryWindowMs: 1800000,
  coalesceMs: 10000,
  candidateMaxSpanMs: 1800000,
  candidateIdleMs: 600000,
  autoDailyAttempts: 10,
  questionChars: 2000,
  noteChars: 8000,
  idempotencyChars: 128,
} as const;

export interface PageRequest {
  cursor?: string;
  limit: number;
}

export interface Count {
  value: number;
  relation: "eq" | "gte";
}

export interface Scope {
  connectionId: Id;
  agentIds: string[];
  from: Instant;
  to: Instant;
  timeZone: string;
}

export interface Coverage {
  requestedScope: Scope;
  effectiveScope: Scope;
  queryCompleteness: "complete" | "partial" | "not_executed";
  collectionCoverage: "known" | "partial" | "unknown";
  sourceTypes: string[];
  reasons: string[];
  retrievedAt: Instant;
  observedFrom?: Instant;
  observedTo?: Instant;
  returned: number;
  total?: Count;
}

export type SqlValue = string | number | null | Uint8Array;

export interface ReadTx {
  get<T>(sql: string, parameters?: readonly SqlValue[]): T | undefined;
  all<T>(sql: string, parameters?: readonly SqlValue[]): T[];
}

export interface WriteTx extends ReadTx {
  run(sql: string, parameters?: readonly SqlValue[]): { changes: number };
}

export interface DatabasePort {
  read<T>(ctx: CallContext, work: (tx: ReadTx) => T): Promise<Result<T>>;
  write<T>(
    ctx: CallContext,
    work: (tx: WriteTx) => Result<T>,
  ): Promise<Result<T>>;
}

export interface SecretPort {
  put(input: {
    owner: Id;
    purpose: string;
    value: Uint8Array;
    persist: boolean;
  }): Promise<Result<Id>>;
  use<T>(
    ref: Id,
    purpose: string,
    work: (value: Uint8Array) => Promise<T>,
  ): Promise<Result<T>>;
  remove(ref: Id): Promise<Result<void>>;
}

export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  bodyText?: string;
  timeoutMs: number;
  signal: AbortSignal;
  caPem?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

export interface HttpPort {
  request(input: HttpRequest): Promise<Result<HttpResponse>>;
}
