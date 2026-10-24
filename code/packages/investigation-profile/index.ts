import { createHash } from "node:crypto";
import {
  DEFAULT_LIMITS,
  canonicalJson,
  fail,
  ok,
  parseDto,
  parseWith,
  callContextSchema,
  type InvestigationProfilePort,
} from "@campussec/contracts";
import { INVESTIGATION_SKILL, PROFILE_MANIFEST } from "./skill.js";
export { PROFILE_MANIFEST } from "./skill.js";

const seedFields = new Set([
  "timestamp",
  "agent.id",
  "agent.name",
  "rule.id",
  "rule.level",
  "rule.description",
  "event.action",
  "event.category",
  "source.ip",
  "destination.ip",
  "user.name",
  "user.namespace",
  "text",
  "summary",
]);

export function createInvestigationProfile(): InvestigationProfilePort {
  return {
    async prepare(ctx, raw) {
      const caller = parseWith(callContextSchema, ctx),
        parsed = parseDto("InvestigationProfileInput", raw);
      if (!caller.ok) return caller;
      if (!parsed.ok) return parsed;
      if (caller.value.actor.role !== "system")
        return fail("FORBIDDEN", "调查配置仅由协调者准备");
      const { run, initialInput, seedProjections } = parsed.value;
      if (
        run.identityEpoch !== caller.value.actor.identityEpoch ||
        (caller.value.actor.runId && caller.value.actor.runId !== run.id)
      )
        return fail("IDENTITY_CHANGED", "调查配置身份不匹配");
      if (run.profileVersion !== PROFILE_MANIFEST.version)
        return fail("CAPABILITY_UNAVAILABLE", "调查配置版本不支持");
      if (canonicalJson(run.scope) !== canonicalJson(initialInput.scope))
        return fail("SCOPE_EXCEEDED", "冻结范围与轮次不一致");
      const key = (ref: { evidenceId: string; version: number }) =>
        `${ref.evidenceId}:${ref.version}`;
      const seeds = new Set(initialInput.seedRefs.map(key)),
        seen = new Set<string>(),
        ids = new Set<string>();
      for (const projection of seedProjections) {
        if (
          projection.runId !== run.id ||
          !seeds.has(key(projection.ref)) ||
          seen.has(key(projection.ref)) ||
          ids.has(projection.id) ||
          projection.state !== "prepared"
        )
          return fail("FORBIDDEN", "种子投影未属于本轮准备输入");
        if (projection.availability !== "available")
          return fail("EXPIRED", "种子正文已过期");
        if (
          Object.keys(projection.content).some(
            (field) => !seedFields.has(field),
          )
        )
          return fail("FORBIDDEN", "初始种子包含非白名单字段");
        if (
          typeof projection.content["agent.id"] === "string" &&
          !run.scope.agentIds.includes(projection.content["agent.id"])
        )
          return fail("SCOPE_EXCEEDED", "种子声明了范围外设备");
        if (
          createHash("sha256")
            .update(canonicalJson(projection.content))
            .digest("hex") !== projection.contentHash
        )
          return fail("VALIDATION_FAILED", "种子投影摘要不匹配");
        seen.add(key(projection.ref));
        ids.add(projection.id);
      }
      if (
        seen.size !== seeds.size ||
        seeds.size !== initialInput.seedRefs.length
      )
        return fail("INVALID_INPUT", "种子缺少准备投影或重复");
      const contexts = new Set<string>();
      for (const context of initialInput.contexts) {
        const k = `${context.id}:${context.version}`;
        if (
          contexts.has(k) ||
          (context.caseId && context.caseId !== run.caseId) ||
          context.connectionId !== run.scope.connectionId ||
          !context.agentIds.some((id) => run.scope.agentIds.includes(id)) ||
          context.from >= run.scope.to ||
          context.to <= run.scope.from
        )
          return fail("SCOPE_EXCEEDED", "背景不属于冻结范围或重复");
        contexts.add(k);
      }
      const capabilities = new Set(
        initialInput.capabilities
          .filter((v) => v.state === "available")
          .map((v) => v.name),
      );
      if (
        new Set(initialInput.capabilities.map((v) => v.name)).size !==
        initialInput.capabilities.length
      )
        return fail("INVALID_INPUT", "能力名称重复，不能推定授权");
      const allowedTools = [
        "get_case_context",
        "get_evidence",
        "record_investigation_step",
        "propose_report",
      ];
      if (capabilities.has("alerts"))
        allowedTools.push("search_related_alerts");
      if (capabilities.has("authentication_events"))
        allowedTools.push("search_authentication_events");
      if ([...capabilities].some((v) => v.startsWith("inventory_")))
        allowedTools.push("get_host_inventory");
      if (capabilities.has("fim_events"))
        allowedTools.push("search_file_changes");
      if (capabilities.has("sca") || capabilities.has("vulnerabilities"))
        allowedTools.push("get_host_findings");
      return parseDto("PreparedProfile", {
        version: PROFILE_MANIFEST.version,
        systemText:
          INVESTIGATION_SKILL +
          "\n允许工具：" +
          allowedTools.join(", ") +
          "\nSkill SHA256：" +
          PROFILE_MANIFEST.skillSha256,
        userText: canonicalJson({
          runId: run.id,
          ...initialInput,
          seeds: seedProjections.map(({ id, ref, content, contentHash }) => ({
            id,
            ref,
            content,
            contentHash,
          })),
          limits: {
            tools: DEFAULT_LIMITS.toolCalls,
            reads: DEFAULT_LIMITS.readCalls,
            platformAttempts: DEFAULT_LIMITS.platformAttempts,
            distinctEvents: DEFAULT_LIMITS.distinctEvents,
            deadline: run.expiresAt,
          },
        }),
        allowedTools,
        seedProjectionIds: seedProjections.map((v) => v.id),
        contextRefs: initialInput.contexts.map(({ id, version }) => ({
          contextId: id,
          version,
        })),
      });
    },
  };
}
