/** Actual browser HTTP/facade/SQLite workflows. Only upstream and host wires are synthetic. */
import type {
  DesktopMethodMap,
  RequestStatus,
  CaseRecord,
  Scope,
  ReportRecord,
  ResultPackage,
  EvidenceToolEnvelope,
} from "@campussec/contracts";
const frame = document.getElementById("qa-frame") as HTMLIFrameElement,
  results = document.getElementById("qa-results")!;
const tests: [string, () => Promise<void>][] = [];
const test = (name: string, action: () => Promise<void>) =>
  tests.push([name, action]);
function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
async function until(predicate: () => boolean, message: string) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw Error(message);
}
async function rpc<K extends keyof DesktopMethodMap>(
  method: K,
  payload: DesktopMethodMap[K]["input"],
) {
  const r = await frame.contentWindow!.campusSec!.invoke({
    protocolVersion: "0.1.0",
    requestId: crypto.randomUUID(),
    method,
    payload,
  });
  if (!r.result.ok)
    throw Error(`${method}: ${r.result.error.code}: ${r.result.error.message}`);
  return r.result.value;
}
async function control(action: string, data: Record<string, unknown> = {}) {
  const r = await (
    await fetch("/qa/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...data }),
    })
  ).json();
  if (!r.ok) throw Error(`${action}: ${r.error.code}: ${r.error.message}`);
  return r.value;
}
async function click(text: string) {
  const button = Array.from(
    frame.contentDocument!.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent?.trim() === text);
  assert(button, `缺少按钮 ${text}`);
  button.click();
  await new Promise((r) => setTimeout(r, 80));
}
let connectionId = "",
  caseRecord: CaseRecord,
  scope: Scope,
  request: RequestStatus,
  report: ReportRecord,
  result: ResultPackage,
  query: EvidenceToolEnvelope,
  waiting: RequestStatus,
  uncertain: RequestStatus,
  delegated: RequestStatus;
const snapshot = () =>
  rpc("cases.snapshot", { caseId: caseRecord.id, evidencePage: { limit: 50 } });
const create = (
  key: string,
  extra: Partial<DesktopMethodMap["requests.create"]["input"]> = {},
) =>
  rpc("requests.create", {
    origin: "client_user",
    connectionId,
    question: "网页合成调查问题",
    requestedScope: scope,
    seedRefs: [],
    caseId: caseRecord.id,
    idempotencyKey: key,
    ...extra,
  });
