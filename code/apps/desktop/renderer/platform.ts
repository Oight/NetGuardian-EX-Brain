import type {
  AgentSummary,
  DeviceDetailInput,
  EvidenceRef,
  InboxAlert,
  Scope,
} from "@campussec/contracts";
import type { WorkbenchContext } from "./context.js";
import {
  absoluteWindow,
  capabilityNames,
  formatTime,
  scopeForAlerts,
  stateText,
} from "./model.js";

const categories: [DeviceDetailInput["category"], string][] = [
  ["os", "操作系统"],
  ["hardware", "硬件"],
  ["packages", "软件包"],
  ["processes", "进程"],
  ["ports", "端口"],
  ["fim_objects", "文件基线"],
  ["sca", "配置评估"],
];
export function createPlatformViews(ctx: WorkbenchContext) {
  const { ui, invoke, begin, run, submit, value, dialog } = ctx;
  const {
    el,
    card,
    button,
    field,
    select,
    table,
    empty,
    notice,
    state,
    facts,
    disclosure,
  } = ui;
  function deviceScope(connectionId: string, agentId: string): Scope {
    return {
      connectionId,
      agentIds: [agentId],
      ...absoluteWindow(30),
      timeZone: "Asia/Shanghai",
    };
  }
  function deviceDialog(connectionId: string, agent: AgentSummary) {
    const modal = dialog(
      agent.name ?? `Agent ${agent.id}`,
      "采集信息是最近一次平台快照，页面刷新不会把旧扫描变成实时观测。",
    );
    modal.body.append(
      facts([
        ["设备 ID", agent.id],
        ["连接状态", stateText(agent.status ?? "unknown")],
        ["Agent 版本", agent.version ?? "未知"],
      ]),
    );
    const actions = el("div", undefined, "actions");
    actions.append(
      button(
        "以此设备建案",
        () => ctx.openCreate(deviceScope(connectionId, agent.id)),
        "button secondary",
        "cases",
      ),
      button(
        "调查此设备",
        () => ctx.openInvestigation(deviceScope(connectionId, agent.id)),
        "button primary",
        "requests",
      ),
    );
    modal.body.append(actions);
    const tabs = el("div", undefined, "tab-bar");
    tabs.setAttribute("role", "group");
    tabs.setAttribute("aria-label", "采集类别");
    const result = el("div");
    let generation = 0;
    async function load(
      category: DeviceDetailInput["category"],
      cursor?: string,
    ) {
      const ticket = ++generation;
      for (const b of Array.from(
        tabs.querySelectorAll<HTMLButtonElement>("button"),
      ))
        b.setAttribute("aria-pressed", String(b.dataset.category === category));
      const loading = el("p", "正在读取最近采集快照…", "loading");
      result.append(loading);
      try {
        const data = await invoke("devices.detail", {
          connectionId,
          agentId: agent.id,
          category,
          page: { limit: 20, ...(cursor ? { cursor } : {}) },
        });
        if (!modal.valid() || ticket !== generation) return;
        result.replaceChildren(
          state(data.status),
          el(
            "p",
            `取得时间 ${formatTime(data.retrievedAt)} · ${data.total ? `${data.total.value}${data.total.relation === "gte" ? "+" : ""} 项` : "总量未知"}`,
            "small muted",
          ),
        );
        if (data.warnings.length)
          result.append(notice(data.warnings.join("；"), "warning"));
        if (data.items.length) {
          const fields = [
              ...new Set(
                data.items.flatMap((item) => Object.keys(item.fields)),
              ),
            ].slice(0, 6),
            grid = table([...fields, "观察时间"]);
          for (const item of data.items)
            grid.row([
              ...fields.map((key) => {
                const cell = item.fields[key];
                return typeof cell === "object"
                  ? JSON.stringify(cell)
                  : String(cell ?? "未提供");
              }),
              item.observedAt ? formatTime(item.observedAt) : "时间未知",
            ]);
          result.append(
            grid.root,
            disclosure(
              "查看字段与来源",
              el("pre", JSON.stringify(data.items, null, 2), "code-block"),
            ),
          );
        } else
          result.append(
            empty(
              data.status === "ok"
                ? "本次查询没有匹配条目"
                : "当前采集数据不可用",
              data.status === "ok"
                ? "零匹配仅适用于本次返回的设备和类别。"
                : "权限不足或采集未就绪不等于条目数为零。",
              undefined,
              "devices",
            ),
          );
        const pager = el("div", undefined, "pagination");
        if (cursor)
          pager.append(
            button(
              "返回首页",
              () => void run(undefined, () => load(category)),
              "button secondary small-button",
            ),
          );
        if (data.nextCursor)
          pager.append(
            button(
              "下一页清单",
              () => void run(undefined, () => load(category, data.nextCursor)),
              "button secondary small-button",
              "arrow",
            ),
          );
        result.append(pager);
      } catch (reason) {
        if (modal.valid() && ticket === generation)
          result.append(
            notice(
              `读取失败，已有快照保留：${reason instanceof Error ? reason.message : "未知错误"}`,
              "danger",
            ),
          );
      } finally {
        loading.remove();
      }
    }
    for (const [category, label] of categories) {
      const b = button(
        label,
        () => void run(undefined, () => load(category)),
        "tab-button",
      );
      b.dataset.category = category;
      tabs.append(b);
    }
    modal.body.append(
      tabs,
      result,
      notice(
        "文件基线条目不等于文件变更事件；配置评估与漏洞结果也不能替代整机安全结论。",
      ),
    );
    void run(undefined, () => load("os"));
  }
  async function showDevices() {
    const page = begin("devices"),
      devices = card(
        "受管设备",
        "按平台返回的原始设备 ID 展示；每次读取一页，不能将本页数量当作全量",
      );
    const form = el("form", undefined, "filter-bar");
    ctx.connectionSelect(form);
    field(form, "筛选本页设备", "text", "", "search", false);
    select(form, "连接状态", "status", [
      ["", "全部状态"],
      ["active", "在线"],
      ["disconnected", "离线"],
      ["never_connected", "未连接"],
      ["pending", "待连接"],
    ]);
    const results = el("div");
    let currentItems: AgentSummary[] = [],
      loadedConnection = "",
      nextCursor: string | undefined,
      currentCursor: string | undefined;
    function render() {
      const q = value(form, "text").toLowerCase(),
        status = value(form, "status"),
        filtered = currentItems.filter(
          (agent) =>
            (!status || agent.status === status) &&
            `${agent.id} ${agent.name ?? ""} ${agent.version ?? ""}`
              .toLowerCase()
              .includes(q),
        );
      const grid = table(["设备", "Agent 版本", "连接状态", ""]);
      for (const agent of filtered) {
        const title = el("div", undefined, "table-title");
        title.append(
          el("strong", agent.name ?? "名称未知"),
          el(
            "span",
            `Agent ${agent.id}${agent.id === "000" ? " · Manager" : ""}`,
            "small muted mono",
          ),
        );
        const actions = el("div", undefined, "actions");
        actions.append(
          button(
            "采集详情",
            () => deviceDialog(loadedConnection, agent),
            "button ghost small-button",
            "arrow",
          ),
        );
        grid.row([
          title,
          agent.version ?? "未提供",
          state(agent.status ?? "unknown"),
          actions,
        ]);
      }
      results.replaceChildren(
        filtered.length
          ? grid.root
          : empty(
              "当前页没有匹配设备",
              "调整筛选条件，或继续读取下一页。",
              undefined,
              "devices",
            ),
      );
      const pager = el("div", undefined, "pagination");
      pager.append(
        el(
          "span",
          `本页已读取 ${currentItems.length} 项 · 筛选后 ${filtered.length} 项${nextCursor ? " · 仍有后续页" : " · 分页结束"}`,
          "small muted",
        ),
      );
      if (currentCursor)
        pager.append(
          button(
            "返回首页",
            () => void run(undefined, () => load()),
            "button secondary small-button",
          ),
        );
      if (nextCursor)
        pager.append(
          button(
            "下一页设备",
            () => void run(undefined, () => load(nextCursor)),
            "button secondary small-button",
            "arrow",
          ),
        );
      results.append(pager);
    }
    async function load(cursor?: string) {
      const connectionId = value(form, "connectionId");
      if (!connectionId) throw new Error("请先保存平台连接");
      const data = await invoke("connections.agents", {
        connectionId,
        page: { limit: 50, ...(cursor ? { cursor } : {}) },
      });
      if (!page.valid()) return;
      currentItems = data.items;
      loadedConnection = connectionId;
      nextCursor = data.nextCursor;
      currentCursor = cursor;
      render();
    }
    // Explicit reads avoid opening real platform traffic merely by switching navigation.
    submit(form, "读取设备", () => load());
    form
      .querySelector<HTMLInputElement>("[name=text]")!
      .addEventListener("input", () => {
        if (loadedConnection) render();
      });
    form.querySelector("[name=status]")!.addEventListener("change", () => {
      if (loadedConnection) render();
    });
    form
      .querySelector("[name=connectionId]")!
      .addEventListener("change", () => {
        currentItems = [];
        loadedConnection = "";
        results.replaceChildren(
          empty(
            "平台连接已切换",
            "点击读取设备获取这个连接的数据。",
            undefined,
            "devices",
          ),
        );
      });
    devices.body.append(form, results);
    results.append(
      empty(
        "等待读取设备",
        "先选择连接。未查询、权限受限和零匹配会分别显示。",
        undefined,
        "devices",
      ),
    );
    page.body.append(
      devices.root,
      notice(
        "当前界面展示主机侧采集能力，不推断校园网络拓扑、网络流量或未知漏洞数量。",
      ),
    );
  }
  async function showAlerts() {
    const page = begin("alerts"),
      inbox = card(
        "规则告警",
        "收件箱记录、接收顺序与未自动调查原因均由业务服务返回",
      );
    const form = el("form", undefined, "form-grid");
    ctx.connectionSelect(form);
    select(form, "读取状态", "read", [
      ["", "全部记录"],
      ["false", "未读"],
      ["true", "已读"],
    ]);
    field(form, "规则 ID（逗号分隔）", "ruleIds", "", "text", false);
    field(form, "规则组（逗号分隔）", "ruleGroups", "", "text", false);
    select(form, "最低原始等级", "minLevel", [
      ["", "全部等级"],
      ["7", "L7 及以上"],
      ["12", "L12 及以上"],
    ]);
    const limitScope = field(
      form,
      "限定设备与时间范围",
      "limitScope",
      "",
      "checkbox",
      false,
    ) as HTMLInputElement;
    const range = el("fieldset", undefined, "form-grid wide");
    range.append(el("legend", "查询范围"));
    ctx.scopeFields(range);
    range.disabled = true;
    // Only one connection selector is authoritative; scoped queries use the outer selection.
    range.querySelector("[name=connectionId]")?.closest("label")?.remove();
    limitScope.addEventListener("change", () => {
      range.disabled = !limitScope.checked;
    });
    form.append(range);
    const results = el("div");
    let selected: InboxAlert[] = [],
      loadedScope: Scope | undefined,
      serial = 0;
    async function load(cursor?: string) {
      const ticket = ++serial,
        connectionId = value(form, "connectionId");
      if (!connectionId) throw new Error("请先配置平台连接");
      const scope = limitScope.checked ? ctx.readScope(form) : undefined;
      const split = (name: string) =>
        value(form, name)
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean);
      const filter = {
        ...(split("ruleIds").length ? { ruleIds: split("ruleIds") } : {}),
        ...(split("ruleGroups").length
          ? { ruleGroups: split("ruleGroups") }
          : {}),
        ...(value(form, "minLevel")
          ? { minLevel: Number(value(form, "minLevel")) }
          : {}),
      };
      try {
        const data = await invoke("alerts.list", {
          connectionId,
          page: { limit: 20, ...(cursor ? { cursor } : {}) },
          ...(scope ? { scope } : {}),
          filter,
          ...(value(form, "read")
            ? { read: value(form, "read") === "true" }
            : {}),
        });
        if (!page.valid() || ticket !== serial) return;
        selected = [];
        loadedScope = scope;
        const grid = table([
          "选择",
          "原始等级 / 规则",
          "设备",
          "事件时间 · 上海",
          "接收与调查状态",
          "",
        ]);
        const selectedCount = el("span", "未选择告警", "small muted");
        for (const item of data.items) {
          const checkbox = el("input");
          checkbox.type = "checkbox";
          checkbox.setAttribute("aria-label", `选择告警 ${item.id}`);
          checkbox.addEventListener("change", () => {
            selected = checkbox.checked
              ? [...selected, item]
              : selected.filter((x) => x.id !== item.id);
            selectedCount.textContent = `已选择 ${selected.length} 条告警`;
          });
          const rule = el("div", undefined, "table-title");
          rule.append(
            item.level === undefined
              ? ui.chip("等级未知")
              : ui.chip(
                  `L${item.level}`,
                  item.level >= 12
                    ? "danger"
                    : item.level >= 7
                      ? "warning"
                      : "primary",
                ),
            el(
              "span",
              `规则 ${item.ruleId ?? "未知"} · ${item.ruleGroups.join(" / ") || "分类未知"}`,
              "small muted",
            ),
          );
          const reason = el("div", undefined, "table-title");
          reason.append(
            ui.chip(
              item.read ? "已读" : "未读",
              item.read ? "neutral" : "primary",
            ),
            el("span", item.decisionReason, "small muted"),
          );
          grid.row([
            checkbox,
            rule,
            item.agentId ?? "未知设备",
            formatTime(item.observedAt),
            reason,
            button(
              "查看引用",
              () => {
                const preview = dialog(
                  "告警来源与引用",
                  "收件箱只保存引用。完整材料在获准案件中通过证据入口读取。",
                );
                preview.body.append(
                  facts([
                    ["记录 ID", item.id],
                    ["来源", item.sourceKey],
                    ["接收类型", stateText(item.kind)],
                    ["接收时间", formatTime(item.receivedAt)],
                    ["未自动调查原因", item.decisionReason],
                    [
                      "证据引用",
                      `${item.evidence.evidenceId} / v${item.evidence.version}`,
                    ],
                  ]),
                );
              },
              "button ghost small-button",
              "arrow",
            ),
          ]);
        }
        results.replaceChildren(
          data.items.length
            ? grid.root
            : empty(
                "没有匹配告警",
                "这是本次收件箱查询结果，不代表当前设备不存在风险。",
                undefined,
                "alerts",
              ),
        );
        const actions = el("div", undefined, "pagination");
        actions.append(
          selectedCount,
          button(
            "标记所选已读",
            () =>
              void run(undefined, async () => {
                if (!selected.length) throw new Error("请先选择告警");
                await invoke("alerts.markRead", {
                  alertIds: selected.map((item) => item.id),
                });
                if (page.valid()) {
                  await load(cursor);
                  ctx.notify("所选告警已标记为已读。");
                }
              }),
            "button secondary small-button",
            "check",
          ),
          button(
            "选中建案",
            () => {
              if (!selected.length) {
                ctx.notify("请先选择至少一条告警。");
                return;
              }
              const refs: EvidenceRef[] = selected.map((item) => item.evidence);
              ctx.openCreate(
                scopeForAlerts(selected, connectionId, loadedScope),
                refs,
              );
            },
            "button primary small-button",
            "cases",
          ),
        );
        if (data.nextCursor)
          actions.append(
            button(
              "下一页告警",
              () => void run(undefined, () => load(data.nextCursor)),
              "button secondary small-button",
              "arrow",
            ),
          );
        results.append(actions);
      } catch (reason) {
        if (page.valid() && ticket === serial)
          results.replaceChildren(
            empty(
              "告警收件箱当前不可用",
              reason instanceof Error ? reason.message : "读取失败",
              button(
                "重新读取",
                () => void run(undefined, () => load()),
                "button secondary",
                "refresh",
              ),
              "alerts",
            ),
          );
      }
    }
    submit(form, "读取告警", () => load());
    inbox.body.append(form, results);
    page.body.append(
      inbox.root,
      notice(
        "原始归档不在收件箱契约内。归档权限可在平台连接中核实；告警与归档的计数不能相加。",
      ),
    );
    if (ctx.connections().length) await load();
    else
      results.append(
        empty(
          "先配置平台连接",
          "保存连接后可查询本地收件箱。",
          button(
            "前往平台连接",
            () => void run(undefined, () => ctx.navigate("connections")),
            "button primary",
            "connections",
          ),
        ),
      );
  }
  async function showArchitecture() {
    const page = begin("architecture"),
      runtime = await invoke("runtime.status", {});
    if (!page.valid()) return;
    const pipeline = card(
      "数据与调查链路",
      "配置存在、可读取、宿主就绪和投递完成分别确认",
    );
    const grid = el("div", undefined, "integration-grid");
    for (const [glyph, title, text, label] of [
      [
        "devices",
        "主机与设备",
        "设备清单、采集快照与规则告警",
        "由平台能力核实",
      ],
      [
        "connections",
        "Wazuh 只读接入",
        "Server / Indexer 独立认证、范围和权限",
        `${ctx.connections().length} 项连接配置`,
      ],
      [
        "cases",
        "本地案件与证据",
        "案件、人工背景、版本与引用持久化",
        "本地功能可用",
      ],
      [
        "requests",
        "调查与结果回传",
        "执行宿主、隔离通道与来源绑定",
        runtime.state === "ready" ? "运行核心就绪" : "调查能力待接入",
      ],
    ]) {
      const step = el("article", undefined, "integration-step");
      step.append(
        ui.icon(glyph!),
        el("h3", title),
        el("p", text, "muted small"),
        ui.chip(label!),
      );
      grid.append(step);
    }
    pipeline.body.append(grid);
    page.body.append(pipeline.root);
    const capabilities = card(
        "调查宿主能力",
        "每一项都需要真实证据；未核实不能视为就绪",
      ),
      rows = table(["能力", "状态", "核实依据"]);
    for (const capability of runtime.hostCapabilities)
      rows.row([
        capabilityNames[capability.name] ?? capability.name,
        state(capability.state),
        capability.evidence,
      ]);
    capabilities.body.append(rows.root);
    page.body.append(capabilities.root);
    const boundaries = card(
      "入口与交接",
      "来自三个入口的调查共享服务端权限、范围和预算",
    );
    boundaries.body.append(
      facts([
        ["客户端主动调查", "从问题、设备或案件显式提交"],
        ["告警触发调查", "依赖告警模块与已保存策略；不由页面轮询启动模型"],
        ["来源对话委派", "依赖可信 TeleAgent 与独立 MCP 通道"],
        ["报告与投递", "人工审核、案件关闭、发布和接收状态分别记录"],
      ]),
    );
    page.body.append(boundaries.root);
  }
  return { showDevices, showAlerts, showArchitecture };
}
