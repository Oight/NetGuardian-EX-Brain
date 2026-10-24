import {
  fail,
  ok,
  parseDto,
  type EvidenceRef,
  type InvestigationStepInput,
  type JsonObject,
  type PlatformQuery,
  type ReportCandidate,
  type Result,
} from "@campussec/contracts";
import type { State } from "./state.js";

export type Command =
  | { kind: "context" }
  | { kind: "evidence"; ref: EvidenceRef; fieldNames: string[] }
  | { kind: "step"; step: InvestigationStepInput }
  | { kind: "proposal"; candidate: ReportCandidate }
  | {
      kind: "query";
      query: PlatformQuery;
      purpose?: string;
      step?: InvestigationStepInput;
    };
const keys = (args: JsonObject, allowed: string[]) =>
  Object.keys(args).every((key) => allowed.includes(key));
export function command(
  name: string,
  args: JsonObject,
  state: State,
): Result<Command> {
  if (!state.profile.allowedTools.includes(name))
    return fail("FORBIDDEN", "本轮配置未开放该工具");
  if (name === "get_case_context")
    return keys(args, [])
      ? ok({ kind: "context" })
      : fail("INVALID_INPUT", "上下文工具不接受参数");
  if (name === "get_evidence") {
    if (!keys(args, ["ref", "fieldNames"]))
      return fail("INVALID_INPUT", "证据工具参数无效");
    const ref = parseDto("EvidenceRef", args.ref);
    if (!ref.ok) return ref;
    if (
      !Array.isArray(args.fieldNames) ||
      !args.fieldNames.length ||
      args.fieldNames.length > 100 ||
      !args.fieldNames.every((n) => typeof n === "string" && allowedField(n))
    )
      return fail("INVALID_INPUT", "请求字段不在证据白名单内");
    return ok({
      kind: "evidence",
      ref: ref.value,
      fieldNames: [...new Set(args.fieldNames as string[])].sort(),
    });
  }
  if (name === "record_investigation_step") {
    const step = parseDto("InvestigationStepInput", args);
    return step.ok ? ok({ kind: "step", step: step.value }) : step;
  }
  if (name === "propose_report") {
    const candidate = parseDto("ReportCandidate", args);
    if (!candidate.ok) return candidate;
    if (
      candidate.value.caseId !== state.run.caseId ||
      candidate.value.runId !== state.run.id
    )
      return fail("FORBIDDEN", "报告不属于当前轮次");
    return ok({ kind: "proposal", candidate: candidate.value });
  }
  const queryNames = [
    "search_related_alerts",
    "search_authentication_events",
    "get_host_inventory",
    "search_file_changes",
    "get_host_findings",
  ];
  if (!queryNames.includes(name)) return fail("FORBIDDEN", "未开放的工具");
  const specific =
    name === "search_related_alerts"
      ? ["filter"]
      : name === "search_authentication_events"
        ? ["outcome", "account", "sourceIp"]
        : name === "search_file_changes"
          ? ["pathEquals"]
          : ["category"];
  const single = name === "get_host_inventory" || name === "get_host_findings";
  if (
    !keys(args, [
      single ? "agentId" : "agentIds",
      ...(single ? [] : ["from", "to"]),
      "page",
      "purpose",
      "step",
      ...specific,
    ])
  )
    return fail("INVALID_INPUT", "查询包含未开放参数");
  if (
    args.purpose !== undefined &&
    (typeof args.purpose !== "string" ||
      !args.purpose.trim() ||
      Array.from(args.purpose).length > 500)
  )
    return fail("INVALID_INPUT", "查询目的无效");
  const scope = {
    ...state.run.scope,
    agentIds: single ? [args.agentId] : args.agentIds,
    from: args.from ?? state.run.scope.from,
    to: args.to ?? state.run.scope.to,
  };
  const page = args.page ?? { limit: 50 };
  let query: unknown;
  switch (name) {
    case "search_related_alerts":
      query = {
        kind: "alerts",
        scope,
        page,
        filter: args.filter ?? {},
        fixedUpper: scope.to,
      };
      break;
    case "search_authentication_events":
      query = {
        kind: "authentication",
        scope,
        page,
        outcome: args.outcome ?? "any",
        ...(args.account === undefined ? {} : { account: args.account }),
        ...(args.sourceIp === undefined ? {} : { sourceIp: args.sourceIp }),
      };
      break;
    case "get_host_inventory":
      query = { kind: "inventory", scope, page, category: args.category };
      break;
    case "search_file_changes":
      query = {
        kind: "file_changes",
        scope,
        page,
        ...(args.pathEquals === undefined
          ? {}
          : { pathEquals: args.pathEquals }),
      };
      break;
    case "get_host_findings":
      query = { kind: "findings", scope, page, category: args.category };
      break;
  }
  const parsed = parseDto("PlatformQuery", query);
  if (!parsed.ok) return parsed;
  const q = parsed.value,
    outer = state.run.scope;
  if (
    q.scope.connectionId !== outer.connectionId ||
    q.scope.from < outer.from ||
    q.scope.to > outer.to ||
    q.scope.agentIds.some((id) => !outer.agentIds.includes(id))
  )
    return fail("SCOPE_EXCEEDED", "查询超出本轮设备或时间范围");
  const capability =
    q.kind === "alerts"
      ? "alerts"
      : q.kind === "authentication"
        ? "authentication_events"
        : q.kind === "inventory"
          ? `inventory_${q.category}`
          : q.kind === "file_changes"
            ? "fim_events"
            : q.category;
  if (
    !state.initial.capabilities.some(
      (c) => c.name === capability && c.state === "available",
    )
  )
    return fail("CAPABILITY_UNAVAILABLE", "本轮未核实该查询能力可用");
  const step =
    args.step === undefined
      ? undefined
      : parseDto("InvestigationStepInput", args.step);
  if (step && !step.ok) return step;
  return ok({
    kind: "query",
    query: q,
    ...(typeof args.purpose === "string"
      ? { purpose: args.purpose.trim() }
      : {}),
    ...(step?.ok ? { step: step.value } : {}),
  });
}

// Positive output allowlist: never return arbitrary event payloads, command lines or raw logs.
const scalars = new Set(
  `timestamp @timestamp agent.id agent.name rule.id rule.level rule.description data.srcip data.dstip data.srcuser data.dstuser decoder.name location syscheck.path syscheck.event syscheck.mtime_after vulnerability.id vulnerability.severity package.name package.version text summary event.action event.category source.ip destination.ip user.name user.namespace id name version architecture pid ppid protocol state inode file size perm mtime policy_id description pass fail invalid total_checks score board_serial start_time`.split(
    " ",
  ),
);
const nested: Record<string, Set<string>> = {
  os: new Set(
    "name version platform architecture codename major minor build type release hostname".split(
      " ",
    ),
  ),
  cpu: new Set("name cores mhz speed".split(" ")),
  ram: new Set("free total usage".split(" ")),
  local: new Set(["ip", "port"]),
  remote: new Set(["ip", "port"]),
  scan: new Set(["id", "time"]),
};
export const allowedField = (name: string) =>
  scalars.has(name) || Object.hasOwn(nested, name) || name === "rule.groups";
const scalar = (value: unknown) =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));
export function safeField(name: string, value: unknown): boolean {
  if (scalars.has(name)) return scalar(value);
  if (name === "rule.groups")
    return Array.isArray(value) && value.every((v) => typeof v === "string");
  const children = nested[name];
  return (
    !!children &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(([key, v]) => children.has(key) && scalar(v))
  );
}
export const safeContent = (content: JsonObject) =>
  Object.entries(content).every(([key, value]) => safeField(key, value));
