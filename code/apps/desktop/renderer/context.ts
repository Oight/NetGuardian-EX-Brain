import type {
  DesktopMethodMap,
  EvidenceRef,
  Scope,
  WorkspaceSnapshot,
} from "@campussec/contracts";
import type { createClient } from "./api.js";
import type { Ui } from "./ui.js";

export type Route =
  | "overview"
  | "alerts"
  | "cases"
  | "requests"
  | "devices"
  | "business"
  | "followups"
  | "reports"
  | "connections"
  | "architecture"
  | "settings";
export interface Page {
  body: HTMLElement;
  valid(): boolean;
}
export interface WorkbenchContext {
  ui: Ui;
  invoke: ReturnType<typeof createClient>;
  begin(route: Route, title?: string, description?: string): Page;
  connections(): WorkspaceSnapshot["connections"];
  workspace(): WorkspaceSnapshot | undefined;
  refresh(): Promise<void>;
  run(
    button: HTMLButtonElement | undefined,
    action: () => Promise<void>,
  ): Promise<void>;
  notify(text: string): void;
  submit(
    form: HTMLFormElement,
    label: string,
    action: () => Promise<void>,
  ): HTMLButtonElement;
  value(form: HTMLFormElement, name: string): string;
  scopeFields(form: HTMLElement, scope?: Scope, maximumMinutes?: number): void;
  readScope(form: HTMLFormElement, maximumMinutes?: number): Scope;
  connectionSelect(form: HTMLElement, selected?: string): HTMLSelectElement;
  dialog(
    title: string,
    description?: string,
  ): { body: HTMLElement; close(): void; valid(): boolean };
  openCase(id: string): Promise<void>;
  openCreate(scope?: Scope, refs?: EvidenceRef[]): void;
  openInvestigation(scope?: Scope, caseId?: string, refs?: EvidenceRef[]): void;
  openReports(caseId?: string): Promise<void>;
  openFollowups(caseId?: string): Promise<void>;
  navigate(route: Route): Promise<void>;
}
export type Output<K extends keyof DesktopMethodMap> =
  DesktopMethodMap[K]["output"];
