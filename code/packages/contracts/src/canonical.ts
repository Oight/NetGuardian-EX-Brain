import type { CreateRequest, Json, Result } from "./types.js";
import { fail, ok } from "./errors.js";

function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a, (c) => c.codePointAt(0)!);
  const right = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  return left.length - right.length;
}

export function canonicalJson(input: unknown): string {
  const seen = new Set<object>();
  function encode(value: unknown, depth: number): string {
    if (depth > 64) throw new TypeError("JSON nesting exceeds limit");
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "string"
    )
      return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value))
      return JSON.stringify(value);
    if (typeof value !== "object" || !value || seen.has(value))
      throw new TypeError("Unsupported JSON value");
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      !Array.isArray(value) &&
      prototype !== Object.prototype &&
      prototype !== null
    )
      throw new TypeError("Expected plain JSON");
    if (Object.getOwnPropertySymbols(value).length)
      throw new TypeError("Symbol keys are not JSON");
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const items: string[] = [];
        for (let i = 0; i < value.length; i++) {
          if (!Object.hasOwn(value, i))
            throw new TypeError("Sparse arrays are not JSON");
          const descriptor = Object.getOwnPropertyDescriptor(value, String(i))!;
          if (!("value" in descriptor))
            throw new TypeError("Accessors are not JSON");
          items.push(encode(descriptor.value, depth + 1));
        }
        return `[${items.join(",")}]`;
      }
      return `{${Object.keys(value)
        .sort(compareCodePoints)
        .map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
          if (!("value" in descriptor))
            throw new TypeError("Accessors are not JSON");
          return `${JSON.stringify(key)}:${encode(descriptor.value, depth + 1)}`;
        })
        .join(",")}}`;
    } finally {
      seen.delete(value);
    }
  }
  return encode(input, 0);
}

export const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).byteLength;
export type Digest = (bytes: Uint8Array) => Promise<Uint8Array>;

export async function sha256(input: Json, digest: Digest): Promise<string> {
  const bytes = await digest(new TextEncoder().encode(canonicalJson(input)));
  if (bytes.length !== 32) throw new TypeError("Expected SHA-256 digest");
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function normalizedRequest(input: CreateRequest): Json {
  const scope = input.requestedScope;
  return {
    origin: input.origin,
    connectionId: input.connectionId,
    question: input.question.trim(),
    seedRefs: [...input.seedRefs]
      .sort(
        (a, b) =>
          compareCodePoints(a.evidenceId, b.evidenceId) ||
          a.version - b.version,
      )
      .map((ref) => ({ evidenceId: ref.evidenceId, version: ref.version })),
    ...(scope
      ? {
          requestedScope: {
            ...scope,
            agentIds: [...new Set(scope.agentIds)].sort(compareCodePoints),
          },
        }
      : {}),
    ...(input.caseId ? { caseId: input.caseId } : {}),
    ...(input.autoCandidateId
      ? { autoCandidateId: input.autoCandidateId }
      : {}),
  };
}

interface LocalCursor {
  version: "0.1.0";
  spaceId: string;
  queryHash: string;
  lastKeys: Json[];
}
export function encodeCursor(cursor: LocalCursor): string {
  const bytes = new TextEncoder().encode(canonicalJson(cursor));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export function decodeCursor(
  input: string,
  expected: { spaceId: string; queryHash: string },
): Result<LocalCursor> {
  try {
    if (utf8Bytes(input) > 2048 || !/^[A-Za-z0-9_-]+$/.test(input))
      return fail("CURSOR_INVALID", "分页游标无效");
    const bytes = Uint8Array.from(
      atob(input.replaceAll("-", "+").replaceAll("_", "/")),
      (c) => c.charCodeAt(0),
    );
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      return fail("CURSOR_INVALID", "分页游标无效");
    const c = value as Record<string, unknown>;
    if (
      Object.keys(c).sort().join(",") !==
        "lastKeys,queryHash,spaceId,version" ||
      c.version !== "0.1.0" ||
      c.spaceId !== expected.spaceId ||
      c.queryHash !== expected.queryHash ||
      !Array.isArray(c.lastKeys) ||
      c.lastKeys.length > 10 ||
      !c.lastKeys.every(
        (x) =>
          x === null ||
          typeof x === "string" ||
          (typeof x === "number" && Number.isFinite(x)),
      )
    ) {
      return fail("CURSOR_INVALID", "分页游标不匹配当前查询");
    }
    return ok(c as unknown as LocalCursor);
  } catch {
    return fail("CURSOR_INVALID", "分页游标无效");
  }
}
