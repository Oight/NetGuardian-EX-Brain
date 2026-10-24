import type {
  BusinessContext,
  CaseRecord,
  CaseSnapshot,
  DesktopApi,
  EvidenceRef,
  Scope,
} from "@campussec/contracts";
import { ApiError, createClient } from "./api.js";
const states: Record<CaseRecord["status"], string> = {
  pending: "待调查",
  investigating: "调查中",
  resolved: "已关闭",
  reopened: "已重开",
};
export function mountWorkbench(input: {
  element: HTMLElement;
  api: DesktopApi;
}): {
  unmount: () => void;
} {
  const { element, api } = input,
    doc = element.ownerDocument,
    invoke = createClient(api);
  let disposed = false,
    route = "",
    revision = 0,
    spaceId = "",
    afterSeq = 0,
    polling = false,
    selectedCase: CaseSnapshot | undefined;
  let connections: {
    id: string;
    displayName: string;
    generation: number;
  }[] = [];
  let listFilters: { text: string; status?: CaseRecord["status"] } | undefined;
  const cleanup: (() => void)[] = [];
  const node = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text?: string,
    className?: string,
  ) => {
    const value = doc.createElement(tag);
    if (text !== undefined) value.textContent = text;
    if (className) value.className = className;
    return value;
  };
  const button = (text: string, action: () => void, className = "") => {
    const b = node("button", text, className);
    b.type = "button";
    b.addEventListener("click", action);
    return b;
  };
  const message = node("p", "", "message");
  message.setAttribute("role", "status");
  const error = node("p", "", "error");
  error.setAttribute("role", "alert");
  const status = node("p", "正在读取本地主体空间…", "status");
  const totals = node("p");
  const content = node("section");
  content.id = "content";
  const nav = node("nav");
  nav.setAttribute("aria-label", "主导航");
  const title = node("h1", "校安智脑");
  const badge = node("span", "本地案件工作台", "eyebrow");
  const header = node("header");
  header.append(badge, title, status, totals);
  element.replaceChildren(header, nav, message, error, content);
  function report(reason: unknown) {
    if (disposed) return;
    error.textContent =
      reason instanceof ApiError
        ? `${reason.code}：${reason.message}`
        : reason instanceof Error
          ? reason.message
          : "操作失败";
    if (reason instanceof ApiError && reason.code === "REVISION_CONFLICT")
      message.textContent =
        "数据已有新版本。请重新读取并审阅后再次保存；当前输入已保留。";
  }
  async function run(
    b: HTMLButtonElement | undefined,
    action: () => Promise<void>,
  ) {
    if (disposed || b?.disabled) return;
    if (b) b.disabled = true;
    error.textContent = "";
    try {
      await action();
    } catch (reason) {
      report(reason);
    } finally {
      if (b && !disposed) b.disabled = false;
    }
  }
  function field(
    form: HTMLElement,
    label: string,
    name: string,
    value = "",
    type = "text",
    required = true,
  ) {
    const wrapper = node("label", label),
      control = type === "textarea" ? node("textarea") : node("input");
    control.name = name;
    control.value = value;
    control.required = required;
    if (control.tagName === "INPUT") (control as HTMLInputElement).type = type;
    wrapper.append(control);
    form.append(wrapper);
    return control;
  }
  const value = (form: HTMLFormElement, name: string) =>
    String(new FormData(form).get(name) ?? "").trim();
  function connectionSelect(form: HTMLElement, name = "connectionId") {
    const label = node("label", "连接"),
      select = node("select");
    select.name = name;
    select.required = true;
    for (const p of connections) {
      const option = node("option", p.displayName);
      option.value = p.id;
      select.append(option);
    }
    label.append(select);
    form.append(label);
    return select;
  }
  function scopeFields(form: HTMLElement, scope?: Scope) {
    connectionSelect(form);
    field(
      form,
      "设备 ID（逗号分隔，1—5 台）",
      "agents",
      scope?.agentIds.join(",") ?? "",
    );
    const to = new Date().toISOString(),
      from = new Date(Date.parse(to) - 1800000).toISOString();
    field(
      form,
      "开始时间（含时区的 ISO 时间，含起点）",
      "from",
      scope?.from ?? from,
    );
    field(
      form,
      "结束时间（含时区的 ISO 时间，不含终点）",
      "to",
      scope?.to ?? to,
    );
    field(form, "显示时区", "timeZone", scope?.timeZone ?? "Asia/Shanghai");
  }
  function formScope(form: HTMLFormElement): Scope {
    const from = value(form, "from"),
      to = value(form, "to"),
      agentIds = [
        ...new Set(
          value(form, "agents")
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean),
        ),
      ];
    if (
      !/(?:Z|[+-]\d\d:\d\d)$/.test(from) ||
      !/(?:Z|[+-]\d\d:\d\d)$/.test(to) ||
      !Number.isFinite(Date.parse(from)) ||
      !Number.isFinite(Date.parse(to))
    )
      throw new Error("时间必须包含明确时区");
    if (
      agentIds.length < 1 ||
      agentIds.length > 5 ||
      Date.parse(to) <= Date.parse(from) ||
      Date.parse(to) - Date.parse(from) > 3600000
    )
      throw new Error("请选择 1—5 台设备及不超过一小时的有效范围");
    const timeZone = value(form, "timeZone");
    try {
      new Intl.DateTimeFormat("zh-CN", { timeZone });
    } catch {
      throw new Error("时区无效");
    }
    return {
      connectionId: value(form, "connectionId"),
      agentIds,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      timeZone,
    };
  }
  function submit(
    form: HTMLFormElement,
    label: string,
    action: (button: HTMLButtonElement) => Promise<void>,
  ) {
    const b = node("button", label);
    b.type = "submit";
    form.append(b);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void run(b, () => action(b));
    });
    return b;
  }
  function begin(name: string) {
    route = name;
    revision++;
    selectedCase = undefined;
    error.textContent = "";
    message.textContent = "";
    content.replaceChildren();
    for (const b of Array.from(nav.querySelectorAll("button")))
      b.setAttribute(
        "aria-current",
        b.dataset.route === name ? "page" : "false",
      );
    return revision;
  }
  async function refresh() {
    const [runtime, snapshot] = await Promise.all([
      invoke("runtime.status", {}),
      invoke("workspace.snapshot", {}),
    ]);
    if (disposed) return;
    const changed = spaceId && spaceId !== runtime.spaceId;
    spaceId = runtime.spaceId;
    connections = snapshot.connections;
    afterSeq = snapshot.eventSeq;
    status.textContent = `${runtime.state === "degraded" ? "本地案件可用 · 调查能力待接入" : runtime.state === "ready" ? "就绪" : "正在停止"} · 主体空间 ${spaceId}`;
    totals.textContent = `${snapshot.totals.cases} 个案件 · ${snapshot.totals.queued} 个排队 · ${snapshot.totals.active} 个活动调查`;
    if (changed) {
      selectedCase = undefined;
      await showCases();
      message.textContent = "主体空间已改变，旧空间表单和缓存已清空。";
    }
  }
  async function showOverview() {
    const ticket = begin("overview");
    content.append(node("h2", "概览"));
    const snapshot = await invoke("workspace.snapshot", {});
    if (disposed || ticket !== revision) return;
    const list = node("ul");
    for (const c of snapshot.cases) {
      const li = node("li");
      li.append(
        button(c.title, () => void run(undefined, () => showCase(c.id))),
        node("span", ` ${states[c.status]} · 版本 ${c.revision}`),
      );
      list.append(li);
    }
    content.append(
      list,
      node("p", snapshot.cases.length ? "最近案件" : "当前主体空间没有案件。"),
    );
    content.append(button("创建案件", () => void showCreate()));
  }
  async function showCases(
    cursor?: string,
    filters?: {
      text: string;
      status?: CaseRecord["status"];
    },
  ) {
    listFilters = filters;
    const ticket = begin("cases");
    content.append(node("h2", "案件"));
    const search = node("form");
    field(search, "检索标题", "text", filters?.text ?? "", "text", false);
    const select = node("select");
    select.name = "status";
    for (const [id, label] of [["", "全部状态"], ...Object.entries(states)]) {
      const option = node("option", label);
      option.value = id!;
      select.append(option);
    }
    select.value = filters?.status ?? "";
    search.append(select);
    submit(search, "检索", async () =>
      showCases(undefined, {
        text: value(search, "text"),
        ...(value(search, "status")
          ? { status: value(search, "status") as CaseRecord["status"] }
          : {}),
      }),
    );
    content.append(
      search,
      button("创建案件", () => void showCreate()),
    );
    const result = await invoke("cases.list", {
      ...(filters?.text ? { text: filters.text } : {}),
      ...(filters?.status ? { status: filters.status } : {}),
      page: { limit: 20, ...(cursor ? { cursor } : {}) },
    });
    if (disposed || ticket !== revision) return;
    const list = node("ul");
    for (const c of result.items) {
      const li = node("li");
      li.append(
        button(c.title, () => void run(undefined, () => showCase(c.id))),
        node(
          "span",
          ` ${states[c.status]} · 版本 ${c.revision} · ${c.updatedAt}`,
        ),
      );
      list.append(li);
    }
    content.append(list);
    if (!result.items.length) content.append(node("p", "没有匹配案件。"));
    if (result.nextCursor)
      content.append(
        button(
          "下一页",
          () =>
            void run(undefined, () => showCases(result.nextCursor, filters)),
        ),
      );
  }
  async function showCreate() {
    begin("cases");
    content.append(node("h2", "创建案件"));
    if (!connections.length) {
      content.append(
        node("p", "请先在设置中保存连接。保存连接不需要访问真实平台。"),
        button("前往设置", () => void run(undefined, showSettings)),
      );
      return;
    }
    const form = node("form");
    field(form, "案件标题", "title");
    scopeFields(form);
    submit(form, "保存案件", async () => {
      const result = await invoke("cases.create", {
        title: value(form, "title"),
        scope: formScope(form),
        seedRefs: [],
      });
      await refresh();
      await showCase(result.id);
      message.textContent = "案件已保存到本地主体空间。";
    });
    content.append(form);
  }
  async function showCase(id: string, evidenceCursor?: string) {
    const ticket = begin("cases");
    content.append(node("h2", "案件详情"));
    const snapshot = await invoke("cases.snapshot", {
      caseId: id,
      evidencePage: {
        limit: 20,
        ...(evidenceCursor ? { cursor: evidenceCursor } : {}),
      },
    });
    if (disposed || ticket !== revision) return;
    selectedCase = snapshot;
    const c = snapshot.case;
    content.replaceChildren(
      node("h2", c.title),
      node(
        "p",
        `${states[c.status]} · 版本 ${c.revision} · ${c.scope.agentIds.join("、")} · ${c.scope.from} ≤ 时间 < ${c.scope.to}`,
      ),
      button("重新读取并审阅", () => void run(undefined, () => showCase(id))),
    );
    if (c.latestReportId && c.latestReportId !== c.currentReportId)
      content.append(
        node("p", "有基于旧输入的历史候选；当前材料未被该候选覆盖。", "notice"),
      );
    const statusForm = node("form");
    const select = node("select");
    select.name = "status";
    const transitions: Record<CaseRecord["status"], CaseRecord["status"][]> = {
      pending: ["investigating"],
      investigating: ["pending", "resolved"],
      resolved: ["reopened"],
      reopened: ["investigating", "resolved"],
    };
    for (const target of transitions[c.status]) {
      const option = node("option", states[target]);
      option.value = target;
      select.append(option);
    }
    statusForm.append(node("h3", "人工状态变更"), select);
    field(statusForm, "变更或关闭理由", "reason");
    submit(statusForm, "保存状态", async () => {
      await invoke("cases.setStatus", {
        caseId: id,
        expectedRevision: c.revision,
        status: value(statusForm, "status") as CaseRecord["status"],
        reason: value(statusForm, "reason"),
      });
      await refresh();
      await showCase(id);
      message.textContent = "状态和审计记录已保存。";
    });
    content.append(statusForm);
    const refs: EvidenceRef[] = [];
    const materials = node("section");
    materials.append(node("h3", "证据与来源"));
    for (const e of snapshot.evidence) {
      const wrapper = node("div", undefined, "record"),
        checkbox = node("input");
      checkbox.type = "checkbox";
      checkbox.setAttribute("aria-label", `选择材料 ${e.id} 版本 ${e.version}`);
      checkbox.addEventListener("change", () => {
        const i = refs.findIndex(
          (r) => r.evidenceId === e.id && r.version === e.version,
        );
        if (checkbox.checked && i < 0)
          refs.push({ evidenceId: e.id, version: e.version });
        else if (!checkbox.checked && i >= 0) refs.splice(i, 1);
      });
      wrapper.append(
        checkbox,
        node(
          "p",
          `${e.kind} · ${e.availability === "expired" ? "正文已过期，保留引用缺口" : (e.observedAt ?? "观察时间未知")} · 取得时间 ${e.retrievedAt}`,
        ),
        button(
          "查看原始材料",
          () =>
            void run(undefined, async () => {
              const result = await invoke("evidence.get", {
                caseId: id,
                ref: { evidenceId: e.id, version: e.version },
              });
              const details = node(
                "pre",
                JSON.stringify(result.evidence, null, 2),
              );
              wrapper.append(details);
            }),
        ),
      );
      materials.append(wrapper);
    }
    if (!snapshot.evidence.length)
      materials.append(
        node("p", "当前案件没有已附入的观测证据。人工背景单独列示。"),
      );
    if (snapshot.nextEvidenceCursor)
      materials.append(
        button(
          "下一页材料",
          () =>
            void run(undefined, () =>
              showCase(id, snapshot.nextEvidenceCursor),
            ),
        ),
      );
    const move = node("form");
    field(move, "目标案件 ID", "target");
    field(move, "目标案件版本", "targetRevision", "", "number");
    field(move, "移动理由", "reason");
    submit(move, "移动所选材料", async () => {
      await invoke("cases.moveEvidence", {
        sourceCaseId: id,
        targetCaseId: value(move, "target"),
        sourceRevision: c.revision,
        targetRevision: Number(value(move, "targetRevision")),
        refs,
        reason: value(move, "reason"),
      });
      await refresh();
      await showCase(id);
    });
    materials.append(move);
    content.append(materials);
    content.append(node("h3", "查询覆盖"));
    for (const query of snapshot.queries)
      content.append(
        node(
          "p",
          `${query.coverage.queryCompleteness} · 采集覆盖 ${query.coverage.collectionCoverage} · ${query.coverage.returned} 条 · ${query.coverage.reasons.join("；") || "无额外查询缺口"}`,
        ),
      );
    const background = node("section");
    background.append(node("h3", "人工背景（不等同于观测证据）"));
    for (const context of snapshot.contexts) {
      const row = node("article");
      row.append(
        node(
          "p",
          `${context.text} · ${context.verification} · 来源 ${context.sourceLabel} · 版本 ${context.version}`,
        ),
        button("编辑此背景", () => editContext(context)),
      );
      background.append(row);
    }
    const holder = node("div");
    background.append(holder);
    content.append(background);
    function editContext(existing?: BusinessContext) {
      holder.replaceChildren();
      const form = node("form");
      field(form, "背景正文", "text", existing?.text ?? "", "textarea");
      field(
        form,
        "信息来源",
        "sourceLabel",
        existing?.sourceLabel ?? "人工提供",
      );
      field(form, "有效开始时间", "from", existing?.from ?? c.scope.from);
      field(form, "有效结束时间", "to", existing?.to ?? c.scope.to);
      field(
        form,
        "部门",
        "department",
        existing?.department ?? "",
        "text",
        false,
      );
      field(form, "用途", "purpose", existing?.purpose ?? "", "text", false);
      const verification = node("select");
      verification.name = "verification";
      for (const [id, label] of [
        ["unverified", "未核实"],
        ["verified", "人工已核实"],
        ["rejected", "已否定"],
      ]) {
        const option = node("option", label);
        option.value = id!;
        verification.append(option);
      }
      verification.value = existing?.verification ?? "unverified";
      form.append(verification);
      submit(form, "保存背景版本", async () => {
        const from = value(form, "from"),
          to = value(form, "to");
        if (
          !/(?:Z|[+-]\d\d:\d\d)$/.test(from) ||
          !/(?:Z|[+-]\d\d:\d\d)$/.test(to)
        )
          throw new Error("背景有效期必须包含时区");
        await invoke("cases.putContext", {
          caseId: id,
          expectedRevision: c.revision,
          ...(existing ? { contextId: existing.id } : {}),
          context: {
            caseId: id,
            connectionId: c.scope.connectionId,
            agentIds: c.scope.agentIds,
            text: value(form, "text"),
            sourceLabel: value(form, "sourceLabel"),
            from: new Date(from).toISOString(),
            to: new Date(to).toISOString(),
            verification: value(
              form,
              "verification",
            ) as BusinessContext["verification"],
            ...(value(form, "department")
              ? { department: value(form, "department") }
              : {}),
            ...(value(form, "purpose")
              ? { purpose: value(form, "purpose") }
              : {}),
          },
        });
        await refresh();
        await showCase(id);
        message.textContent = "背景版本已保存，作者来自当前主体。";
      });
      holder.append(form);
    }
    editContext();
    const investigate = node("form");
    field(investigate, "调查问题", "question", "", "textarea");
    let frozen:
      | {
          question: string;
          idempotencyKey: string;
        }
      | undefined;
    submit(investigate, "发起调查", async () => {
      const question = value(investigate, "question");
      if (!frozen || frozen.question !== question)
        frozen = { question, idempotencyKey: crypto.randomUUID() };
      const request = await invoke("requests.create", {
        origin: "client_user",
        connectionId: c.scope.connectionId,
        question,
        requestedScope: c.scope,
        seedRefs: [],
        caseId: c.id,
        idempotencyKey: frozen.idempotencyKey,
      });
      message.textContent = `请求 ${request.request.id}：${request.request.state}。任务受理不代表调查完成。`;
    });
    content.append(
      node("h3", "调查"),
      node("p", "宿主和调查模块未就绪时会明确返回不可用，表单内容保留。"),
      investigate,
    );
    const history = node("div");
    content.append(
      history,
      button(
        "读取报告历史",
        () =>
          void run(undefined, async () => {
            const reports = await invoke("reports.list", { caseId: id });
            history.replaceChildren(
              ...reports.map((report) =>
                node("pre", JSON.stringify(report, null, 2)),
              ),
            );
            if (!reports.length) history.append(node("p", "没有报告历史。"));
          }),
      ),
    );
  }
  async function showDevices() {
    const ticket = begin("devices");
    content.append(node("h2", "设备与能力"));
    const form = node("form");
    connectionSelect(form);
    submit(form, "读取设备", async () => {
      const result = await invoke("connections.agents", {
        connectionId: value(form, "connectionId"),
        page: { limit: 50 },
      });
      if (disposed || ticket !== revision) return;
      const list = node("div");
      for (const agent of result.items)
        list.append(
          node(
            "p",
            `${agent.id} · ${agent.name ?? "名称未知"} · ${agent.status ?? "状态未知"}`,
          ),
        );
      content.append(
        list,
        node(
          "p",
          result.nextCursor
            ? "仅展示第一页，列表尚未完整"
            : "本次设备列表读取完成",
        ),
      );
    });
    content.append(form);
  }
  async function showAlerts() {
    const ticket = begin("alerts");
    content.append(node("h2", "告警收件箱"));
    if (!connections.length) {
      content.append(node("p", "请先配置连接。"));
      return;
    }
    const result = await invoke("alerts.list", {
      connectionId: connections[0]!.id,
      page: { limit: 20 },
    });
    if (disposed || ticket !== revision) return;
    for (const alert of result.items)
      content.append(node("pre", JSON.stringify(alert, null, 2)));
    if (!result.items.length) content.append(node("p", "没有匹配告警。"));
  }
  async function showFollowups() {
    const ticket = begin("followups");
    content.append(node("h2", "人工核查"));
    const result = await invoke("followups.search", { page: { limit: 20 } });
    if (disposed || ticket !== revision) return;
    for (const item of result.items)
      content.append(node("pre", JSON.stringify(item, null, 2)));
    if (!result.items.length) content.append(node("p", "没有匹配核查事项。"));
  }
  async function showSettings() {
    const ticket = begin("settings");
    content.append(node("h2", "连接与运行设置"));
    const settings = await invoke("runtime.settings", {});
    const host = await invoke("runtime.status", {});
    if (disposed || ticket !== revision) return;
    const runtime = node("form"),
      tray = field(
        runtime,
        "关闭窗口后驻留托盘",
        "tray",
        "",
        "checkbox",
        false,
      ) as HTMLInputElement;
    tray.checked = settings.trayEnabled;
    field(runtime, "预算日历时区", "budgetTimeZone", settings.budgetTimeZone);
    field(
      runtime,
      "每日总 token 上限（空白表示未配置）",
      "tokenLimit",
      settings.dailyTotalTokenLimit?.toString() ?? "",
      "number",
      false,
    );
    field(
      runtime,
      "证据保留天数（空白表示未配置）",
      "retentionDays",
      settings.retentionDays?.toString() ?? "",
      "number",
      false,
    );
    submit(runtime, "保存运行设置", async () => {
      await invoke("runtime.configure", {
        expectedRevision: settings.revision,
        settings: {
          trayEnabled: tray.checked,
          budgetTimeZone: value(runtime, "budgetTimeZone"),
          ...(value(runtime, "tokenLimit")
            ? { dailyTotalTokenLimit: Number(value(runtime, "tokenLimit")) }
            : {}),
          ...(value(runtime, "retentionDays")
            ? { retentionDays: Number(value(runtime, "retentionDays")) }
            : {}),
          ...(settings.evidenceMaxBytes !== undefined
            ? { evidenceMaxBytes: settings.evidenceMaxBytes }
            : {}),
        },
      });
      await showSettings();
      message.textContent = "设置已保存。保存设置不会自动清理证据。";
    });
    content.append(runtime);
    content.append(node("h3", "宿主能力核实状态"));
    for (const capability of host.hostCapabilities)
      content.append(
        node(
          "p",
          `${capability.name}：${capability.state} · ${capability.evidence}`,
        ),
      );
    const form = node("form");
    field(form, "连接名称", "displayName");
    field(
      form,
      "平台实例 ID（UUID）",
      "platformInstanceId",
      crypto.randomUUID(),
    );
    field(
      form,
      "Indexer HTTPS 入口（可暂不配置）",
      "indexerBaseUrl",
      "",
      "url",
      false,
    );
    field(
      form,
      "Server HTTPS 入口（可暂不配置）",
      "serverBaseUrl",
      "",
      "url",
      false,
    );
    field(form, "告警索引模式", "alertsPattern", "wazuh-alerts-*");
    field(form, "映射版本", "mappingVersion", "wazuh-alerts-v1");
    submit(form, "保存新连接", async () => {
      await invoke("connections.configure", {
        platformInstanceId: value(form, "platformInstanceId"),
        displayName: value(form, "displayName"),
        alertsPattern: value(form, "alertsPattern"),
        mappingVersion: value(form, "mappingVersion"),
        ...(value(form, "indexerBaseUrl")
          ? { indexerBaseUrl: value(form, "indexerBaseUrl") }
          : {}),
        ...(value(form, "serverBaseUrl")
          ? { serverBaseUrl: value(form, "serverBaseUrl") }
          : {}),
      });
      await refresh();
      await showSettings();
      message.textContent = "连接已保存；尚未探测平台权限。";
    });
    content.append(node("h3", "新增连接"), form);
    for (const connection of connections) {
      const row = node("article");
      row.append(
        node("h3", `${connection.displayName} · 代次 ${connection.generation}`),
      );
      const facts = node("div");
      row.append(
        facts,
        button(
          "读取本地能力状态",
          () =>
            void run(undefined, async () => {
              const result = await invoke("connections.capabilities", {
                connectionId: connection.id,
                refresh: false,
              });
              facts.replaceChildren(
                ...result.map((v) =>
                  node("p", `${v.name}：${v.state} · ${v.evidence}`),
                ),
              );
            }),
        ),
      );
      content.append(row);
    }
    content.append(
      node(
        "p",
        "真实平台探测、凭据配置和桌面安装包验收需按协作环境执行。本机不自动连接平台；未知用量保持未知。",
      ),
    );
  }
  for (const [name, label, action] of [
    ["overview", "概览", showOverview],
    ["alerts", "告警", showAlerts],
    ["devices", "设备", showDevices],
    ["cases", "案件", showCases],
    ["followups", "核查", showFollowups],
    ["settings", "设置", showSettings],
  ] as const) {
    const b = button(label, () => void run(undefined, () => action()));
    b.dataset.route = name;
    nav.append(b);
  }
  void run(undefined, async () => {
    await refresh();
    await showCases();
  });
  const timer = setInterval(() => {
    if (disposed || polling) return;
    polling = true;
    void invoke("events.read", { afterSeq, limit: 200 })
      .then(async (batch) => {
        if (disposed) return;
        if (batch.resetRequired) {
          const caseId = selectedCase?.case.id,
            oldSpace = spaceId;
          selectedCase = undefined;
          await refresh();
          if (route === "cases" && oldSpace === spaceId) {
            if (caseId) await showCase(caseId);
            else await showCases(undefined, listFilters);
            message.textContent =
              "事件记录已重置，已重新读取当前案件数据，请重新审阅。";
          }
          return;
        }
        if (batch.events.length) {
          afterSeq = Math.max(afterSeq, ...batch.events.map((e) => e.seq));
          if (
            selectedCase &&
            batch.events.some(
              (e) =>
                e.type === "case.changed" &&
                e.payload.caseId === selectedCase?.case.id &&
                e.payload.revision !== selectedCase.case.revision,
            )
          )
            message.textContent =
              "当前案件有新版本；输入已保留，请重新读取并审阅后保存。";
          const runtime = await invoke("runtime.status", {});
          if (runtime.spaceId !== spaceId) await refresh();
          else if (
            !selectedCase &&
            route === "cases" &&
            batch.events.some((e) => e.type === "case.changed")
          ) {
            const editing =
              content.contains(doc.activeElement) &&
              ["INPUT", "TEXTAREA", "SELECT"].includes(
                doc.activeElement?.tagName ?? "",
              );
            if (editing)
              message.textContent =
                "案件列表有更新，当前检索输入已保留；提交检索可读取新数据。";
            else await showCases(undefined, listFilters);
          }
        }
      })
      .catch(report)
      .finally(() => {
        polling = false;
      });
  }, 1000);
  cleanup.push(() => clearInterval(timer));
  return {
    unmount() {
      if (disposed) return;
      disposed = true;
      revision++;
      selectedCase = undefined;
      connections = [];
      for (const stop of cleanup) stop();
      element.replaceChildren();
    },
  };
}
