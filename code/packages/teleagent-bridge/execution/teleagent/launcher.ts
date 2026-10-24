import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  fail,
  ok,
  type PreparedProfile,
  type Result,
} from "@campussec/contracts";
import { createSignedClient, localSigner, loopbackUrl } from "./client.js";

export const TELEAGENT_270 = Object.freeze({
  version: "2.7.0",
  backendSha256:
    "632ae07bf98e976dc18fb0118feb9bc38be35e1c31352c06621757c55ed60184",
  agent: "campussec-investigator",
  server: "campussec",
});
export interface OwnedBackendOptions {
  binaryPath: string;
  rootDirectory: string;
  model: { baseUrl: string; modelId: string; apiKey: string };
  review: { baseUrl: string; accessKey: string; secretKey: string };
  /** False by default: the acceptance harness cannot contact a public model/review service. */
  allowRemoteServices?: boolean;
}
function serviceUrl(text: string, remote: boolean) {
  const url = new URL(text);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw Error("Invalid explicit model/review endpoint");
  if (!remote) loopbackUrl(url.origin);
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw Error("No loopback port");
  return address.port;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill();
  await Promise.race([exited, delay(2000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, delay(2000)]);
  }
}

/** A new process, key and all account/config roots for each investigation. */
export async function launchOwnedBackend(
  options: OwnedBackendOptions,
  profile: PreparedProfile,
  signal?: AbortSignal,
  evidence?: { endpoint: string; bearer: string },
) {
  if (process.platform !== "win32")
    return fail<never>(
      "CAPABILITY_UNAVAILABLE",
      "当前核实样本仅支持 Windows x64",
    );
  if (
    process.arch !== "x64" ||
    !isAbsolute(options.binaryPath) ||
    !isAbsolute(options.rootDirectory)
  )
    return fail<never>("INVALID_INPUT", "必须明确指定后端样本和独立数据目录");
  let child: ChildProcess | undefined;
  try {
    serviceUrl(options.model.baseUrl, options.allowRemoteServices === true);
    serviceUrl(options.review.baseUrl, options.allowRemoteServices === true);
    if (evidence) {
      const endpoint = loopbackUrl(evidence.endpoint);
      if (
        endpoint.pathname !== "/mcp" ||
        !/^[A-Za-z0-9_-]{43}$/.test(evidence.bearer)
      )
        return fail<never>("INVALID_INPUT", "专用证据通道配置无效");
    }
    if (
      !options.model.modelId ||
      !options.model.apiKey ||
      !options.review.accessKey ||
      !options.review.secretKey
    )
      return fail<never>("INVALID_INPUT", "模型和审查配置必须由调用方明确提供");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(options.binaryPath))
      hash.update(chunk);
    if (hash.digest("hex") !== TELEAGENT_270.backendSha256)
      return fail<never>(
        "CAPABILITY_UNAVAILABLE",
        "TeleAgent 后端样本未匹配已核实版本",
      );
    if (signal?.aborted) return fail<never>("CANCELLED", "后端启动已停止");
    await mkdir(options.rootDirectory, { recursive: true });
    const root = await mkdtemp(join(resolve(options.rootDirectory), "run-"));
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env))
      if (
        value !== undefined &&
        [
          "SYSTEMROOT",
          "WINDIR",
          "COMSPEC",
          "PATH",
          "PATHEXT",
          "SYSTEMDRIVE",
          "PROCESSOR_ARCHITECTURE",
          "NUMBER_OF_PROCESSORS",
        ].includes(key.toUpperCase())
      )
        env[key] = value;
    for (const [name, subdir] of Object.entries({
      XDG_DATA_HOME: "data",
      XDG_CONFIG_HOME: "config",
      XDG_CACHE_HOME: "cache",
      SUPER_AGENT_APP_DATA_DIR: "device-data",
      SUPER_AGENT_APP_CONFIG_DIR: "device-config",
      SUPER_AGENT_LOG_DIR: "logs",
      USERPROFILE: "home",
      HOME: "home",
      APPDATA: "appdata",
      LOCALAPPDATA: "localappdata",
      TEMP: "temp",
      TMP: "temp",
    })) {
      env[name] = join(root, subdir);
      await mkdir(env[name]!, { recursive: true });
    }
    const directory = join(root, "workspace");
    await mkdir(directory);
    const port = await freePort();
    const key = randomBytes(32).toString("base64url");
    const permission = { "*": "deny", "campussec*": "allow" };
    const modelName = "campussec-model/" + options.model.modelId;
    const config = {
      server: { host: "127.0.0.1" },
      autoupdate: false,
      formatter: false,
      lsp: false,
      model: modelName,
      small_model: modelName,
      enabled_providers: ["campussec-model"],
      provider: {
        "campussec-model": {
          name: "Explicit campussec model",
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: options.model.baseUrl,
            apiKey: options.model.apiKey,
          },
          models: {
            [options.model.modelId]: {
              id: options.model.modelId,
              name: options.model.modelId,
              tool_call: true,
              reasoning: false,
              limit: { context: 64000, output: 4096 },
            },
          },
        },
        NewApi: { options: { baseURL: options.review.baseUrl } },
      },
      agent: {
        [TELEAGENT_270.agent]: {
          mode: "primary",
          model: modelName,
          prompt: profile.systemText,
          permission,
          steps: 14,
        },
      },
      permission,
      mcp: evidence
        ? {
            [TELEAGENT_270.server]: {
              type: "remote",
              url: evidence.endpoint,
              enabled: false,
              oauth: false,
              headers: { Authorization: "Bearer " + evidence.bearer },
              timeout: 3000,
            },
          }
        : {},
      instructions: [],
      plugin: [],
      snapshot: false,
    };
    Object.assign(env, {
      SERVER_PORT: String(port),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      SUPER_AGENT_LOCAL_SESSION_KEY: key,
      SUPER_AGENT_TOOLS_SECURITY_AK: options.review.accessKey,
      SUPER_AGENT_TOOLS_SECURITY_SK: options.review.secretKey,
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
      OPENCODE_DISABLE_CLAUDE_CODE: "true",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
      SUPER_AGENT_IGNORE_DOT_GIT: "1",
      ...(options.allowRemoteServices
        ? {}
        : {
            HTTP_PROXY: "http://127.0.0.1:1",
            HTTPS_PROXY: "http://127.0.0.1:1",
            NO_PROXY: "127.0.0.1,localhost,::1",
          }),
    });
    const payload = Buffer.from(JSON.stringify(env));
    if (payload.length > 1048576)
      return fail<never>("INVALID_INPUT", "后端配置过大");
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(payload.length);
    // Only OS launch essentials are inherited. Credentials/config travel through this owned child's stdin.
    const launchEnv = Object.fromEntries(
      Object.entries(env).filter(
        ([name]) =>
          !name.startsWith("SUPER_AGENT_") &&
          !name.startsWith("OPENCODE_") &&
          name !== "SERVER_PORT",
      ),
    );
    child = spawn(options.binaryPath, [], {
      cwd: directory,
      env: launchEnv,
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    let spawnFailed = false;
    child.once("error", () => {
      spawnFailed = true;
    });
    child.stdin!.on("error", () => undefined);
    child.stdin!.end(Buffer.concat([prefix, payload]));
    payload.fill(0);
    const active = child;
    const client = createSignedClient({
      endpoint: "http://127.0.0.1:" + port,
      directory,
      sign: localSigner(key),
      timeoutMs: 500,
    });
    const abort = () => {
      void stop(active);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const deadline = Date.now() + 6000;
      while (
        !spawnFailed &&
        active.exitCode === null &&
        !signal?.aborted &&
        Date.now() < deadline
      ) {
        const ready = await client.request(
          "GET",
          "/session/status",
          undefined,
          signal,
        );
        if (
          ready.ok &&
          ready.value.value !== null &&
          typeof ready.value.value === "object"
        ) {
          let closed = false;
          return ok({
            client: createSignedClient({
              endpoint: "http://127.0.0.1:" + port,
              directory,
              sign: localSigner(key),
            }),
            directory,
            version: TELEAGENT_270.version,
            async close() {
              if (closed) return;
              closed = true;
              await stop(active);
            },
          });
        }
        await delay(60);
      }
    } finally {
      signal?.removeEventListener("abort", abort);
    }
    await stop(active);
    return fail<never>("HOST_UNAVAILABLE", "已核实样本的隔离后端未能就绪");
  } catch {
    if (child) await stop(child);
    return fail<never>("HOST_UNAVAILABLE", "无法准备 TeleAgent 隔离后端");
  }
}
export type OwnedBackend = Extract<
  Awaited<ReturnType<typeof launchOwnedBackend>>,
  { ok: true }
>["value"];