test("HTTP 来源校验、严格 RPC schema 与网页托盘能力边界", async () => {
  const denied = await fetch("/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert(denied.status === 403, "缺少网页通道标记应拒绝");
  const invalid = await frame.contentWindow!.campusSec!.invoke({
    protocolVersion: "0.1.0",
    requestId: crypto.randomUUID(),
    method: "cases.list",
    payload: { page: { limit: 1 }, unexpected: true },
  } as never);
  assert(!invalid.result.ok, "多余字段必须失败");
  const tray = await frame.contentWindow!.campusSec!.invoke({
    protocolVersion: "0.1.0",
    requestId: crypto.randomUUID(),
    method: "runtime.setTray",
    payload: { enabled: true },
  });
  assert(
    !tray.result.ok && tray.result.error.code === "CAPABILITY_UNAVAILABLE",
    "网页不冒充系统托盘",
  );
});
test("浏览器配置 campusguard-mui 接口并读取设备与能力", async () => {
  const configured = await rpc("connections.configure", {
    displayName: "campusguard-mui 合成代理",
    platformInstanceId: crypto.randomUUID(),
    alertsPattern: "wazuh-alerts-4.x-*",
    mappingVersion: "campus-mui-v1",
  });
  connectionId = configured.id;
  scope = {
    connectionId,
    agentIds: ["001"],
    from: "2026-10-23T00:30:00.000Z",
    to: "2026-10-23T01:00:00.000Z",
    timeZone: "Asia/Shanghai",
  };
  const agents = await rpc("connections.agents", {
    connectionId,
    page: { limit: 20 },
  });
  assert(agents.items[0]?.id === "001", "原生设备身份");
  const caps = await rpc("connections.capabilities", {
    connectionId,
    refresh: true,
  });
  assert(
    caps.some((c) => c.name === "alerts" && c.state === "available"),
    "实际代理读取探测",
  );
  assert(
    caps.some(
      (c) => c.name === "stable_alert_pagination" && c.state === "unverified",
    ),
    "稳定分页保持未核实",
  );
});
test("统计、设备清单和受限覆盖通过真实网页传输返回", async () => {
  const stats = await rpc("statistics.alerts", scope);
  assert(
    stats.total.value === 1 && stats.coverage.queryCompleteness === "partial",
    "统计需保留代理覆盖限制",
  );
  const detail = await rpc("devices.detail", {
    connectionId,
    agentId: "001",
    category: "packages",
    page: { limit: 20 },
  });
  assert(detail.items.length === 1, "具有原生扫描身份的清单");
  await click("刷新工作空间");
  await click("设备与资产");
  await click("读取设备");
  await until(
    () => frame.contentDocument!.body.textContent!.includes("合成校园终端"),
    "真实设备列表应渲染",
  );
});
test("告警轮询入库、已读和单选告警建案", async () => {
  await control("poll", { connectionId });
  const inbox = await rpc("alerts.list", { connectionId, page: { limit: 50 } });
  assert(inbox.items.length === 1, "应入库一条告警");
  await rpc("alerts.markRead", { alertIds: [inbox.items[0]!.id] });
  assert(
    (
      await rpc("alerts.list", {
        connectionId,
        page: { limit: 50 },
        read: true,
      })
    ).items.length === 1,
    "已读持久化",
  );
  caseRecord = await rpc("cases.create", {
    title: "网页核心闭环案件",
    scope,
    seedRefs: [inbox.items[0]!.evidence],
  });
  assert((await snapshot()).evidence.length === 1, "原生证据进入案件");
});
test("业务背景版本保存和案件 CAS 冲突保留", async () => {
  const before = await snapshot();
  await rpc("cases.putContext", {
    caseId: caseRecord.id,
    expectedRevision: before.case.revision,
    context: {
      caseId: caseRecord.id,
      connectionId,
      agentIds: ["001"],
      text: "<script>不会执行</script> 合成维护窗口",
      sourceLabel: "合成值班备注",
      verification: "unverified",
      from: scope.from,
      to: scope.to,
    },
  });
  const stale = await frame.contentWindow!.campusSec!.invoke({
    protocolVersion: "0.1.0",
    requestId: crypto.randomUUID(),
    method: "cases.setStatus",
    payload: {
      caseId: caseRecord.id,
      expectedRevision: before.case.revision,
      status: "investigating",
      reason: "陈旧版本",
    },
  });
  assert(
    !stale.result.ok && stale.result.error.code === "REVISION_CONFLICT",
    "陈旧案件版本必须拒绝",
  );
});
test("请求受理、重复提交幂等和缺范围补充", async () => {
  request = await create("web-main");
  assert(
    (await create("web-main")).request.id === request.request.id,
    "重复提交不能创建第二个任务",
  );
  waiting = await create("web-wait", {
    requestedScope: undefined,
    caseId: undefined,
  });
  assert(waiting.request.state === "awaiting_scope", "缺少范围保持等待");
  waiting = await rpc("requests.provideInput", {
    requestId: waiting.request.id,
    scope,
    text: "网页补充范围",
    idempotencyKey: "supplement",
  });
  assert(waiting.job?.state === "queued", "补充范围后受理");
  await rpc("requests.cancel", {
    requestId: waiting.request.id,
    reason: "合成排队取消",
  });
  assert(
    (await rpc("results.get", { requestId: waiting.request.id }))
      .terminalState === "cancelled",
    "无轮次取消结果",
  );
});
test("调度建立冻结轮次、读取历史输入和真实步骤", async () => {
  await control("tick");
  request = await rpc("requests.status", { requestId: request.request.id });
  assert(
    request.job?.state === "running" && request.job.runId,
    "合成宿主运行中",
  );
  const initial = await rpc("investigations.input", {
    runId: request.job.runId,
    page: { limit: 50 },
  });
  assert(
    initial.initialInput.contexts[0]?.text.includes("合成维护窗口"),
    "冻结当时背景",
  );
  const history = await rpc("investigations.history", {
    caseId: caseRecord.id,
    page: { limit: 20 },
  });
  assert(
    history.items.some((i) => i.request.id === request.request.id),
    "真实历史请求",
  );
  const steps = await rpc("investigations.snapshot", {
    runId: request.job.runId,
  });
  assert(steps.run.id === request.job.runId, "轮次快照");
});
test("专用证据通道读取背景、按线索查询并确认交付", async () => {
  const ctx = await control("tool", { name: "get_case_context" });
  assert(ctx.context.question === "网页合成调查问题", "冻结问题");
  query = await control("tool", {
    name: "search_related_alerts",
    args: { agentIds: ["001"], purpose: "核对网页实际返回的线索" },
  });
  assert(
    query.records.length === 1 && query.status === "partial",
    "代理查询保留覆盖缺口",
  );
  const second = await control("tool", {
    name: "search_related_alerts",
    args: {
      agentIds: ["001"],
      filter: { ruleIds: [String(query.records[0]!.content["rule.id"])] },
      purpose: "依据上次返回的规则核对",
    },
  });
  assert(second.records.length === 1, "第二次查询基于第一条记录");
});
test("候选报告、终态结果包和人工审核分别持久化", async () => {
  const proposal = await control("tool", {
    name: "propose_report",
    args: {
      caseId: caseRecord.id,
      runId: request.job!.runId,
      question: "网页合成调查问题",
      facts: [
        {
          text: "合成告警仅证明本次返回线索",
          evidenceRefs: [query.records[0]!.ref],
          queryIds: [query.queryId],
          contextRefs: [],
        },
      ],
      analysis: [],
      conflicts: [],
      gaps: ["代理稳定分页和采集覆盖未核实"],
      classification: "needs_investigation",
      stopReason: "answered_with_limits",
      followups: [
        { question: "人工核对合成线索", suggestedAction: "核对原始材料" },
      ],
    },
  });
  assert(proposal.status === "ok", "候选保存");
  await control("complete");
  result = await rpc("results.get", { requestId: request.request.id });
  assert(
    result.review === "unreviewed" && result.reportId,
    "自动结果不能冒充人工审核",
  );
  report = (await rpc("reports.list", { caseId: caseRecord.id })).find(
    (r) => r.id === result.reportId,
  )!;
  assert(report, "报告读取");
  const before = await snapshot();
  report = await rpc("reports.review", {
    reportId: report.id,
    expectedCaseRevision: before.case.revision,
    disposition: "accepted",
    humanConclusion: "unknown",
    note: "仅验收合成流程，不是安全结论",
  });
  assert(
    (await rpc("results.get", { requestId: request.request.id }))
      .resultVersion === 1,
    "审核不隐式回传新版本",
  );
});
test("显式发布审核版本并核对跟进事项", async () => {
  const before = await snapshot();
  const published = await rpc("results.publishReview", {
    requestId: request.request.id,
    reportId: report.id,
    expectedCaseRevision: before.case.revision,
    expectedResultVersion: 1,
  });
  assert(
    published.resultVersion === 2 && published.review === "accepted",
    "人工审核版本",
  );
  const followups = await rpc("followups.list", { caseId: caseRecord.id });
  assert(followups.length > 0, "应保存跟进事项");
  const first = followups[0]!;
  await rpc("followups.put", {
    expectedRevision: first.revision,
    item: {
      ...first,
      state: "completed",
      note: "合成核查完成",
    },
  });
  assert(
    (
      await rpc("followups.search", {
        caseId: caseRecord.id,
        page: { limit: 20 },
      })
    ).items[0]?.state === "completed",
    "跟进状态保存",
  );
});
test("网页导出下载包含真实案件和审核记录，不写入浏览器下载目录", async () => {
  const win = frame.contentWindow! as Window & typeof globalThis;
  const original = win.HTMLAnchorElement.prototype.click;
  let download = "";
  win.HTMLAnchorElement.prototype.click = function () {
    download = this.href;
  };
  try {
    const before = await snapshot();
    const exported = await rpc("cases.export", {
      caseId: caseRecord.id,
      caseRevision: before.case.revision,
      format: "json",
    });
    assert(
      !exported.text.includes("网页核心闭环案件") &&
        exported.filename.endsWith(".ngenc"),
      "导出必须加密",
    );
    const opened = await frame.contentWindow!.campusAuth!.invoke("openExport", {
      text: exported.text,
    });
    assert(
      opened.ok && opened.value.text.includes("网页核心闭环案件"),
      "当前账号验证签名并解密",
    );
    assert(download.includes("/download/"), "一次性下载票据");
    const response = await fetch(download);
    assert(
      response.ok && !(await response.text()).includes("网页核心闭环案件"),
      "下载内容保留审核状态",
    );
    assert((await fetch(download)).status === 404, "票据不可重放");
  } finally {
    win.HTMLAnchorElement.prototype.click = original;
  }
});
test("不确定执行必须核实或明确放弃，不重复提交", async () => {
  uncertain = await create("web-uncertain");
  await control("tick");
  await control("uncertain");
  uncertain = await rpc("requests.status", { requestId: uncertain.request.id });
  assert(uncertain.job?.state === "uncertain", "远端状态不确定");
  const reconciled = await rpc("requests.reconcile", {
    requestId: uncertain.request.id,
    expectedJobRevision: uncertain.job.revision,
  });
  assert(reconciled.job?.state === "uncertain", "核实不能制造完成");
  const abandoned = await rpc("requests.abandon", {
    requestId: uncertain.request.id,
    expectedJobRevision: reconciled.job!.revision,
    reason: "合成明确放弃本地等待",
  });
  assert(
    ["failed", "cancelled", "needs_review"].includes(abandoned.job!.state),
    "明确放弃形成终态",
  );
});
test("可信宿主人类来源、取消结果与原对话投递核实", async () => {
  delegated = await control("delegated", { connectionId, scope });
  await rpc("requests.cancel", {
    requestId: delegated.request.id,
    reason: "合成取消宿主请求",
  });
  assert(
    (await rpc("deliveries.status", { requestId: delegated.request.id }))[0]
      ?.state === "pending",
    "结果与 outbox 同时保存",
  );
  await control("delivery", { found: false });
  assert(
    (await rpc("deliveries.status", { requestId: delegated.request.id }))[0]
      ?.state === "uncertain",
    "丢失回执保持不确定",
  );
  await control("advance");
  const delivered = await control("delivery", { found: true });
  assert(delivered.sends === 1, "核实原投递不得重发");
  assert(
    (await rpc("deliveries.status", { requestId: delegated.request.id }))[0]
      ?.state === "delivered",
    "原对话可见回执",
  );
});
test("策略读取保存与不完整代理覆盖禁止自动触发", async () => {
  const prior = await rpc("alerts.getPolicy", { connectionId });
  assert(!prior.configured, "未配置策略应明确");
  const policy = await rpc("alerts.setPolicy", {
    expectedRevision: 0,
    policy: {
      id: crypto.randomUUID(),
      connectionId,
      enabled: true,
      revision: 1,
      epoch: 1,
      agentIds: ["001"],
      filter: { minLevel: 5 },
      enabledAfterReceiveSeq: 0,
      dailyAttemptLimit: 10,
      timeZone: "Asia/Shanghai",
    },
  });
  assert(policy.enabled, "策略保存");
  await control("advance");
  const polled = await control("poll", { connectionId });
  assert(polled.complete === false, "分页未核实不能推进完整检查点");
  assert(
    (await rpc("alerts.getPolicy", { connectionId })).configured,
    "策略读取",
  );
});
test("证据留存预览、显式应用和清理后原引用状态", async () => {
  await control("advance");
  const plan = await rpc("retention.preview", {
    caseIds: [caseRecord.id],
    olderThan: "2026-10-24T00:00:00.000Z",
  });
  assert(plan.removableVersions > 0, "实际可过期证据");
  const applied = await rpc("retention.apply", {
    planId: plan.id,
    expectedPlanHash: plan.planHash,
  });
  assert(applied.expiredVersions > 0, "明确清理");
  const history = await rpc("investigations.input", {
    runId: request.job!.runId!,
    page: { limit: 50 },
  });
  assert(
    history.projections.some((p) => p.availability === "expired"),
    "冻结轮次保留过期标记",
  );
});
test("刷新实际工作台后案件、报告和历史依然可见", async () => {
  frame.src = "/";
  await until(
    () =>
      frame.contentDocument?.readyState === "complete" &&
      !!frame.contentDocument?.querySelector(".metric"),
    "页面刷新",
  );
  await click("调查与案件");
  await until(
    () => frame.contentDocument!.body.textContent!.includes("网页核心闭环案件"),
    "持久化案件",
  );
  await click("网页核心闭环案件");
  await until(
    () => frame.contentDocument!.body.textContent!.includes("合成维护窗口"),
    "保存背景应可见",
  );
  assert(
    !frame.contentDocument!.querySelector("script:not([src])"),
    "外部内容不能注入脚本",
  );
});
test("多账号 RBAC、主体隔离、退出失效与管理员保护", async () => {
  const api = frame.contentWindow!.campusAuth!;
  const created = await api.invoke("createAccount", {
    username: "browser_viewer",
    password: "Synthetic-viewer-2026!",
    role: "viewer",
  });
  assert(created.ok, "管理员创建只读账号");
  await api.invoke("logout", {});
  const signed = await api.invoke("login", {
    username: "browser_viewer",
    password: "Synthetic-viewer-2026!",
  });
  assert(signed.ok && signed.value.account?.role === "viewer", "只读账号登录");
  const denied = await frame.contentWindow!.campusSec!.invoke({
    protocolVersion: "0.1.0",
    requestId: crypto.randomUUID(),
    method: "cases.create",
    payload: {
      title: "越权写入",
      scope,
      seedRefs: [],
    },
  });
  assert(
    !denied.result.ok && denied.result.error.code === "FORBIDDEN",
    "服务端拒绝越权写入",
  );
  const foreign = await frame.contentWindow!.campusSec!.invoke({
    protocolVersion: "0.1.0",
    requestId: crypto.randomUUID(),
    method: "cases.snapshot",
    payload: { caseId: caseRecord.id, evidencePage: { limit: 20 } },
  });
  assert(!foreign.result.ok, "不能读取管理员的案件");
  const accounts = await api.invoke("accounts", {});
  assert(
    !accounts.ok && accounts.error.code === "FORBIDDEN",
    "只读账号不能管理用户",
  );
  await api.invoke("logout", {});
  const blocked = await frame.contentWindow!.campusSec!.invoke({
    protocolVersion: "0.1.0",
    requestId: crypto.randomUUID(),
    method: "workspace.snapshot",
    payload: {},
  });
  assert(
    !blocked.result.ok && blocked.result.error.code === "UNAUTHENTICATED",
    "退出后拒绝业务 RPC",
  );
  const admin = await api.invoke("login", {
    username: "browser_admin",
    password: "Synthetic-browser-2026!",
  });
  assert(admin.ok && admin.value.account, "管理员重新登录");
  const last = await api.invoke("updateAccount", {
    id: admin.value.account.id,
    role: "viewer",
    enabled: true,
  });
  assert(!last.ok && last.error.code === "CONFLICT", "不能降级最后一个管理员");
  frame.src = "/";
  await until(
    () =>
      frame.contentDocument?.readyState === "complete" &&
      !!frame.contentDocument?.querySelector(".metric"),
    "认证刷新",
  );
});
async function start() {
  await until(
    () =>
      !!frame.contentWindow?.campusAuth &&
      !!frame.contentDocument?.querySelector("[name=username]"),
    "登录页面",
  );
  const doc = frame.contentDocument!;
  (doc.querySelector("[name=username]") as HTMLInputElement).value =
    "browser_admin";
  (doc.querySelector("[name=password]") as HTMLInputElement).value =
    "Synthetic-browser-2026!";
  await click("创建管理员并登录");
  await until(
    () => !!frame.contentDocument?.querySelector(".metric"),
    "登录后网页装配",
  );
  let passed = 0;
  const failures: string[] = [];
  for (const [name, action] of tests) {
    const li = document.createElement("li");
    li.textContent = "运行中 · " + name;
    results.append(li);
    try {
      await action();
      passed++;
      li.className = "pass";
      li.textContent = "通过 · " + name;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(name + ": " + message);
      li.className = "fail";
      li.textContent = "失败 · " + name + "：" + message;
    }
  }
  document.getElementById("qa-summary")!.textContent =
    `${passed} / ${tests.length} 项通过`;
  document.title = `核心网页验收 ${passed}/${tests.length}`;
  await fetch("/qa/result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "flows",
      passed,
      total: tests.length,
      failures,
      realWazuh: false,
      realModel: false,
      realTeleAgent: false,
      electronExecuted: false,
    }),
  });
}
void start();
