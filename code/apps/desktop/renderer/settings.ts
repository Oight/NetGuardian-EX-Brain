import type { TriggerPolicy } from "@campussec/contracts";
import type { WorkbenchContext } from "./context.js";
import { capabilityNames, formatTime, parseInstant } from "./model.js";

export function createSettingsViews(
  ctx: WorkbenchContext,
  appearance: {
    theme(): string;
    setTheme(value: string): void;
    density(): string;
    setDensity(value: string): void;
  },
) {
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
    facts,
    state,
    disclosure,
  } = ui;
  function credential(connectionId: string, generation: number) {
    const modal = dialog(
      "设置连接凭据",
      "Server 和 Indexer 独立保存。凭据只交给桌面秘密存储，不进入浏览器偏好或案件数据。",
    );
    const form = el("form", undefined, "form-grid");
    select(
      form,
      "认证端点",
      "endpoint",
      [
        ["server", "Server API"],
        ["indexer", "Indexer API"],
      ],
      "server",
      true,
    );
    const username = field(form, "用户名", "username"),
      password = field(form, "密码", "password", "", "password");
    username.autocomplete = "off";
    password.autocomplete = "new-password";
    const persist = field(
      form,
      "使用系统加密存储，允许重启后继续使用",
      "persist",
      "",
      "checkbox",
      false,
    ) as HTMLInputElement;
    submit(form, "保存凭据", async () => {
      try {
        await invoke("connections.setCredential", {
          connectionId,
          expectedGeneration: generation,
          endpoint: value(form, "endpoint") as "server" | "indexer",
          username: username.value,
          password: password.value,
          persist: persist.checked,
        });
        if (!modal.valid()) return;
        modal.close();
        await ctx.refresh();
        await showConnections();
        ctx.notify("凭据已交给桌面秘密存储；尚未探测平台权限。");
      } finally {
        password.value = "";
      }
    });
    modal.body.append(form);
  }
  function certificate(connectionId: string, generation: number) {
    const modal = dialog(
      "设置信任证书",
      "仅接受 PEM 证书链。平台连接继续验证 HTTPS 证书和访问地址，不提供跳过 TLS 校验开关。",
    );
    const form = el("form", undefined, "form-grid");
    field(form, "PEM 证书链", "certificatePem", "", "textarea");
    submit(form, "保存信任证书", async () => {
      await invoke("connections.setCa", {
        connectionId,
        expectedGeneration: generation,
        certificatePem: value(form, "certificatePem"),
      });
      if (modal.valid()) {
        modal.close();
        await ctx.refresh();
        await showConnections();
        ctx.notify("证书已保存；需要重新核实连接能力。");
      }
    });
    modal.body.append(form);
  }
  async function showConnections() {
    const page = begin("connections"),
      saved = card(
        "已配置的平台",
        "配置保存不访问平台。读取本地能力使用缓存；刷新能力会显式探测平台。",
      );
    for (const connection of ctx.connections()) {
      const row = el("article", undefined, "connection-row"),
        title = el("div", undefined, "between wrap"),
        name = el("div");
      name.append(
        el("h3", connection.displayName),
        el(
          "p",
          `代次 ${connection.generation} · ${connection.id.slice(0, 8)}`,
          "small muted mono",
        ),
      );
      const actions = el("div", undefined, "actions"),
        result = el("div");
      async function capabilities(refresh: boolean) {
        const items = await invoke("connections.capabilities", {
          connectionId: connection.id,
          refresh,
        });
        if (!page.valid()) return;
        const grid = table(["数据能力", "端点", "状态", "核实依据"]);
        for (const item of items)
          grid.row([
            capabilityNames[item.name] ?? item.name,
            item.endpointKind === "server" ? "Server" : "Indexer",
            state(item.state),
            `${item.evidence} · ${formatTime(item.checkedAt)}`,
          ]);
        result.replaceChildren(grid.root);
      }
      actions.append(
        button(
          "本地能力状态",
          () => void run(undefined, () => capabilities(false)),
          "button secondary small-button",
        ),
        button(
          "刷新平台能力",
          () => void run(undefined, () => capabilities(true)),
          "button secondary small-button",
          "refresh",
        ),
        button(
          "设置凭据",
          () => credential(connection.id, connection.generation),
          "button ghost small-button",
        ),
        button(
          "信任证书",
          () => certificate(connection.id, connection.generation),
          "button ghost small-button",
        ),
      );
      title.append(name, actions);
      row.append(title, result);
      saved.body.append(row);
    }
    if (!ctx.connections().length)
      saved.body.append(
        empty(
          "配置第一个平台连接",
          "Server 与 Indexer 可以分步填写。离线保存后即可建立本地案件。",
          undefined,
          "connections",
        ),
      );
    const setup = card(
        "新增平台连接",
        "HTTPS 入口与平台身份必须由部署环境确认；未知能力保持未核实",
      ),
      form = el("form", undefined, "form-grid");
    field(form, "连接名称", "displayName");
    field(
      form,
      "平台实例 ID（UUID）",
      "platformInstanceId",
      crypto.randomUUID(),
    );
    field(form, "Server HTTPS 入口（可空）", "serverBaseUrl", "", "url", false);
    field(
      form,
      "Indexer HTTPS 入口（可空）",
      "indexerBaseUrl",
      "",
      "url",
      false,
    );
    field(form, "告警索引模式", "alertsPattern", "wazuh-alerts-*");
    field(form, "归档索引模式（可空）", "archivesPattern", "", "text", false);
    field(form, "映射版本", "mappingVersion", "wazuh-alerts-v1");
    submit(form, "保存新连接", async () => {
      await invoke("connections.configure", {
        displayName: value(form, "displayName"),
        platformInstanceId: value(form, "platformInstanceId"),
        alertsPattern: value(form, "alertsPattern"),
        mappingVersion: value(form, "mappingVersion"),
        ...(value(form, "serverBaseUrl")
          ? { serverBaseUrl: value(form, "serverBaseUrl") }
          : {}),
        ...(value(form, "indexerBaseUrl")
          ? { indexerBaseUrl: value(form, "indexerBaseUrl") }
          : {}),
        ...(value(form, "archivesPattern")
          ? { archivesPattern: value(form, "archivesPattern") }
          : {}),
      });
      if (page.valid()) {
        await ctx.refresh();
        await showConnections();
        ctx.notify("连接已保存；尚未探测平台权限。");
      }
    });
    setup.body.append(form);
    page.body.append(
      saved.root,
      setup.root,
      notice(
        "跨平台或主体身份变更需要新的工作空间。平台权限不足、映射未验证和宿主未接入会分别保留，不能用另一版页面的旧状态证明当前连接可用。",
      ),
    );
  }
  function retentionDialog() {
    const modal = dialog(
      "证据留存与清理",
      "先生成预览，核对可清理项和受保护项后，再明确应用。保存留存设置不会自动清理证据。",
    );
    const form = el("form", undefined, "form-grid");
    field(form, "案件 ID（逗号分隔）", "caseIds");
    field(
      form,
      "早于此取得时间（含时区）",
      "olderThan",
      new Date(Date.now() - 30 * 86400000).toISOString(),
    );
    const result = el("div");
    submit(form, "生成清理预览", async () => {
      const plan = await invoke("retention.preview", {
        caseIds: [
          ...new Set(
            value(form, "caseIds")
              .split(/[,，\s]+/)
              .filter(Boolean),
          ),
        ],
        olderThan: parseInstant(value(form, "olderThan")),
      });
      if (!modal.valid()) return;
      result.replaceChildren(
        facts([
          ["可清理版本", String(plan.removableVersions)],
          ["受保护版本", String(plan.blockedVersions)],
          [
            "估算释放大小",
            `${(plan.approximateBytes / 1048576).toFixed(2)} MiB`,
          ],
          ["计划有效至", formatTime(plan.expiresAt)],
        ]),
        notice(
          "报告摘录和引用仍会保留。案件版本变化、受保护轮次变化或计划过期后，需要重新预览。",
          "warning",
        ),
      );
      const apply = button(
        "应用这份清理计划",
        () =>
          void run(apply, async () => {
            if (Date.now() >= Date.parse(plan.expiresAt))
              throw new Error("清理计划已过期，请重新预览");
            const data = await invoke("retention.apply", {
              planId: plan.id,
              expectedPlanHash: plan.planHash,
            });
            if (!modal.valid()) return;
            result.replaceChildren(
              notice(
                `已将 ${data.expiredVersions} 个证据版本标记过期，引用缺口继续保留。`,
              ),
            );
          }),
        "button danger",
      );
      apply.disabled = plan.removableVersions === 0;
      result.append(
        apply,
        disclosure(
          "计划范围与哈希",
          el("pre", JSON.stringify(plan, null, 2), "code-block"),
        ),
      );
    });
    modal.body.append(form, result);
  }
  function automationDialog() {
    const modal = dialog(
      "自动调查策略",
      "策略由告警模块执行。保存前核对接收边界与版本，页面不会自行启动告警轮询。",
    );
    const form = el("form", undefined, "form-grid");
    ctx.connectionSelect(form);
    field(
      form,
      "策略 ID（新策略使用此 UUID）",
      "policyId",
      crypto.randomUUID(),
    );
    field(
      form,
      "预期现有版本（新策略为 0）",
      "expectedRevision",
      "0",
      "number",
    );
    field(form, "策略 epoch", "epoch", "1", "number");
    field(form, "设备 ID（逗号分隔）", "agents");
    field(form, "启用起点的接收序号", "enabledAfterReceiveSeq", "", "number");
    select(
      form,
      "最低原始等级",
      "minLevel",
      [
        ["7", "L7 及以上"],
        ["12", "L12 及以上"],
      ],
      "12",
      true,
    );
    field(form, "每日自动调查尝试上限", "dailyAttemptLimit", "10", "number");
    field(
      form,
      "每日 token 上限（可空）",
      "dailyTokenLimit",
      "",
      "number",
      false,
    );
    field(form, "预算日历时区", "timeZone", "Asia/Shanghai");
    const enabled = field(
      form,
      "启用自动调查策略",
      "enabled",
      "",
      "checkbox",
      false,
    ) as HTMLInputElement;
    submit(form, "保存自动策略", async () => {
      const expectedRevision = Number(value(form, "expectedRevision"));
      const policy: TriggerPolicy = {
        id: value(form, "policyId"),
        connectionId: value(form, "connectionId"),
        revision: Math.max(1, expectedRevision),
        epoch: Number(value(form, "epoch")),
        enabled: enabled.checked,
        agentIds: [
          ...new Set(
            value(form, "agents")
              .split(/[,，\s]+/)
              .filter(Boolean),
          ),
        ],
        filter: { minLevel: Number(value(form, "minLevel")) },
        enabledAfterReceiveSeq: Number(value(form, "enabledAfterReceiveSeq")),
        dailyAttemptLimit: Number(value(form, "dailyAttemptLimit")),
        timeZone: value(form, "timeZone"),
        ...(value(form, "dailyTokenLimit")
          ? { dailyTokenLimit: Number(value(form, "dailyTokenLimit")) }
          : {}),
      };
      const saved = await invoke("alerts.setPolicy", {
        expectedRevision,
        policy,
      });
      if (modal.valid()) {
        modal.close();
        ctx.notify(
          `策略版本 ${saved.revision} 已保存，当前${saved.enabled ? "启用" : "关闭"}。`,
        );
      }
    });
    modal.body.append(
      notice(
        "当前接口没有读取完整策略的方法。编辑已有策略时必须填写部署方提供的策略 ID、版本、epoch 与接收序号，不能用事件序号代替。",
        "warning",
      ),
      form,
    );
  }
  async function showSettings() {
    const page = begin("settings"),
      [settings, runtime] = await Promise.all([
        invoke("runtime.settings", {}),
        invoke("runtime.status", {}),
      ]);
    if (!page.valid()) return;
    const layout = el("div", undefined, "settings-grid"),
      display = card("显示偏好", "只保存在当前设备，不影响其他开发者的工具链");
    const displayForm = el("div", undefined, "form-grid");
    const theme = select(
        displayForm,
        "界面主题",
        "theme",
        [
          ["light", "浅色"],
          ["dark", "深色"],
        ],
        appearance.theme(),
      ),
      density = select(
        displayForm,
        "表格密度",
        "density",
        [
          ["comfortable", "舒适"],
          ["compact", "紧凑"],
        ],
        appearance.density(),
      );
    theme.addEventListener("change", () => appearance.setTheme(theme.value));
    density.addEventListener("change", () =>
      appearance.setDensity(density.value),
    );
    display.body.append(displayForm);
    const preferences = card(
        "预算与留存",
        "以下设置作用于当前工作空间；不代表已取得实际 token 用量",
      ),
      form = el("form", undefined, "form-grid");
    const tray = field(
      form,
      "关闭窗口后驻留托盘",
      "tray",
      "",
      "checkbox",
      false,
    ) as HTMLInputElement;
    tray.checked = settings.trayEnabled;
    field(form, "预算日历时区", "budgetTimeZone", settings.budgetTimeZone);
    field(
      form,
      "每日总 token 上限（空白表示未配置）",
      "tokenLimit",
      settings.dailyTotalTokenLimit?.toString() ?? "",
      "number",
      false,
    );
    field(
      form,
      "证据保留天数（空白表示未配置）",
      "retentionDays",
      settings.retentionDays?.toString() ?? "",
      "number",
      false,
    );
    field(
      form,
      "证据大小上限（字节，可空）",
      "evidenceMaxBytes",
      settings.evidenceMaxBytes?.toString() ?? "",
      "number",
      false,
    );
    submit(form, "保存运行设置", async () => {
      await invoke("runtime.configure", {
        expectedRevision: settings.revision,
        settings: {
          trayEnabled: tray.checked,
          budgetTimeZone: value(form, "budgetTimeZone"),
          ...(value(form, "tokenLimit")
            ? { dailyTotalTokenLimit: Number(value(form, "tokenLimit")) }
            : {}),
          ...(value(form, "retentionDays")
            ? { retentionDays: Number(value(form, "retentionDays")) }
            : {}),
          ...(value(form, "evidenceMaxBytes")
            ? { evidenceMaxBytes: Number(value(form, "evidenceMaxBytes")) }
            : {}),
        },
      });
      if (page.valid()) {
        await showSettings();
        ctx.notify("设置已保存。保存设置不会自动清理证据。");
      }
    });
    preferences.body.append(form);
    const operations = card(
      "调查与证据管理",
      "高影响操作均有独立的范围与结果反馈",
    );
    operations.body.append(
      button("预览证据清理", retentionDialog, "button secondary", "reports"),
      button("自动调查策略", automationDialog, "button secondary", "alerts"),
      button(
        "管理平台连接",
        () => void run(undefined, showConnections),
        "button secondary",
        "connections",
      ),
    );
    const host = card("桌面与宿主状态", "未核实项不等于已通过验收"),
      grid = table(["能力", "状态", "核实依据"]);
    for (const capability of runtime.hostCapabilities)
      grid.row([
        capabilityNames[capability.name] ?? capability.name,
        state(capability.state),
        capability.evidence,
      ]);
    host.body.append(
      grid.root,
      facts([
        ["托盘设置", runtime.trayEnabled ? "开启" : "关闭"],
        ["工作空间", runtime.spaceId],
      ]),
    );
    layout.append(display.root, operations.root, preferences.root, host.root);
    page.body.append(layout);
  }
  return { showConnections, showSettings };
}
