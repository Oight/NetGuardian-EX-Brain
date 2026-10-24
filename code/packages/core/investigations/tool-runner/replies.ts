import {
  canonicalJson,
  fail,
  ok,
  parseEvidenceToolEnvelope,
  parseControlToolEnvelope,
  utf8Bytes,
  type AppError,
  type BudgetState,
  type ContextRef,
  type ControlToolEnvelope,
  type EvidenceProjection,
  type EvidenceToolEnvelope,
  type Result,
  type ToolReply,
} from "@campussec/contracts";

export function control(
  data: ControlToolEnvelope["data"],
  budget: BudgetState,
  error = false,
): Result<ToolReply> {
  const envelope: ControlToolEnvelope = {
    schemaVersion: "0.1.0",
    status: error ? "failed" : "ok",
    data,
    budget,
    warnings: [],
  };
  const valid = parseControlToolEnvelope(envelope);
  return valid.ok
    ? ok({
        isError: error,
        text: canonicalJson(valid.value),
        structured: JSON.parse(canonicalJson(valid.value)),
        preparedProjectionIds: [],
      })
    : valid;
}
export function evidence(
  envelope: EvidenceToolEnvelope,
): Result<{ reply: ToolReply; contextRefs: ContextRef[] }> {
  envelope = structuredClone(envelope);
  let omitted = false;
  if (envelope.records.length > 50) {
    envelope.records = envelope.records.slice(0, 50);
    omitted = true;
  }
  // Coverage remains the source query fact, even if less evidence fits this reply.
  // Keep it bounded without pretending that omitted metadata was absent upstream.
  if (
    envelope.warnings.length > 20 ||
    envelope.warnings.some((s) => s.length > 200)
  ) {
    envelope.warnings = envelope.warnings
      .slice(0, 20)
      .map((s) => (s.length > 200 ? s.slice(0, 200) + "…" : s));
    omitted = true;
  }
  if (envelope.coverage) {
    const c = envelope.coverage;
    if (
      c.reasons.length > 10 ||
      c.reasons.some((s) => s.length > 120) ||
      c.sourceTypes.length > 10 ||
      c.sourceTypes.some((s) => s.length > 120)
    )
      omitted = true;
    c.reasons = c.reasons.slice(0, 10).map((s) => s.slice(0, 120));
    c.sourceTypes = c.sourceTypes.slice(0, 10).map((s) => s.slice(0, 120));
  }
  const addOmission = () => {
    if (!envelope.warnings.includes("本次回复省略部分内容；查询覆盖计数不变"))
      envelope.warnings.push("本次回复省略部分内容；查询覆盖计数不变");
    if (envelope.status === "ok") envelope.status = "partial";
  };
  if (omitted) addOmission();
  if (envelope.context && utf8Bytes(canonicalJson(envelope)) > 16384) {
    envelope.context.capabilities = envelope.context.capabilities.map((c) => ({
      ...c,
      evidence: "诊断文字已省略",
    }));
    addOmission();
  }
  while (utf8Bytes(canonicalJson(envelope)) > 16384) {
    addOmission();
    if (envelope.records.length) envelope.records.pop();
    else if (envelope.context?.backgrounds.length)
      envelope.context.backgrounds.pop();
    else return fail("VALIDATION_FAILED", "回复基础信息超过限制");
  }
  const valid = parseEvidenceToolEnvelope(envelope);
  if (!valid.ok) return valid;
  return ok({
    reply: {
      isError: ["denied", "unavailable", "failed"].includes(valid.value.status),
      text: canonicalJson(valid.value),
      structured: JSON.parse(canonicalJson(valid.value)),
      preparedProjectionIds: valid.value.records.map((r) => r.ref.projectionId),
    },
    contextRefs: valid.value.context?.backgrounds.map((c) => c.ref) ?? [],
  });
}
export const record = (p: EvidenceProjection) => ({
  ref: { ...p.ref, projectionId: p.id },
  content: p.content,
});
export function failure(
  error: AppError,
  budget: BudgetState,
  isRead: boolean,
): Result<ToolReply> {
  // Do not echo upstream messages, transport payloads or user-controlled exception text.
  if (!isRead)
    return control(
      { error: { code: error.code, message: "操作未完成", retryable: false } },
      budget,
      true,
    );
  const result = evidence({
    schemaVersion: "0.1.0",
    status:
      error.code === "FORBIDDEN" || error.code === "UPSTREAM_DENIED"
        ? "denied"
        : [
              "CAPABILITY_UNAVAILABLE",
              "UPSTREAM_UNAVAILABLE",
              "UPSTREAM_TIMEOUT",
            ].includes(error.code)
          ? "unavailable"
          : "failed",
    records: [],
    budget,
    warnings: [`操作未完成：${error.code}`],
  });
  return result.ok ? ok(result.value.reply) : result;
}
