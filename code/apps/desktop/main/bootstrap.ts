import { prepareCampusConnection } from "../runtime/campus-connection.js";
import { createAuthentication } from "./authentication.js";
import { createAuthController } from "./auth-controller.js";
import { trustedIpcSource } from "./ipc.js";
import { createCampusProxy } from "@campussec/wazuh-adapter";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
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
export interface DesktopBootstrapOptions {
  /** Explicit local directory for isolated acceptance; normal launch uses app userData. */
  dataDir?: string;
  showWindow?: boolean;
  backgroundEnabled?: boolean;
  /** Explicitly opt in to the existing local proxy; no credential transfer. */
  campusProxy?: boolean;
}
/** The same production bootstrap is used by the real Electron acceptance runner. */
export async function bootstrapDesktop(options: DesktopBootstrapOptions = {}) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await app.whenReady();
  const dataDir = options.dataDir ?? join(app.getPath("userData"), "campussec");
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
  let currentToken: string | undefined;
  let activeRuntime:
    | Extract<
        Awaited<ReturnType<typeof composeRuntime>>,
        {
          ok: true;
        }
      >["value"]
    | undefined;
  const controller = createAuthController({
    authentication: await createAuthentication({
      directory: join(dataDir, "auth"),
    }),
    outerProtection: {
      available: () =>
        safeStorage.isEncryptionAvailable() &&
        (process.platform !== "linux" ||
          safeStorage.getSelectedStorageBackend() !== "basic_text"),
      encrypt: (text) => safeStorage.encryptString(text),
      decrypt: (bytes) => safeStorage.decryptString(Buffer.from(bytes)),
    },
    open: async (account, protection, databaseProtection) => {
      const opened = await composeRuntime({
        dataDir,
        spaceId: account.spaceId,
        principalId: account.id,
        identityEpoch: 1,
        protection,
        databaseProtection,
        backgroundEnabled: options.backgroundEnabled,
        externalPlatform: options.campusProxy ? createCampusProxy() : undefined,
        notification: {
          show: async (input) => {
            if (!Notification.isSupported())
              return fail("CAPABILITY_UNAVAILABLE", "当前系统不支持桌面通知");
            return new Promise((resolve) => {
              const n = new Notification({
                title: input.title,
                body: input.body,
              });
              let completed = false;
              const done = (shown: boolean) => {
                if (completed) return;
                completed = true;
                clearTimeout(timer);
                resolve(ok({ shown }));
              };
              const timer = setTimeout(() => done(false), 5000);
              n.once("show", () => done(true));
              n.once("failed", () => done(false));
              n.on("click", () => window?.show());
              n.show();
            });
          },
        },
        setTray,
        saveExport: async (value) => {
          if (!currentToken) return fail("UNAUTHENTICATED", "请先登录");
          const encrypted = controller.encryptExport(currentToken, value);
          const result = await dialog.showSaveDialog({
            title: "导出加密交接材料",
            defaultPath: encrypted.filename,
            filters: [
              { name: "NetGuardian 加密交接文件", extensions: ["ngenc"] },
            ],
          });
          if (result.canceled || !result.filePath)
            return fail("CANCELLED", "已取消保存");
          try {
            await writeFile(result.filePath, encrypted.text, {
              encoding: "utf8",
              mode: 0o600,
            });
            return ok(undefined);
          } catch {
            return fail("STORAGE_UNAVAILABLE", "导出写入失败");
          }
        },
      });
      if (opened.ok && options.campusProxy) {
        const prepared = await prepareCampusConnection(opened.value);
        if (!prepared.ok) {
          await opened.value.close();
          return prepared;
        }
      }
      if (opened.ok) activeRuntime = opened.value;
      return opened;
    },
  });
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
  const trusted = (event: Electron.IpcMainInvokeEvent) =>
    trustedIpcSource(
      {
        senderId: event.sender.id,
        frameId: event.senderFrame?.routingId ?? -1,
        mainFrameId: event.sender.mainFrame.routingId,
        url: event.senderFrame?.url ?? "",
        destroyed: event.sender.isDestroyed(),
      },
      { windowId: window!.webContents.id, documentUrl },
    );
  ipcMain.handle("campussec:invoke", (event, input: unknown) =>
    trusted(event)
      ? controller.invoke(currentToken, input)
      : {
          protocolVersion: "0.1.0",
          requestId: randomUUID(),
          result: fail("FORBIDDEN", "IPC 来源无效"),
        },
  );
  ipcMain.handle("campussec:auth", async (event, input: unknown) => {
    if (!trusted(event)) return fail("FORBIDDEN", "IPC 来源无效");
    const result = await controller.authenticate(currentToken, input);
    if (result.token) currentToken = result.token;
    if (result.clearCookie) {
      currentToken = undefined;
      activeRuntime = undefined;
      await setTray(false);
    }
    if (result.token && activeRuntime) {
      const settings = await activeRuntime.facade.invoke(
        activeRuntime.context(),
        {
          protocolVersion: "0.1.0",
          requestId: randomUUID(),
          method: "runtime.settings",
          payload: {},
        },
      );
      if (settings.result.ok) await setTray(settings.result.value.trayEnabled);
    }
    return result.result;
  });
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
        const snapshot =
          activeRuntime && controller.auth.validate(currentToken).ok
            ? await activeRuntime.facade.invoke(activeRuntime.context(), {
                protocolVersion: "0.1.0",
                requestId: randomUUID(),
                method: "workspace.snapshot",
                payload: {},
              })
            : undefined;
        if (snapshot && !snapshot.result.ok) {
          dialog.showErrorBox("暂时无法安全退出", "请先核实本地任务状态");
          return;
        }
        if (snapshot?.result.ok && snapshot.result.value.totals.active) {
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
        ipcMain.removeHandler("campussec:auth");
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
  return {
    window,
    get runtime() {
      if (!activeRuntime) throw Error("Sign in before accessing runtime");
      return activeRuntime;
    },
    close: () => app.quit(),
  };
}
// Importing this factory for acceptance does not launch a second application.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void bootstrapDesktop({
    campusProxy: process.argv.includes("--campus-proxy"),
  }).catch(() => {
    dialog.showErrorBox("校安智脑无法启动", "初始化失败；已有数据保留。");
    app.quit();
  });
}
