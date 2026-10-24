import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "@campussec/contracts" with { "resolution-mode": "import" };

// The sandboxed preload has no filesystem, platform, SQL or general IPC escape hatch.
const api: DesktopApi = {
  invoke: (request) => ipcRenderer.invoke("campussec:invoke", request),
};
contextBridge.exposeInMainWorld("campusSec", Object.freeze(api));
