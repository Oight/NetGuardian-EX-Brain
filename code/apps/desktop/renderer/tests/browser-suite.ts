/** Browser-only acceptance. Synthetic DesktopApi, real production DOM/CSS; never imported by the product. */
import type {
  DesktopApi,
  DesktopMethodMap,
  RpcRequest,
} from "@campussec/contracts";
import { mountWorkbench } from "../app.js";

const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-24T00:30:00.000Z",
  scope = {
    connectionId: id(1),
    agentIds: ["001"],
    from: "2026-10-24T00:00:00.000Z",
    to: at,
    timeZone: "Asia/Shanghai",
  };
const record = {
  id: id(2),
  spaceId: id(3),
  revision: 2,
  title: "合成验收案件",
  scope,
  status: "pending",
  createdAt: at,
  updatedAt: at,
};
const context = {
  id: id(4),
  caseId: record.id,
  connectionId: id(1),
  agentIds: ["001"],
  version: 1,
  text: "<img src=x onerror=alert(1)> 合成人工说明",
  sourceLabel: "合成来源",
  verification: "unverified",
  authorId: id(5),
  from: scope.from,
  to: at,
};
const evidence = {
  id: id(6),
  spaceId: id(3),
  connectionId: id(1),
  version: 1,
  source: {
    platformInstanceId: id(7),
    kind: "index_document",
    index: "synthetic-alerts",
    documentId: "source-1",
  },
  kind: "alert",
  timeQuality: "source",
  observedAt: at,
  retrievedAt: at,
  contentHash: "a".repeat(64),
  fields: { message: "本地完整快照" },
  availability: "available",
};
const statement = {
  text: "合成事实，需核对引用",
  evidenceRefs: [{ evidenceId: id(6), version: 1, projectionId: id(8) }],
  queryIds: [],
  contextRefs: [],
};
const report = {
  id: id(9),
  caseId: record.id,
  runId: id(10),
  version: 1,
  baseRevision: 1,
  candidate: {
    caseId: record.id,
    runId: id(10),
    question: "合成调查问题",
    facts: [statement],
    analysis: [],
    conflicts: [],
    gaps: ["采集覆盖未知"],
    classification: "insufficient_evidence",
    stopReason: "evidence_unavailable",
    followups: [],
  },
  validation: "needs_review",
  review: "unreviewed",
  validationIssues: [],
  createdAt: at,
};
const followup = {
  id: id(11),
  caseId: record.id,
  revision: 2,
  question: "请确认维护工单",
  suggestedAction: "联系值班人员核对",
  state: "waiting",
  evidenceRefs: [],
  responsibleRole: "值班人员",
};
const results = document.getElementById("qa-results")!,
  frame = document.getElementById("qa-frame") as HTMLIFrameElement;
