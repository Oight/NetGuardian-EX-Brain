import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { OwnedBackendOptions } from "@campussec/teleagent-bridge/execution/teleagent";

/** An explicit operator-owned file, never a discovered desktop configuration. */
export async function readTeleAgentOptions(
  args: string[],
): Promise<Omit<OwnedBackendOptions, "rootDirectory"> | undefined> {
  const flags = args.filter((arg) => arg.startsWith("--teleagent-config="));
  if (!flags.length) return;
  if (flags.length !== 1) throw Error("Only one --teleagent-config is allowed");
  const filename = flags[0]!.slice("--teleagent-config=".length);
  if (!isAbsolute(filename))
    throw Error("TeleAgent config path must be absolute");
  try {
    const bytes = await readFile(filename);
    if (bytes.length > 16384) throw Error();
    const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    const object = (v: unknown): v is Record<string, unknown> =>
      v !== null && typeof v === "object" && !Array.isArray(v);
    const keys = (v: Record<string, unknown>, expected: string[]) =>
      Object.keys(v).every((k) => expected.includes(k));
    if (
      !object(value) ||
      !keys(value, ["binaryPath", "model", "review", "allowRemoteServices"]) ||
      typeof value.binaryPath !== "string" ||
      !isAbsolute(value.binaryPath) ||
      !object(value.model) ||
      !keys(value.model, ["baseUrl", "modelId", "apiKey"]) ||
      !object(value.review) ||
      !keys(value.review, ["baseUrl", "accessKey", "secretKey"]) ||
      ![
        value.model.baseUrl,
        value.model.modelId,
        value.model.apiKey,
        value.review.baseUrl,
        value.review.accessKey,
        value.review.secretKey,
      ].every((item) => typeof item === "string" && item.length > 0) ||
      (value.allowRemoteServices !== undefined &&
        typeof value.allowRemoteServices !== "boolean")
    )
      throw Error();
    return value as unknown as Omit<OwnedBackendOptions, "rootDirectory">;
  } catch {
    throw Error(
      "TeleAgent configuration is unreadable or invalid; credentials are not included in diagnostics",
    );
  }
}
