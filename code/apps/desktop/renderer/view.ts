import type { DesktopApi } from "@campussec/contracts";
import { mountWorkbench } from "./app.js";
declare global {
  interface Window {
    campusSec?: DesktopApi;
  }
}
const element = document.getElementById("app")!;
if (window.campusSec) {
  const mounted = mountWorkbench({ element, api: window.campusSec });
  window.addEventListener("pagehide", () => mounted.unmount(), { once: true });
} else element.textContent = "桌面桥接不可用；静态页面不能访问本地案件。";
