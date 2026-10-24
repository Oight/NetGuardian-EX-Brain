const { prepareCampusConnection } = (await import(
  new URL(
    "../../dist/apps/desktop/runtime/campus-connection.js",
    import.meta.url,
  ).href
)) as typeof import("../../apps/desktop/runtime/campus-connection.js");
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const { composeRuntime } = (await import(
  new URL("../../dist/apps/desktop/runtime/compose.js", import.meta.url).href
)) as typeof import("../../apps/desktop/runtime/compose.js");
const { serveWorkbench } = (await import(
  new URL("../../dist/apps/desktop/runtime/web-server.js", import.meta.url).href
)) as typeof import("../../apps/desktop/runtime/web-server.js");
const { createAuthentication } = (await import(
  new URL("../../dist/apps/desktop/main/authentication.js", import.meta.url)
    .href
)) as typeof import("../../apps/desktop/main/authentication.js");
const { createAuthController } = (await import(
  new URL("../../dist/apps/desktop/main/auth-controller.js", import.meta.url)
    .href
)) as typeof import("../../apps/desktop/main/auth-controller.js");
import { createCampusProxy } from "@campussec/wazuh-adapter";
import { fail } from "@campussec/contracts";
import { readTeleAgentOptions } from "../../apps/desktop/runtime/teleagent-config.ts";
const teleagent = await readTeleAgentOptions(process.argv);
const dataDir = resolve(".local/web-runtime");
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const proxy = process.argv.includes("--campus-proxy");
let web: Awaited<ReturnType<typeof serveWorkbench>> | undefined;
const auth = createAuthController({
  authentication: await createAuthentication({
    directory: resolve(dataDir, "auth"),
  }),
  open: async (account, protection, databaseProtection) => {
    const opened = await composeRuntime({
      dataDir,
      spaceId: account.spaceId,
      principalId: account.id,
      identityEpoch: 1,
      protection,
      databaseProtection,
      teleagent,
      http: {
        request: async () =>
          fail("CAPABILITY_UNAVAILABLE", "网页仅允许受控校园代理连接"),
      },
      externalPlatform: proxy ? createCampusProxy() : undefined,
      saveExport: async (value) =>
        web
          ? web.saveExport(value)
          : fail("CAPABILITY_UNAVAILABLE", "下载通道尚未就绪"),
    });
    if (opened.ok && proxy) {
      const prepared = await prepareCampusConnection(opened.value);
      if (!prepared.ok) {
        await opened.value.close();
        return prepared;
      }
    }
    return opened;
  },
});
const port = Number(
  process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? 4180,
);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw Error("Invalid port");
try {
  web = await serveWorkbench({
    authentication: auth,
    assets: resolve("dist/apps/desktop/renderer"),
    port,
    label: proxy
      ? "网页工作台 · 本机校园只读代理 · 真实宿主未配置"
      : "网页工作台 · 平台与宿主未启用",
  });
} catch (error) {
  await auth.close();
  throw error;
}
console.log(`Workbench: ${web.origin}`);
async function stop() {
  await web?.close();
  await auth.close();
  process.exit(0);
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
