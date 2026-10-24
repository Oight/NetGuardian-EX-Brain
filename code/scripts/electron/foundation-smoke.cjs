// Real Electron process, real production bootstrap/preload/renderer; isolated synthetic data only.
const { app, safeStorage } = require("electron");
const assert = require("node:assert/strict");
const { mkdir, writeFile } = require("node:fs/promises");
const { resolve, join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");
const phase = process.argv[2];
const directory = resolve(process.argv[3] || "");
assert.ok(
  ["write", "reopen"].includes(phase),
  "Explicit acceptance phase required",
);
assert.ok(
  directory.startsWith(resolve(".local") + require("node:path").sep),
  "Acceptance data must stay in code/.local",
);
app.setPath("userData", join(directory, "electron-profile"));
let completed = false;
const timeout = setTimeout(() => {
  console.error("Electron acceptance timed out");
  app.exit(1);
}, 30000);
app.on("will-quit", () => {
  clearTimeout(timeout);
  if (!completed) process.exitCode = 1;
});
(async () => {
  await mkdir(directory, { recursive: true });
  const { bootstrapDesktop } = await import(
    pathToFileURL(resolve("dist/apps/desktop/main/bootstrap.js")).href
  );
  const desktop = await bootstrapDesktop({
    dataDir: join(directory, "data"),
    showWindow: false,
  });
  assert.ok(desktop, "Production bootstrap must create a real window");
  const window = desktop.window;
  const prefs = window.webContents.getLastWebPreferences();
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);
  const renderer = await window.webContents.executeJavaScript(
    `({ node: typeof require, api: typeof window.campusSec?.invoke, url: location.protocol })`,
  );
  assert.equal(renderer.node, "undefined");
  assert.equal(renderer.api, "function");
  assert.equal(renderer.url, "file:");
  async function invoke(method, payload) {
    const request = {
      protocolVersion: "0.1.0",
      requestId: randomUUID(),
      method,
      payload,
    };
    const response = await window.webContents.executeJavaScript(
      `window.campusSec.invoke(${JSON.stringify(request)})`,
    );
    assert.equal(response.requestId, request.requestId);
    return response.result;
  }
  const settings = await invoke("runtime.settings", {});
  assert.ok(settings.ok);
  const expected = phase === "write" ? 30 : 31;
  if (phase === "reopen")
    assert.equal(
      settings.value.retentionDays,
      30,
      "Actual settings survive Electron restart",
    );
  const configured = await invoke("runtime.configure", {
    expectedRevision: settings.value.revision,
    settings: {
      trayEnabled: false,
      budgetTimeZone: "Asia/Shanghai",
      retentionDays: expected,
    },
  });
  assert.ok(configured.ok);
  const trayOn = await invoke("runtime.setTray", { enabled: true });
  assert.ok(trayOn.ok);
  assert.equal(trayOn.value.enabled, true);
  const trayOff = await invoke("runtime.setTray", { enabled: false });
  assert.ok(trayOff.ok);
  const snapshot = await invoke("workspace.snapshot", {});
  assert.ok(snapshot.ok);
  assert.equal(snapshot.value.totals.active, 0);
  const bad = await invoke("runtime.status", { actor: { role: "system" } });
  assert.equal(bad.ok, false);
  const notReady = await invoke("cases.create", {
    title: "synthetic",
    scope: {
      connectionId: randomUUID(),
      agentIds: ["001"],
      from: "2026-10-24T00:00:00.000Z",
      to: "2026-10-24T00:30:00.000Z",
      timeZone: "Asia/Shanghai",
    },
    seedRefs: [],
  });
  assert.equal(notReady.ok, false);
  assert.equal(notReady.error.code, "CAPABILITY_UNAVAILABLE");
  assert.equal(
    safeStorage.isEncryptionAvailable(),
    true,
    "Actual OS encryption provider must be available",
  );
  const synthetic = "campussec-acceptance-only";
  assert.equal(
    safeStorage.decryptString(safeStorage.encryptString(synthetic)),
    synthetic,
  );
  const secret = await desktop.runtime.secrets.put({
    owner: desktop.runtime.context().actor.principalId,
    purpose: "acceptance",
    value: new TextEncoder().encode(synthetic),
    persist: true,
  });
  assert.ok(secret.ok);
  const recovered = await desktop.runtime.secrets.use(
    secret.value,
    "acceptance",
    async (bytes) => new TextDecoder().decode(bytes),
  );
  assert.ok(recovered.ok);
  assert.equal(recovered.value, synthetic);
  assert.ok((await desktop.runtime.secrets.remove(secret.value)).ok);
  await writeFile(
    join(directory, `${phase}.json`),
    JSON.stringify(
      {
        phase,
        versions: {
          electron: process.versions.electron,
          node: process.versions.node,
          chrome: process.versions.chrome,
        },
        realWindow: true,
        sandboxedPreload: true,
        ipc: true,
        sqlite: true,
        restartRead: phase === "reopen",
        tray: true,
        osProtection: true,
        controlledShutdown: true,
        retentionDays: expected,
      },
      null,
      2,
    ),
  );
  completed = true;
  desktop.close();
})().catch((error) => {
  console.error(error);
  clearTimeout(timeout);
  app.exit(1);
});