type Method = keyof DesktopMethodMap;
// The only dynamic types are at this test double's wire boundary. Each request is also checked by S01.
type Handler = (payload: any) => any;
class Fixture {
  calls: RpcRequest<Method>[] = [];
  handlers = new Map<Method, Handler>();
  space = id(3);
  set<K extends Method>(
    method: K,
    handler: (payload: DesktopMethodMap[K]["input"]) => unknown,
  ) {
    this.handlers.set(method, handler);
  }
  constructor() {
    this.set("runtime.status", () => ({
      state: "degraded",
      spaceId: this.space,
      hostCapabilities: [],
      trayEnabled: false,
    }));
    this.set("runtime.settings", () => ({
      revision: 1,
      trayEnabled: false,
      budgetTimeZone: "Asia/Shanghai",
    }));
    this.set("workspace.snapshot", () => ({
      eventSeq: 0,
      generatedAt: at,
      connections: [{ id: id(1), displayName: "合成平台", generation: 1 }],
      cases: [record],
      requests: [],
      jobs: [],
      totals: { cases: 1, queued: 0, active: 0 },
    }));
    this.set("events.read", () => ({
      events: [],
      lastSeq: 0,
      resetRequired: false,
    }));
    this.set("cases.list", () => ({ items: [record] }));
    this.set("cases.snapshot", () => ({
      case: record,
      evidence: [evidence],
      contexts: [context],
      queries: [],
    }));
    this.set("reports.list", () => [report]);
    this.set("followups.list", () => [followup]);
    this.set("followups.search", () => ({ items: [followup] }));
  }
  api: DesktopApi = {
    invoke: async (request) => {
      const validation = await fetch("/qa/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!validation.ok)
        throw new Error(
          `S01 rejected ${request.method}: ${await validation.text()}`,
        );
      this.calls.push(structuredClone(request));
      const handler = this.handlers.get(request.method);
      const response = handler
        ? await handler(request.payload)
        : {
            ok: false,
            error: {
              code: "CAPABILITY_UNAVAILABLE",
              message: "合成环境：能力未接入",
              retryable: false,
            },
          };
      return {
        protocolVersion: "0.1.0",
        requestId: request.requestId,
        result:
          response && typeof response === "object" && "ok" in response
            ? response
            : { ok: true, value: response },
      } as never;
    },
  };
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function until(predicate: () => boolean, label: string) {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > 5000) throw new Error(`超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
function dom() {
  return frame.contentDocument!;
}
function find(label: string, host: ParentNode = dom()): HTMLButtonElement {
  const result = Array.from(
    host.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (b) => b.textContent === label || b.getAttribute("aria-label") === label,
  );
  assert(result, `找不到按钮 ${label}`);
  return result;
}
function fill(name: string, value: string, host: ParentNode = dom()) {
  const input = host.querySelector<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >(`[name="${name}"]`);
  assert(input, `找不到字段 ${name}`);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return input;
}
async function click(label: string, host?: ParentNode) {
  find(label, host).click();
  await new Promise((resolve) => setTimeout(resolve, 40));
}
const tests: [string, (fixture: Fixture) => Promise<void>][] = [];
function test(name: string, action: (fixture: Fixture) => Promise<void>) {
  tests.push([name, action]);
}

test("导航、真实概览和未知状态；不显示虚构风险评分", async () => {
  assert(
    dom().querySelectorAll("nav button").length === 11,
    "应有 11 个明确页面入口",
  );
  assert(dom().querySelectorAll(".metric").length === 4, "应显示服务端摘要");
  assert(!dom().body.textContent!.includes("安全评分"), "不应生成风险评分");
  await click("调查与案件");
  await until(() => !!dom().querySelector(".table-title"), "案件列表");
  assert(
    dom().body.textContent!.includes(record.title),
    "列表应包含真实返回的标题",
  );
});
test("11 个入口在同一文档中切换，保持 Electron 精确 URL 的 IPC 授权", async () => {
  const url = dom().location.href;
  const entries = Array.from(
    dom().querySelectorAll<HTMLButtonElement>("nav button"),
  );
  for (const entry of entries) {
    entry.click();
    await until(
      () => entry.getAttribute("aria-current") === "page",
      "页面切换",
    );
    assert(dom().location.href === url, "导航不能改变 hash、路径或文档");
  }
});
test("Electron 默认窗口和最小窗口均可阅读案件表单", async () => {
  for (const width of [1160, 780]) {
    frame.width = String(width);
    await click(record.title);
    await until(() => !!dom().querySelector("[name=text]"), "案件背景");
    await new Promise((done) => setTimeout(done, 50));
    assert(
      dom().documentElement.scrollWidth <= width + 1,
      "桌面窗口不得整页横向溢出",
    );
    const text = dom().querySelector("[name=text]")!.getBoundingClientRect();
    assert(
      text.width >= 150 && text.right <= width + 1,
      "背景编辑器应保持可用",
    );
    await click("安全概览");
    await until(() => !!dom().querySelector(".metric"), "返回概览");
  }
});
test("凭据对话框关闭后清空脱离 DOM 的字段，不写入浏览器存储", async () => {
  await click("平台连接");
  await click("设置凭据");
  const modal = dom().querySelector("dialog")!;
  const username = fill("username", "synthetic-user", modal),
    password = fill("password", "synthetic-password", modal);
  await click("关闭", modal);
  assert(
    username.value === "" && password.value === "",
    "关闭时应清空凭据控件",
  );
  const storage = dom().defaultView!.localStorage;
  for (let i = 0; i < storage.length; i++)
    assert(
      !storage.getItem(storage.key(i)!)?.includes("synthetic-"),
      "凭据不得写入存储",
    );
});
test("调查失败保留输入，同范围重试保留业务键，修改问题使用新键", async (fixture) => {
  await click("发起调查");
  const modal = dom().querySelector("dialog")!;
  fill("question", "检查合成设备的登录", modal);
  fill("agents", "001", modal);
  await click("发起调查", modal);
  await until(
    () => !!modal.querySelector(".modal-error")!.textContent,
    "明确错误",
  );
  assert(
    (modal.querySelector("[name=question]") as HTMLTextAreaElement).value ===
      "检查合成设备的登录",
    "失败应保留问题",
  );
  await click("发起调查", modal);
  await until(
    () =>
      fixture.calls.filter((c) => c.method === "requests.create").length === 2,
    "第二次提交",
  );
  const calls = fixture.calls.filter(
    (c) => c.method === "requests.create",
  ) as RpcRequest<"requests.create">[];
  assert(
    calls[0]!.payload.idempotencyKey === calls[1]!.payload.idempotencyKey,
    "重试必须保留业务键",
  );
  fill("question", "检查另一个合成问题", modal);
  await click("发起调查", modal);
  await until(
    () =>
      fixture.calls.filter((c) => c.method === "requests.create").length === 3,
    "第三次提交",
  );
  const last = fixture.calls
    .filter((c) => c.method === "requests.create")
    .at(-1) as RpcRequest<"requests.create">;
  assert(
    last.payload.origin === "client_user" &&
      !("originBindingId" in last.payload),
    "客户端不能伪造来源绑定",
  );
  assert(
    last.payload.idempotencyKey !== calls[0]!.payload.idempotencyKey,
    "新问题必须使用新键",
  );
});
test("案件版本冲突保留正文，恶意 HTML 保持纯文本", async (fixture) => {
  await click(record.title);
  await until(() => !!dom().querySelector("[name=text]"), "背景编辑器");
  assert(!dom().querySelector("img"), "背景正文不得执行 HTML");
  assert(
    dom().body.textContent!.includes("<img src=x"),
    "恶意内容应按文本显示",
  );
  fixture.set("cases.putContext", () => ({
    ok: false,
    error: {
      code: "REVISION_CONFLICT",
      message: "案件已更新，请审阅",
      retryable: false,
    },
  }));
  fill("text", "必须保留的草稿");
  await click("保存背景版本");
  await until(
    () =>
      dom().querySelector(".error")!.textContent!.includes("REVISION_CONFLICT"),
    "版本冲突",
  );
  assert(
    (dom().querySelector("[name=text]") as HTMLTextAreaElement).value ===
      "必须保留的草稿",
    "冲突不得丢弃输入",
  );
});
test("设备分页与采集详情保留 partial、原始观察时间和来源", async (fixture) => {
  fixture.set("connections.agents", (payload) =>
    payload.page.cursor
      ? { items: [{ id: "002", name: "第二页设备", status: "disconnected" }] }
      : {
          items: [{ id: "001", name: "第一页设备", status: "active" }],
          nextCursor: "page-2",
        },
  );
  fixture.set("devices.detail", (payload) => ({
    agentId: payload.agentId,
    category: payload.category,
    items: [
      {
        source: {
          platformInstanceId: id(7),
          kind: "resource",
          resource: "syscollector",
          agentId: "002",
          collectionIdentity: "scan-1",
        },
        kind: "inventory",
        agentId: "002",
        observedAt: "2025-01-01T00:00:00.000Z",
        timeQuality: "source",
        retrievedAt: at,
        fields: { os: "合成操作系统" },
      },
    ],
    retrievedAt: at,
    status: "partial",
    warnings: ["合成扫描较旧"],
  }));
  await click("设备与资产");
  await click("读取设备");
  await until(() => dom().body.textContent!.includes("第一页设备"), "第一页");
  await click("下一页设备");
  await until(() => dom().body.textContent!.includes("第二页设备"), "第二页");
  assert(!dom().body.textContent!.includes("第一页设备"), "不得混合不同页");
  await click("采集详情");
  await until(
    () => dom().querySelector("dialog")!.textContent!.includes("合成扫描较旧"),
    "设备详情",
  );
  assert(
    dom().querySelector("dialog")!.textContent!.includes("部分结果"),
    "应保留部分结果",
  );
});
test("告警筛选、选择建案和原始证据引用", async (fixture) => {
  fixture.set("alerts.list", () => ({
    items: [
      {
        id: id(12),
        connectionId: id(1),
        sourceKey: "b".repeat(64),
        receiveSeq: 1,
        kind: "history",
        evidence: { evidenceId: id(6), version: 1 },
        agentId: "001",
        ruleId: "5710",
        ruleGroups: ["authentication"],
        level: 12,
        observedAt: at,
        receivedAt: at,
        read: false,
        decisionReason: "历史条目不自动调查",
      },
    ],
  }));
  fixture.set("cases.create", () => record);
  await click("告警收件箱");
  await until(
    () => !!dom().querySelector("td input[type=checkbox]"),
    "告警列表",
  );
  fill("minLevel", "12");
  await click("读取告警");
  await until(
    () => fixture.calls.filter((c) => c.method === "alerts.list").length === 2,
    "筛选提交",
  );
  (dom().querySelector("td input[type=checkbox]") as HTMLInputElement).click();
  await click("选中建案");
  const modal = dom().querySelector("dialog")!;
  fill("title", "告警建案", modal);
  fill("agents", "001", modal);
  await click("保存案件", modal);
  await until(
    () => fixture.calls.some((c) => c.method === "cases.create"),
    "保存案件",
  );
  const call = fixture.calls.find(
    (c) => c.method === "cases.create",
  ) as RpcRequest<"cases.create">;
  assert(
    call.payload.seedRefs[0]?.evidenceId === id(6),
    "建案应绑定选中的证据身份",
  );
});
test("报告引用优先展示交付投影，修订时保留证据身份", async (fixture) => {
  fixture.set("evidence.get", () => ({
    evidence,
    projection: {
      id: id(8),
      runId: id(10),
      ref: { evidenceId: id(6), version: 1 },
      content: { message: "已交付的字段投影" },
      contentHash: "c".repeat(64),
      state: "released",
      preparedAt: at,
      releasedAt: at,
      availability: "available",
    },
  }));
  fixture.set("reports.review", () => ({
    ...report,
    review: "revised",
    version: 2,
  }));
  await click("调查报告");
  fill("caseId", id(2));
  await click("读取报告");
  await until(
    () => dom().body.textContent!.includes("合成事实，需核对引用"),
    "报告列表",
  );
  await click(`证据 ${id(6).slice(0, 8)} · v1`);
  await until(
    () =>
      dom().querySelector("dialog")!.textContent!.includes("已交付的字段投影"),
    "证据投影",
  );
  assert(dom().querySelector("dialog details"), "完整快照应单独展开");
  await click("关闭", dom().querySelector("dialog")!);
  await click("人工审核此报告");
  const modal = dom().querySelector("dialog")!;
  fill("disposition", "revised", modal);
  fill("facts-0", "人工修订后仍保留原引用", modal);
  await click("新增分析", modal);
  fill("analysis-0", "补充人工解释并绑定已有交付证据", modal);
  (modal.querySelector("[name=analysis-0-ref-0]") as HTMLInputElement).click();
  fill("note", "人工检查了当前材料", modal);
  await click("保存人工审核", modal);
  await until(
    () => fixture.calls.some((c) => c.method === "reports.review"),
    "保存审核",
  );
  const call = fixture.calls.find(
    (c) => c.method === "reports.review",
  ) as RpcRequest<"reports.review">;
  assert(
    call.payload.revisedCandidate?.facts[0]?.evidenceRefs[0]?.projectionId ===
      id(8),
    "修订不可丢弃交付身份",
  );
  assert(
    call.payload.revisedCandidate?.analysis[0]?.evidenceRefs[0]
      ?.projectionId === id(8),
    "新增分析应允许明确绑定已有交付引用",
  );
  assert(
    call.payload.expectedCaseRevision === record.revision,
    "审核必须使用案件 CAS",
  );
});
test("导出先预览，取消保存不得显示导出成功", async (fixture) => {
  fixture.set("cases.export", () => ({
    ok: false,
    error: { code: "CANCELLED", message: "用户取消保存", retryable: false },
  }));
  await click("调查报告");
  fill("caseId", id(2));
  await click("读取报告");
  await until(
    () =>
      Array.from(dom().querySelectorAll("button")).some(
        (b) => b.textContent === "预览交接与导出",
      ),
    "导出入口",
  );
  assert(
    !fixture.calls.some((c) => c.method === "cases.export"),
    "读取报告不应自动导出",
  );
  await click("预览交接与导出");
  await until(() => !!dom().querySelector("dialog"), "导出预览");
  await click("选择路径并导出", dom().querySelector("dialog")!);
  await until(
    () =>
      dom().querySelector(".modal-error")!.textContent!.includes("CANCELLED"),
    "导出取消反馈",
  );
  assert(
    !dom().querySelector(".message")!.textContent!.includes("已由桌面保存"),
    "取消不得冒充保存成功",
  );
});
test("核查记录保留事项版本；新增记录通过 S01 schema", async (fixture) => {
  fixture.set("followups.put", (payload) => ({
    ...payload.item,
    revision: payload.expectedRevision + 1,
  }));
  await click("核查与交接");
  await until(
    () => dom().body.textContent!.includes(followup.question),
    "核查事项",
  );
  await click("处理记录");
  const modal = dom().querySelector("dialog")!;
  fill("note", "已联系值班人员，尚无新的观测证据", modal);
  fill("state", "completed", modal);
  await click("保存核查事项", modal);
  await until(
    () => fixture.calls.some((c) => c.method === "followups.put"),
    "保存核查",
  );
  const call = fixture.calls.find(
    (c) => c.method === "followups.put",
  ) as RpcRequest<"followups.put">;
  assert(
    call.payload.expectedRevision === followup.revision,
    "核查修改必须保留 CAS",
  );
  await until(() => !dom().querySelector("dialog"), "关闭事项编辑器");
  await click("新增核查事项");
  const create = dom().querySelector("dialog")!;
  fill("caseId", id(2), create);
  fill("question", "请核对另一项授权", create);
  fill("suggestedAction", "核对授权记录", create);
  await click("保存核查事项", create);
  await until(
    () =>
      fixture.calls.filter((c) => c.method === "followups.put").length === 2,
    "新增核查",
  );
});
test("清理先预览，过期计划不可应用；设置保存不自动清理", async (fixture) => {
  fixture.set("retention.preview", () => ({
    id: id(20),
    planHash: "d".repeat(64),
    expiresAt: "2000-01-01T00:00:00.000Z",
    caseIds: [id(2)],
    caseRevisions: [{ caseId: id(2), revision: 2 }],
    removableVersions: 1,
    blockedVersions: 2,
    approximateBytes: 100,
  }));
  await click("工作空间设置");
  await until(
    () =>
      Array.from(dom().querySelectorAll("button")).some(
        (b) => b.textContent === "预览证据清理",
      ),
    "设置页",
  );
  await click("预览证据清理");
  const modal = dom().querySelector("dialog")!;
  fill("caseIds", id(2), modal);
  await click("生成清理预览", modal);
  await until(
    () =>
      Array.from(modal.querySelectorAll("button")).some(
        (b) => b.textContent === "应用这份清理计划",
      ),
    "清理计划",
  );
  await click("应用这份清理计划", modal);
  await until(
    () => modal.querySelector(".modal-error")!.textContent!.includes("过期"),
    "过期反馈",
  );
  assert(
    !fixture.calls.some((c) => c.method === "retention.apply"),
    "过期计划不可发送清理",
  );
});
test("迟到的设备响应不覆盖已经切换到的案件页面", async (fixture) => {
  let resolve: (data: unknown) => void = () => {};
  fixture.set(
    "connections.agents",
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await click("设备与资产");
  await click("读取设备");
  await until(
    () => fixture.calls.some((c) => c.method === "connections.agents"),
    "设备请求",
  );
  await click("调查与案件");
  resolve({ items: [{ id: "009", name: "迟到设备" }] });
  await new Promise((done) => setTimeout(done, 80));
  assert(
    !dom().body.textContent!.includes("迟到设备"),
    "旧请求不得跨页插入数据",
  );
});
test("事件通知保留脏表单，主体空间变更清空旧数据", async (fixture) => {
  await click(record.title);
  await until(() => !!dom().querySelector("[name=text]"), "背景编辑器");
  fill("text", "主体切换前的输入");
  fixture.set("events.read", () => ({
    events: [
      {
        seq: 1,
        type: "case.changed",
        spaceId: id(3),
        aggregateId: id(2),
        revision: 3,
        occurredAt: at,
        traceId: id(31),
        payload: { caseId: id(2), revision: 3, reason: "synthetic" },
      },
    ],
    lastSeq: 1,
    resetRequired: false,
  }));
  await until(
    () => dom().querySelector(".message")!.textContent!.includes("新版本"),
    "事件提示",
  );
  assert(
    (dom().querySelector("[name=text]") as HTMLTextAreaElement).value ===
      "主体切换前的输入",
    "事件不得覆盖输入",
  );
  fixture.space = id(32);
  fixture.set("events.read", () => ({
    events: [
      {
        seq: 2,
        type: "runtime.changed",
        spaceId: id(32),
        aggregateId: id(32),
        revision: 1,
        occurredAt: at,
        traceId: id(33),
        payload: { state: "degraded" },
      },
    ],
    lastSeq: 2,
    resetRequired: false,
  }));
  await until(
    () =>
      dom().querySelector(".message")!.textContent!.includes("主体空间已改变"),
    "主体切换",
  );
  assert(!dom().querySelector("textarea[name=text]"), "主体切换必须移除旧表单");
});
test("真实统计绘图保持下界与 partial，数据表可读", async (fixture) => {
  fixture.set("statistics.alerts", (scope) => ({
    scope,
    total: { value: 99, relation: "gte" },
    byLevel: [
      { level: 12, count: 10 },
      { level: 5, count: 89 },
    ],
    byHour: [
      { start: scope.from, count: 45 },
      { start: scope.to, count: 54 },
    ],
    coverage: {
      requestedScope: scope,
      effectiveScope: scope,
      queryCompleteness: "partial",
      collectionCoverage: "unknown",
      sourceTypes: ["alerts"],
      reasons: ["合成分片缺口"],
      retrievedAt: at,
      returned: 99,
    },
  }));
  (dom().querySelector(".disclosure summary") as HTMLElement).click();
  fill("agents", "001");
  await click("查询告警统计");
  await until(() => !!dom().querySelector(".trend-chart"), "趋势图");
  assert(dom().body.textContent!.includes("99+"), "统计必须保留计数下界");
  assert(
    dom().body.textContent!.includes("合成分片缺口"),
    "统计必须保留查询缺口",
  );
  assert(dom().querySelector(".trend-chart title"), "图表应有可访问名称");
});
test("待补充范围经 provideInput 保存；恢复只在实际 hold 时出现", async (fixture) => {
  const request = {
    id: id(40),
    origin: "client_user",
    state: "awaiting_scope",
    connectionId: id(1),
    question: "需要补充范围的合成问题",
    seedRefs: [],
    missingFields: ["agentIds"],
    createdAt: at,
    expiresAt: at,
  };
  const job = {
    id: id(41),
    requestId: id(40),
    caseId: id(2),
    origin: "client_user",
    state: "queued",
    revision: 1,
    createdAt: at,
    updatedAt: at,
    expiresAt: at,
    recoveryHold: true,
  };
  let current: unknown = { request };
  fixture.set("requests.status", () => current);
  fixture.set("requests.provideInput", (payload) => {
    current = {
      request: {
        ...request,
        state: "accepted",
        requestedScope: payload.scope,
        effectiveScope: payload.scope,
        missingFields: [],
      },
      job,
    };
    return current;
  });
  fixture.set("workspace.snapshot", () => ({
    eventSeq: 0,
    generatedAt: at,
    connections: [{ id: id(1), displayName: "合成平台", generation: 1 }],
    cases: [record],
    requests: [request],
    jobs: [],
    totals: { cases: 1, queued: 0, active: 0 },
  }));
  await click("调查任务");
  await until(
    () =>
      Array.from(dom().querySelectorAll("button")).some(
        (b) => b.textContent === "查看进展",
      ),
    "请求列表",
  );
  await click("查看进展");
  const modal = dom().querySelector("dialog")!;
  await until(() => modal.textContent!.includes("补充范围与说明"), "补充范围");
  (
    Array.from(modal.querySelectorAll("summary")).find(
      (s) => s.textContent === "补充范围与说明",
    ) as HTMLElement
  ).click();
  fill("agents", "001", modal);
  fill("text", "合成范围补充", modal);
  await click("保存补充输入", modal);
  await until(() => modal.textContent!.includes("恢复未提交任务"), "恢复 hold");
  assert(
    fixture.calls.some((c) => c.method === "requests.provideInput"),
    "应使用 provideInput 而不是再次 create",
  );
});
test("uncertain 必须显式核实，读取本地状态不自动核实或重跑", async (fixture) => {
  const request = {
    id: id(50),
    origin: "client_user",
    state: "accepted",
    connectionId: id(1),
    question: "远端状态未知的合成请求",
    seedRefs: [],
    missingFields: [],
    caseId: id(2),
    requestedScope: scope,
    createdAt: at,
    expiresAt: at,
  };
  const job = {
    id: id(51),
    requestId: id(50),
    caseId: id(2),
    runId: id(10),
    origin: "client_user",
    state: "uncertain",
    revision: 3,
    createdAt: at,
    updatedAt: at,
    expiresAt: at,
    recoveryHold: false,
  };
  fixture.set("workspace.snapshot", () => ({
    eventSeq: 0,
    generatedAt: at,
    connections: [{ id: id(1), displayName: "合成平台", generation: 1 }],
    cases: [record],
    requests: [request],
    jobs: [job],
    totals: { cases: 1, queued: 0, active: 0 },
  }));
  fixture.set("requests.status", () => ({ request, job }));
  fixture.set("requests.reconcile", () => ({ request, job }));
  await click("调查任务");
  await until(
    () =>
      Array.from(dom().querySelectorAll("button")).some(
        (b) => b.textContent === "查看进展",
      ),
    "请求列表",
  );
  await click("查看进展");
  const modal = dom().querySelector("dialog")!;
  await until(() => modal.textContent!.includes("核实远端状态"), "核实入口");
  assert(
    !fixture.calls.some((c) => c.method === "requests.reconcile"),
    "只读状态不得自动核实",
  );
  await click("读取最新状态", modal);
  assert(
    !fixture.calls.some((c) => c.method === "requests.reconcile"),
    "刷新本地状态不得核实",
  );
  await click("核实远端状态", modal);
  await until(
    () => fixture.calls.some((c) => c.method === "requests.reconcile"),
    "显式核实",
  );
  const call = fixture.calls.find(
    (c) => c.method === "requests.reconcile",
  ) as RpcRequest<"requests.reconcile">;
  assert(call.payload.expectedJobRevision === 3, "核实必须带任务版本");
  assert(
    !fixture.calls.some((c) => c.method === "requests.create"),
    "核实不能重跑调查",
  );
});
test("摘要未包含任务时，不把已有 jobId 显示成尚未创建", async (fixture) => {
  const request = {
    id: id(70),
    jobId: id(71),
    origin: "client_user",
    state: "accepted",
    connectionId: id(1),
    question: "已排队但不在活动任务摘要中的请求",
    seedRefs: [],
    missingFields: [],
    caseId: id(2),
    requestedScope: scope,
    createdAt: at,
    expiresAt: at,
  };
  fixture.set("workspace.snapshot", () => ({
    eventSeq: 0,
    generatedAt: at,
    connections: [{ id: id(1), displayName: "合成平台", generation: 1 }],
    cases: [record],
    requests: [request],
    jobs: [],
    totals: { cases: 1, queued: 1, active: 0 },
  }));
  await click("调查任务");
  await until(
    () => dom().body.textContent!.includes(request.question),
    "已有任务的请求",
  );
  assert(
    dom().body.textContent!.includes("状态待读取"),
    "应提示读取具体任务状态",
  );
  assert(
    !dom().body.textContent!.includes("尚未创建任务"),
    "摘要缺少 job 不能推断 job 不存在",
  );
});
test("390px 窄屏导航、模态框和深色主题", async () => {
  frame.width = "390";
  await new Promise((done) => setTimeout(done, 50));
  assert(dom().documentElement.scrollWidth <= 391, "窄屏不得整页横向溢出");
  await click("展开导航");
  assert(
    dom().querySelector(".workbench")!.classList.contains("nav-open"),
    "菜单应可展开",
  );
  dom().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  assert(
    find("展开导航").getAttribute("aria-expanded") === "false",
    "Escape 应同步更新菜单状态",
  );
  await click("展开导航");
  await click("关闭导航");
  await click("切换主题");
  assert(
    dom().querySelector(".workbench")!.getAttribute("data-theme") === "dark",
    "主题应立即更新",
  );
  await click("发起调查");
  assert(
    dom().querySelector("dialog")!.getBoundingClientRect().width < 390,
    "模态框应适配窄屏",
  );
  await click("关闭", dom().querySelector("dialog")!);
  await click("切换主题");
  frame.width = "1280";
});

async function start() {
  await new Promise<void>((resolve) => {
    if (frame.contentDocument?.readyState === "complete") resolve();
    else frame.addEventListener("load", () => resolve(), { once: true });
  });
  let passed = 0;
  const failures: string[] = [];
  for (const [name, action] of tests) {
    const fixture = new Fixture(),
      container = dom().getElementById("app")!;
    frame.width = "1280";
    dom().defaultView!.localStorage.removeItem("netguardian-ui-theme");
    const mounted = mountWorkbench({ element: container, api: fixture.api });
    const item = document.createElement("li");
    item.textContent = `运行中 · ${name}`;
    results.append(item);
    try {
      await until(() => !!container.querySelector(".metric"), "初始概览");
      await action(fixture);
      item.textContent = `通过 · ${name}`;
      item.className = "pass";
      passed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name}: ${message}`);
      item.textContent = `失败 · ${name}：${message}`;
      item.className = "fail";
    } finally {
      mounted.unmount();
    }
  }
  document.getElementById("qa-summary")!.textContent =
    `${passed} / ${tests.length} 项通过${failures.length ? "，请检查失败项" : " · 全部通过"}`;
  document.title = `前端验收 ${passed}/${tests.length}`;
  await fetch("/qa/result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      passed,
      total: tests.length,
      failures,
      nodeExecuted: false,
      electronExecuted: false,
    }),
  });
}
if (results && frame) void start();
export { Fixture, record, scope, report, evidence, context, followup, id };
