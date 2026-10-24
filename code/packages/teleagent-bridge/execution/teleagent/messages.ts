import { type ExecutionSnapshot } from "@campussec/contracts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const runMarker = (runId: string) => "[campussec-run:" + runId + "]";
export const backendSessionId = (value: unknown): value is string =>
  typeof value === "string" && /^ses_[A-Za-z0-9_-]{1,160}$/.test(value);
const messageId = (value: unknown): value is string =>
  typeof value === "string" && /^msg_[A-Za-z0-9_-]{1,160}$/.test(value);

/** Only a correlated final assistant message proves a remote terminal state. */
export function observeMessages(input: {
  runId: string;
  sessionId: string;
  userMessageId?: string;
  expectedText?: string;
  messages: unknown;
  now: string;
}): ExecutionSnapshot {
  const base: ExecutionSnapshot = {
    runId: input.runId,
    sessionId: input.sessionId,
    ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
    phase: "uncertain",
    verification: "unverified",
    observedAt: input.now,
  };
  if (
    !backendSessionId(input.sessionId) ||
    !Array.isArray(input.messages) ||
    input.messages.length > 256
  )
    return base;
  const rows: { info: RecordValue; parts: unknown[] }[] = [];
  const seen = new Set<string>();
  for (const row of input.messages) {
    if (
      !record(row) ||
      !record(row.info) ||
      !Array.isArray(row.parts) ||
      !messageId(row.info.id) ||
      seen.has(row.info.id) ||
      row.info.sessionID !== input.sessionId
    )
      return base;
    seen.add(row.info.id);
    rows.push({ info: row.info, parts: row.parts });
  }
  const users = rows.filter(
    ({ info, parts }) =>
      info.role === "user" &&
      (input.userMessageId === undefined || info.id === input.userMessageId) &&
      parts.some(
        (p) =>
          record(p) &&
          p.type === "text" &&
          typeof p.text === "string" &&
          (input.expectedText !== undefined
            ? p.text === input.expectedText
            : p.text.endsWith("\n\n" + runMarker(input.runId))),
      ),
  );
  if (users.length !== 1) return base;
  const user = users[0]!.info.id as string;
  const correlated = rows.filter(
    ({ info }) => info.role === "assistant" && info.parentID === user,
  );
  const running: ExecutionSnapshot = {
    ...base,
    userMessageId: user,
    phase: "running",
    verification: "verified",
  };
  if (!correlated.length) return { ...running, phase: "submitted" };
  if (
    correlated.some(
      ({ info }) =>
        !record(info.time) ||
        typeof info.time.created !== "number" ||
        !Number.isFinite(info.time.created),
    )
  )
    return base;
  correlated.sort(
    (a, b) =>
      (a.info.time as { created: number }).created -
      (b.info.time as { created: number }).created,
  );
  const last = correlated.at(-1)!.info;
  const time = last.time as RecordValue;
  if (record(last.error)) {
    const kind = last.error.name ?? last.error.type;
    if (kind === "MessageAbortedError")
      return {
        ...running,
        phase: "cancelled",
        resultMessageId: last.id as string,
        error: {
          code: "CANCELLED",
          message: "TeleAgent 已确认中止本次提交",
          retryable: false,
        },
      };
    return {
      ...running,
      phase: "failed",
      resultMessageId: last.id as string,
      error: {
        code: "HOST_UNAVAILABLE",
        message: "TeleAgent 返回关联执行错误",
        retryable: false,
      },
    };
  }
  if (last.error !== undefined && last.error !== null) return base;
  if (
    typeof time.completed !== "number" ||
    !Number.isFinite(time.completed) ||
    time.completed < (time.created as number)
  )
    return running;
  if (["tool_calls", "tool-calls", "tool_use"].includes(String(last.finish)))
    return running;
  if (last.finish !== "stop") return { ...base, userMessageId: user };
  let inputTokens = 0,
    outputTokens = 0,
    known = true;
  for (const { info } of correlated) {
    const tokens = info.tokens;
    if (
      !record(tokens) ||
      typeof tokens.input !== "number" ||
      typeof tokens.output !== "number" ||
      !Number.isSafeInteger(tokens.input) ||
      tokens.input < 0 ||
      !Number.isSafeInteger(tokens.output) ||
      tokens.output < 0
    ) {
      known = false;
      break;
    }
    inputTokens += tokens.input;
    outputTokens += tokens.output;
  }
  return {
    ...running,
    phase: "completed",
    resultMessageId: last.id as string,
    finishReason: "stop",
    ...(known && Number.isSafeInteger(inputTokens + outputTokens)
      ? {
          usage: {
            inputTokens,
            outputTokens,
            estimated: false,
            costKnown: false,
          },
        }
      : {}),
  };
}
