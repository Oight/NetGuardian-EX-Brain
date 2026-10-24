// External Windows/Electron acceptance only. Never execute on the Bun-only development machine.
// Real production bootstrap/preload/renderer, isolated synthetic data and no configured platform endpoints.
const { app, safeStorage } = require("electron");
const assert = require("node:assert/strict");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const { resolve, join, sep } = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");
const phase = process.argv[2];
const directory = resolve(process.argv[3] || "");
assert.ok(
  ["write", "reopen"].includes(phase),
  "Explicit acceptance phase required",
);
assert.ok(
  directory.startsWith(resolve(".local") + sep),
  "Acceptance data must stay in code/.local",
);
app.setPath("userData", join(directory, "electron-profile"));
let completed = false;
const timeout = setTimeout(() => {
  console.error("Electron acceptance timed out");
  app.exit(1);
}, 60000);
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
    backgroundEnabled: false,
  });
  assert.ok(desktop, "Production bootstrap must create a real window");
  const window = desktop.window;
  const prefs = window.webContents.getLastWebPreferences();
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);
  const renderer = await window.webContents.executeJavaScript(
    "({node:typeof require,process:typeof process,bun:typeof Bun,api:typeof window.campusSec?.invoke,url:location.protocol,href:location.href})",
  );
  assert.equal(renderer.node, "undefined");
  assert.equal(renderer.process, "undefined");
  assert.equal(renderer.bun, "undefined");
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
  async function waitFor(expression) {
    return window.webContents.executeJavaScript(
      `(async()=>{for(let i=0;i<400;i++){if(${expression})return true;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('Renderer acceptance condition timed out');})()`,
    );
  }
  // Exercise the delivered navigation under file:// and recheck trusted IPC after every page.
  await waitFor(
    "document.querySelectorAll('nav button[data-route]').length===11 && !!document.querySelector('.metric')",
  );
  const routes = await window.webContents.executeJavaScript(
    "Array.from(document.querySelectorAll('nav button[data-route]')).map(b=>b.dataset.route)",
  );
  for (const route of routes) {
    await window.webContents.executeJavaScript(
      `document.querySelector('nav button[data-route="${route}"]').click()`,
    );
    await waitFor(
      `document.querySelector('nav button[aria-current=page]')?.dataset.route===${JSON.stringify(route)}`,
    );
    assert.equal(
      window.webContents.getURL(),
      renderer.href,
      "In-document navigation preserves the exact trusted IPC URL",
    );
    assert.ok(
      (await invoke("runtime.status", {})).ok,
      "Every route retains access to the sandboxed bridge",
    );
  }
  await window.webContents.executeJavaScript(
    "document.querySelector('nav button[data-route=overview]').click()",
  );
  await waitFor("!!document.querySelector('.metric')");
  for (const [width, height] of [
    [1160, 780],
    [780, 560],
  ]) {
    window.setSize(width, height);
    // The acceptance window is hidden; requestAnimationFrame can stay suspended there.
    await window.webContents.executeJavaScript(
      "new Promise(resolve=>setTimeout(resolve,50))",
    );
    assert.equal(
      await window.webContents.executeJavaScript(
        "document.documentElement.scrollWidth<=innerWidth+1",
      ),
      true,
      "Default/minimum Electron window must fit the renderer",
    );
  }
  window.setSize(1160, 780);
  const settings = await invoke("runtime.settings", {});
  assert.ok(settings.ok);
  const expected = phase === "write" ? 30 : 31;
  if (phase === "reopen")
    assert.equal(
      settings.value.retentionDays,
      30,
      "Actual settings survive Electron restart",
    );
  assert.ok(
    (
      await invoke("runtime.configure", {
        expectedRevision: settings.value.revision,
        settings: {
          trayEnabled: false,
          budgetTimeZone: "Asia/Shanghai",
          retentionDays: expected,
        },
      })
    ).ok,
  );
  const trayOn = await invoke("runtime.setTray", { enabled: true });
  assert.ok(trayOn.ok);
  assert.equal(trayOn.value.enabled, true);
  assert.ok((await invoke("runtime.setTray", { enabled: false })).ok);
  const snapshot = await invoke("workspace.snapshot", {});
  assert.ok(snapshot.ok);
  assert.equal(snapshot.value.totals.active, 0);
  assert.equal(
    (await invoke("runtime.status", { actor: { role: "system" } })).ok,
    false,
  );

  let acceptance;
  const statePath = join(directory, "case-state.json");
  if (phase === "write") {
    const connection = await invoke("connections.configure", {
      displayName: "Electron 合成连接",
      platformInstanceId: randomUUID(),
      alertsPattern: "wazuh-alerts-*",
      mappingVersion: "wazuh-alerts-v1",
    });
    assert.ok(connection.ok);
    await new Promise((resolve) => {
      window.webContents.once("did-finish-load", resolve);
      window.reload();
    });
    await waitFor(
      "Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='创建案件')",
    );
    await window.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='创建案件').click()",
    );
    await waitFor("!!document.querySelector('input[name=title]')");
    await window.webContents.executeJavaScript(`(()=>{
      const title=document.querySelector('input[name=title]'),form=title.form;
      title.value='Electron 合成案件：保存与重启';form.elements.agents.value='001';
      form.elements.from.value='2026-10-24T00:00:00.000Z';form.elements.to.value='2026-10-24T00:30:00.000Z';
      form.requestSubmit();
    })()`);
    await waitFor(
      "document.querySelector('.message')?.textContent==='案件已保存到本地主体空间。'",
    );
    await window.webContents.executeJavaScript(
      `(()=>{const text=document.querySelector('textarea[name=text]');text.value='Electron 页面保存的未核实背景';text.form.elements.sourceLabel.value='Electron 合成验收';text.form.requestSubmit();})()`,
    );
    await waitFor(
      "document.querySelector('.message')?.textContent==='背景版本已保存，作者来自当前主体。'",
    );
    const list = await invoke("cases.list", { page: { limit: 20 } });
    assert.ok(list.ok);
    const record = list.value.items.find(
      (item) => item.title === "Electron 合成案件：保存与重启",
    );
    assert.ok(record);
    assert.equal(record.revision, 2);
    acceptance = {
      caseId: record.id,
      connectionId: connection.value.id,
      scope: record.scope,
      expectedRevision: 3,
    };
    // Keep a dirty form while a second trusted IPC edit advances the case revision.
    await window.webContents.executeJavaScript(
      "document.querySelector('textarea[name=text]').value='冲突后必须保留的页面输入'",
    );
    assert.ok(
      (
        await invoke("cases.putContext", {
          caseId: record.id,
          expectedRevision: 2,
          context: {
            caseId: record.id,
            connectionId: record.scope.connectionId,
            agentIds: record.scope.agentIds,
            text: "另一位人员保存的背景",
            from: record.scope.from,
            to: record.scope.to,
            sourceLabel: "合成并发修改",
            verification: "unverified",
          },
        })
      ).ok,
    );
    await window.webContents.executeJavaScript(
      "document.querySelector('textarea[name=text]').form.requestSubmit()",
    );
    await waitFor(
      "document.querySelector('.error')?.textContent.startsWith('REVISION_CONFLICT：')",
    );
    assert.equal(
      await window.webContents.executeJavaScript(
        "document.querySelector('textarea[name=text]').value",
      ),
      "冲突后必须保留的页面输入",
    );
    await writeFile(statePath, JSON.stringify(acceptance, null, 2));
  } else {
    acceptance = JSON.parse(await readFile(statePath, "utf8"));
    const saved = await invoke("cases.snapshot", {
      caseId: acceptance.caseId,
      evidencePage: { limit: 20 },
    });
    assert.ok(saved.ok);
    assert.equal(saved.value.case.revision, acceptance.expectedRevision);
    assert.ok(
      saved.value.contexts.some(
        (context) => context.text === "Electron 页面保存的未核实背景",
      ),
    );
    assert.ok(
      saved.value.contexts.some(
        (context) => context.text === "另一位人员保存的背景",
      ),
    );
    await waitFor(
      "Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Electron 合成案件：保存与重启')",
    );
    await window.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Electron 合成案件：保存与重启').click()",
    );
    await waitFor(
      "document.getElementById('content')?.textContent.includes('Electron 页面保存的未核实背景')",
    );
    const conflict = await invoke("cases.setStatus", {
      caseId: acceptance.caseId,
      expectedRevision: 1,
      status: "investigating",
      reason: "过时版本必须失败",
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, "REVISION_CONFLICT");
  }
  const notReady = await invoke("requests.create", {
    origin: "client_user",
    connectionId: acceptance.connectionId,
    caseId: acceptance.caseId,
    question: "合成测试，不访问真实宿主",
    requestedScope: acceptance.scope,
    seedRefs: [],
    idempotencyKey: "electron-investigation-" + phase,
  });
  assert.ok(notReady.ok);
  assert.equal(notReady.value.job.state, "queued");
  const cancelled = await invoke("requests.cancel", {
    requestId: notReady.value.request.id,
    reason: "结束隔离验收，未提交模型",
  });
  assert.ok(cancelled.ok);
  assert.equal(cancelled.value.job.state, "cancelled");
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
        rendererRoutes: routes.length,
        fileNavigation: true,
        desktopSizes: true,
        sqlite: true,
        restartRead: phase === "reopen",
        tray: true,
        osProtection: true,
        controlledShutdown: true,
        retentionDays: expected,
        cases: true,
        caseRestartRead: phase === "reopen",
        revisionConflict: true,
        rendererCaseWorkflow: true,
        requestLifecycle: true,
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
