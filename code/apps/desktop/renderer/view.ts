import type { DesktopApi, DesktopMethodMap } from "@campussec/contracts";

declare global {
  interface Window {
    campusSec?: DesktopApi;
  }
}
const element = (id: string) => document.getElementById(id)!;
let afterSeq = 0;
let busy = false;
let disposed = false;
async function invoke<K extends keyof DesktopMethodMap>(
  method: K,
  payload: DesktopMethodMap[K]["input"],
) {
  if (!window.campusSec)
    throw new Error("桌面桥接不可用；浏览器静态预览不能访问本地数据库");
  const response = await window.campusSec.invoke({
    protocolVersion: "0.1.0",
    requestId: crypto.randomUUID(),
    method,
    payload,
  });
  if (!response.result.ok) throw new Error(response.result.error.message);
  return response.result.value;
}
async function refresh() {
  const [runtime, snapshot] = await Promise.all([
    invoke("runtime.status", {}),
    invoke("workspace.snapshot", {}),
  ]);
  if (disposed) return;
  element("status").textContent =
    `${runtime.state === "degraded" ? "本地可用 · 调查能力待接入" : runtime.state === "ready" ? "就绪" : "正在退出"} · 主体空间 ${runtime.spaceId}`;
  element("totals").textContent =
    `${snapshot.totals.cases} 个案件　 ${snapshot.totals.queued} 个排队　 ${snapshot.totals.active} 个活动调查`;
  element("cases").replaceChildren(
    ...snapshot.cases.map((item) => {
      const li = document.createElement("li");
      li.textContent = `${item.title} · ${item.status} · 版本 ${item.revision}`;
      return li;
    }),
  );
  element("empty").textContent = snapshot.totals.cases
    ? ""
    : "当前主体空间尚无案件。案件创建功能等待 S06 接入。";
  (element("tray") as HTMLInputElement).checked = runtime.trayEnabled;
  element("capabilities").replaceChildren(
    ...runtime.hostCapabilities.map((capability) => {
      const li = document.createElement("li");
      li.textContent = `${capability.name}：${capability.state}`;
      return li;
    }),
  );
  afterSeq = snapshot.eventSeq;
}
(element("tray") as HTMLInputElement).addEventListener(
  "change",
  async (event) => {
    const input = event.target as HTMLInputElement;
    input.disabled = true;
    try {
      await invoke("runtime.setTray", { enabled: input.checked });
      element("error").textContent = "";
    } catch (error) {
      element("error").textContent = (error as Error).message;
      input.checked = !input.checked;
    } finally {
      input.disabled = false;
    }
  },
);
void refresh().catch((error) => {
  element("error").textContent = (error as Error).message;
  element("status").textContent = "尚未连接桌面业务核心";
  element("empty").textContent = "无可读取的案件数据";
});
const timer = setInterval(() => {
  if (busy || disposed || !window.campusSec) return;
  busy = true;
  void invoke("events.read", { afterSeq, limit: 200 })
    .then(async (batch) => {
      if (batch.resetRequired || batch.events.length) await refresh();
    })
    .catch((error) => {
      element("error").textContent = (error as Error).message;
    })
    .finally(() => {
      busy = false;
    });
}, 1000);
window.addEventListener(
  "pagehide",
  () => {
    disposed = true;
    clearInterval(timer);
  },
  { once: true },
);
