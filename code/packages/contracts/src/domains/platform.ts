/** Engineering contract 0.2.0; declarations preserved from the source snapshot. */
import type {
  CallContext,
  Count,
  Coverage,
  Id,
  Instant,
  JsonObject,
  PageRequest,
  Result,
  Scope,
} from "./common.js";

export interface ConnectionProfile {
  id: Id;
  spaceId: Id;
  platformInstanceId: Id;
  displayName: string;
  generation: number;
  indexerBaseUrl?: string;
  serverBaseUrl?: string;
  indexerSecretRef?: Id;
  serverSecretRef?: Id;
  caRef?: Id;
  alertsPattern: string;
  archivesPattern?: string;
  mappingVersion: string;
  principalFingerprint: string;
  updatedAt: Instant;
}

export type CapabilityName =
  | "alerts"
  | "archives"
  | "authentication_events"
  | "agents"
  | "inventory_os"
  | "inventory_hardware"
  | "inventory_packages"
  | "inventory_processes"
  | "inventory_ports"
  | "fim_objects"
  | "fim_events"
  | "sca"
  | "vulnerabilities"
  | "stable_alert_pagination";

export interface Capability {
  name: CapabilityName;
  state: "available" | "denied" | "unreachable" | "unsupported" | "unverified";
  checkedAt: Instant;
  evidence: string;
  endpointKind: "indexer" | "server";
}

export interface AgentSummary {
  id: string;
  name?: string;
  status?: string;
  version?: string;
}

export interface DeviceDetailInput {
  connectionId: Id;
  agentId: string;
  category:
    | "os"
    | "hardware"
    | "packages"
    | "processes"
    | "ports"
    | "fim_objects"
    | "sca";
  page: PageRequest;
}

export interface DeviceDetail {
  agentId: string;
  category: DeviceDetailInput["category"];
  items: SourceRecord[];
  nextCursor?: string;
  total?: Count;
  retrievedAt: Instant;
  status: "ok" | "partial" | "denied" | "unavailable" | "failed";
  warnings: string[];
}

export interface AlertFilter {
  ruleIds?: string[];
  ruleGroups?: string[];
  minLevel?: number;
}

export type PlatformQuery =
  | {
      kind: "alerts";
      scope: Scope;
      filter: AlertFilter;
      page: PageRequest;
      fixedUpper: Instant;
    }
  | {
      kind: "authentication";
      scope: Scope;
      outcome: "success" | "failure" | "any";
      account?: { namespace: string; name: string };
      sourceIp?: string;
      page: PageRequest;
    }
  | {
      kind: "inventory";
      scope: Scope;
      category: "os" | "hardware" | "packages" | "processes" | "ports";
      page: PageRequest;
    }
  | {
      kind: "file_changes";
      scope: Scope;
      pathEquals?: string;
      page: PageRequest;
    }
  | {
      kind: "findings";
      scope: Scope;
      category: "sca" | "vulnerabilities";
      page: PageRequest;
    };

export interface SourceLocator {
  platformInstanceId: Id;
  kind: "index_document" | "resource";
  index?: string;
  documentId?: string;
  resource?: string;
  agentId?: string;
  collectionIdentity?: string;
}

export interface SourceRecord {
  source: SourceLocator;
  kind: "alert" | "authentication" | "inventory" | "fim" | "finding";
  agentId?: string;
  observedAt?: Instant;
  timeQuality: "source" | "ambiguous" | "unknown";
  retrievedAt: Instant;
  fields: JsonObject;
}

export interface PlatformPage {
  status: "ok" | "partial" | "denied" | "unavailable" | "failed";
  queryId: Id;
  pageId: Id;
  pageOrdinal: number;
  records: SourceRecord[];
  coverage: Coverage;
  nextCursor?: string;
  warnings: string[];
  platformAttempts: number;
}

export interface AlertStatistics {
  scope: Scope;
  total: Count;
  byLevel: { level: number; count: number }[];
  byHour: { start: Instant; count: number }[];
  coverage: Coverage;
}

export interface PlatformCall {
  runId?: Id;
  beforeAttempt: () => Promise<Result<void>>;
  signal: AbortSignal;
}

export interface ConnectionService {
  list(ctx: CallContext): Promise<Result<ConnectionProfile[]>>;
  save(
    ctx: CallContext,
    input: Omit<ConnectionProfile, "generation" | "updatedAt"> & {
      expectedGeneration?: number;
    },
  ): Promise<Result<ConnectionProfile>>;
  capabilities(
    ctx: CallContext,
    connectionId: Id,
    refresh: boolean,
  ): Promise<Result<Capability[]>>;
  agents(
    ctx: CallContext,
    input: { connectionId: Id; page: PageRequest },
  ): Promise<
    Result<{ items: AgentSummary[]; nextCursor?: string; total?: Count }>
  >;
  deviceDetail(
    ctx: CallContext,
    input: DeviceDetailInput,
    call: PlatformCall,
  ): Promise<Result<DeviceDetail>>;
  query(
    ctx: CallContext,
    input: PlatformQuery,
    call: PlatformCall,
  ): Promise<Result<PlatformPage>>;
  statistics(
    ctx: CallContext,
    scope: Scope,
    call: PlatformCall,
  ): Promise<Result<AlertStatistics>>;
}

export type PlatformQueryPort = Pick<ConnectionService, "query">;

export type ConnectionReadPort = Pick<
  ConnectionService,
  "list" | "capabilities" | "agents"
>;
