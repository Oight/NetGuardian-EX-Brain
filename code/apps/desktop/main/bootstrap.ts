import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  Tray,
} from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { idSchema, fail, ok, type Result } from "@campussec/contracts";
import { composeRuntime } from "../runtime/compose.js";
import { createIpcHandler } from "./ipc.js";
import { createSpaceController } from "../runtime/spaces.js";

async function localIdentity(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "identity.json");
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    if (
      Object.keys(value).sort().join(",") !==
        "identityEpoch,principalId,spaceId" ||
      !idSchema.safeParse(value.spaceId).success ||
      !idSchema.safeParse(value.principalId).success ||
      value.identityEpoch !== 1
    )
      throw new Error("Invalid local identity");
    return value as {
      spaceId: string;
      principalId: string;
      identityEpoch: number;
    };
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
    const value = {
      spaceId: randomUUID(),
      principalId: randomUUID(),
      identityEpoch: 1,
    };
    await writeFile(path, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    return value;
  }
}

export interface DesktopBootstrapOptions {
  /** Explicit local directory for isolated acceptance; normal launch uses app userData. */
  dataDir?: string;
  showWindow?: boolean;
}

/** The same production bootstrap is used by the real Electron acceptance runner. */
export async function bootstrapDesktop(options: DesktopBootstrapOptions = {}) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await app.whenReady();
  const dataDir = options.dataDir ?? join(app.getPath("userData"), "campussec");
  const identity = await localIdentity(dataDir);
  let window: BrowserWindow | undefined;
  let tray: Tray | undefined;
  let quitting = false;
  let checkingQuit = false;
  let trayEnabled = false;
  const rendererPath = fileURLToPath(
    new URL("../renderer/index.html", import.meta.url),
  );
  const documentUrl = pathToFileURL(rendererPath).href;
  function setTray(enabled: boolean): Promise<Result<void>> {
    try {
      if (enabled && !tray) {
        // A packaged, constant PNG; it never depends on model or platform content.
        const icon = nativeImage.createFromPath(
          fileURLToPath(new URL("../assets/tray.png", import.meta.url)),
        );
        tray = new Tray(icon);
        tray.setToolTip("校安智脑");
        tray.setContextMenu(
          Menu.buildFromTemplate([
            { label: "打开工作台", click: () => window?.show() },
            { label: "完全退出", click: () => app.quit() },
          ]),
        );
        tray.on("click", () => window?.show());
      }
      if (!enabled && tray) {
        tray.destroy();
        tray = undefined;
      }
      trayEnabled = enabled;
      return Promise.resolve(ok(undefined));
    } catch {
      trayEnabled = false;
      window?.show();
      return Promise.resolve(
        fail("HOST_UNAVAILABLE", "托盘不可用，窗口保持显示"),
      );
    }
  }
  const controller = createSpaceController((nextIdentity) =>
    composeRuntime({
      dataDir,
      ...nextIdentity,
      protection: {
        available: () =>
          safeStorage.isEncryptionAvailable() &&
          (process.platform !== "linux" ||
            safeStorage.getSelectedStorageBackend() !== "basic_text"),
        encrypt: (text) => safeStorage.encryptString(text),
        decrypt: (bytes) => safeStorage.decryptString(Buffer.from(bytes)),
      },
      setTray,
      async saveExport(value) {
        const result = await dialog.showSaveDialog({
          title: "导出交接材料",
          defaultPath: value.filename,
          filters: [
            {
              name:
                value.mediaType === "application/json" ? "JSON" : "Markdown",
              extensions: [
                value.mediaType === "application/json" ? "json" : "md",
              ],
            },
          ],
        });
        if (result.canceled || !result.filePath)
          return fail("CANCELLED", "已取消保存");
        try {
          await writeFile(result.filePath, value.text, {
            encoding: "utf8",
            mode: 0o600,
          });
          return ok(undefined);
        } catch {
          return fail("STORAGE_UNAVAILABLE", "导出写入失败");
        }
      },
    }),
  );
  const runtime = await controller.switchTo(identity);
  if (!runtime.ok) {
    dialog.showErrorBox("校安智脑无法启动", runtime.error.code);
    app.quit();
    return;
  }
  const currentSettings = await runtime.value.facade.invoke(
    runtime.value.context(),
    {
      protocolVersion: "0.1.0",
      requestId: randomUUID(),
      method: "runtime.settings",
      payload: {},
    },
  );
  if (currentSettings.result.ok)
    await setTray(currentSettings.result.value.trayEnabled);
  window = new BrowserWindow({
    width: 1160,
    height: 780,
    minWidth: 780,
    minHeight: 560,
    show: false,
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== documentUrl) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  const handler = createIpcHandler({
    windowId: window.webContents.id,
    documentUrl,
    context: runtime.value.context,
    ids: { next: () => randomUUID() },
    facade: runtime.value.facade,
  });
  ipcMain.handle("campussec:invoke", (event, input: unknown) =>
    handler(
      {
        senderId: event.sender.id,
        frameId: event.senderFrame?.routingId ?? -1,
        mainFrameId: event.sender.mainFrame.routingId,
        url: event.senderFrame?.url ?? "",
        destroyed: event.sender.isDestroyed(),
      },
      input,
    ),
  );
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (trayEnabled && tray) window?.hide();
    else app.quit();
  });
  window.once("ready-to-show", () => {
    if (options.showWindow !== false) window?.show();
  });
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });
  app.on("activate", () => window?.show());
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (checkingQuit) return;
    checkingQuit = true;
    void (async () => {
      try {
        const snapshot = await runtime.value.facade.invoke(
          runtime.value.context(),
          {
            protocolVersion: "0.1.0",
            requestId: randomUUID(),
            method: "workspace.snapshot",
            payload: {},
          },
        );
        if (!snapshot.result.ok) {
          dialog.showErrorBox("暂时无法安全退出", "请先核实本地任务状态");
          return;
        }
        if (snapshot.result.value.totals.active) {
          await dialog.showMessageBox({
            type: "warning",
            title: "仍有调查待核实",
            message:
              "请先等待调查结束，或在调查入口明确请求取消并核实。关闭应用不证明远端已经停止。",
            buttons: ["返回工作台"],
          });
          window?.show();
          return;
        }
        quitting = true;
        ipcMain.removeHandler("campussec:invoke");
        await controller.close();
        tray?.destroy();
        app.quit();
      } catch {
        quitting = false;
        dialog.showErrorBox("暂时无法安全退出", "关闭失败；请核实本地状态。");
        window?.show();
      } finally {
        checkingQuit = false;
      }
    })();
  });
  await window.loadFile(rendererPath);
  return { window, runtime: runtime.value, close: () => app.quit() };
}

// Importing this factory for acceptance does not launch a second application.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void bootstrapDesktop().catch(() => {
    dialog.showErrorBox("校安智脑无法启动", "初始化失败；已有数据保留。");
    app.quit();
  });
}
