import type { EvidenceRef, RequestStatus, Scope } from "@campussec/contracts";
import type { WorkbenchContext } from "./context.js";
import {
  canResume,
  formatTime,
  jobStates,
  stateText,
  submissionKey,
} from "./model.js";

export function createInvestigationViews(ctx: WorkbenchContext) {
  const { ui, invoke, begin, run, submit, value, dialog } = ctx;
  const {
    el,
    card,
    button,
    field,
    table,
    state,
    facts,
    notice,
    empty,
    disclosure,
  } = ui;
  function form(
    host: HTMLElement,
    scope?: Scope,
    caseId?: string,
    refs: EvidenceRef[] = [],
    valid = () => host.isConnected,
  ) {
    const form = el("form", undefined, "form-grid");
    const question = field(form, "调查问题", "question", "", "textarea");
    question.setAttribute("maxlength", "2000");
    question.placeholder = "例如：这次登录异常是否与已授权维护有关？";
    if (!scope) ctx.scopeFields(form);
    else
      host.append(
        facts([
          ["设备", scope.agentIds.join(", ")],
          [
            "范围 · " + scope.timeZone,
            `${formatTime(scope.from, scope.timeZone)} — ${formatTime(scope.to, scope.timeZone)}`,
          ],
        ]),
      );
    const key = submissionKey(),
      result = el("div");
    submit(form, "发起调查", async () => {
      const text = value(form, "question");
      if (!text || text.length > 2000)
        throw new Error("调查问题应为 1—2000 字");
      const payload = {
        origin: "client_user" as const,
        connectionId: scope?.connectionId ?? value(form, "connectionId"),
        question: text,
        requestedScope: scope ?? ctx.readScope(form),
        seedRefs: [...refs],
        ...(caseId ? { caseId } : {}),
      };
      const status = await invoke("requests.create", {
        ...payload,
        idempotencyKey: key(payload),
      });
      if (!valid()) return;
      result.replaceChildren(
        notice(
          `请求已${status.request.state === "accepted" ? "受理" : "登记"}，状态由调查服务确认。`,
        ),
      );
      renderStatus(result, status, valid);
      ctx.notify(
        `请求 ${status.request.id}：${stateText(status.request.state)}。任务受理不代表调查完成。`,
      );
    });
    host.append(
      form,
      notice(
        "调查受到固定范围、执行预算与宿主能力约束。服务不可用时保留填写内容，可在恢复后重试。",
      ),
      result,
    );
  }
  function open(scope?: Scope, caseId?: string, refs: EvidenceRef[] = []) {
    const modal = dialog(
      "发起调查",
      "先明确问题与范围。系统不会自动扩大设备、时间或工具权限。",
    );
    if (!ctx.connections().length) {
      modal.body.append(
        empty(
          "尚未配置平台连接",
          "先保存连接，再选择设备与时间范围。",
          button(
            "前往平台连接",
            () => {
              modal.close();
              void run(undefined, () => ctx.navigate("connections"));
            },
            "button primary",
            "connections",
          ),
        ),
      );
      return;
    }
    form(modal.body, scope, caseId, refs, modal.valid);
  }
  function renderStatus(
    host: HTMLElement,
    status: RequestStatus,
    valid: () => boolean,
  ) {
    const { request, job, budget } = status,
      panel = card(
        "请求与执行状态",
        "本地状态读取不会暗中创建新会话或调用模型",
      );
    const chips = el("div", undefined, "actions");
    chips.append(
      state(
        request.state,
        request.state === "accepted" ? "已受理" : stateText(request.state),
      ),
    );
    if (job) chips.append(state(job.state, jobStates[job.state]));
    if (status.deliveryState)
      chips.append(
        state(
          status.deliveryState,
          `结果投递 · ${stateText(status.deliveryState)}`,
        ),
      );
    panel.body.append(chips, el("p", request.question, "request-question"));
    const scope = request.effectiveScope ?? request.requestedScope;
    panel.body.append(
      facts([
        ["发起入口", stateText(request.origin)],
        ["设备", scope?.agentIds.join(", ") ?? "待补充"],
        [
          "范围",
          scope
            ? `${formatTime(scope.from, scope.timeZone)} — ${formatTime(scope.to, scope.timeZone)}`
            : "待补充",
        ],
        ["请求有效至", formatTime(request.expiresAt)],
      ]),
    );
    if (budget)
      panel.body.append(
        facts([
          ["工具调用", `${budget.toolsUsed} 次`],
          ["读取调用", `${budget.readsUsed} 次`],
          ["平台尝试", `${budget.platformAttempts} 次`],
          ["不同事件", `${budget.distinctEvents} 条`],
          ["截止时间", formatTime(budget.deadline)],
          ["预算状态", budget.closed ? "已关闭" : "开放"],
        ]),
      );
    else
      panel.body.append(
        notice("当前请求没有可读取的运行预算；未知用量不显示为零。"),
      );
    if (job?.error)
      panel.body.append(
        notice(`${job.error.code}：${job.error.message}`, "warning"),
      );
    const current = el("div");
    host.append(panel.root, current);
    async function reread() {
      const next = await invoke("requests.status", { requestId: request.id });
      if (!valid()) return;
      panel.root.remove();
      current.remove();
      renderStatus(host, next, valid);
    }
    panel.body.append(
      button(
        "读取最新状态",
        () => void run(undefined, reread),
        "button secondary small-button",
        "refresh",
      ),
    );
    if (request.caseId)
      panel.body.append(
        button(
          "打开关联案件",
          () => void run(undefined, () => ctx.openCase(request.caseId!)),
          "button ghost small-button",
          "cases",
        ),
      );
    if (job?.runId) {
      const inputPages = el("div");
      async function loadInputs(cursor?: string) {
        const data = await invoke("investigations.input", {runId: job!.runId!, page:{limit:50, ...(cursor ? {cursor} : {})}});
        if (!valid()) return;
        const {nextCursor, ...body} = data;
        inputPages.append(disclosure("冻结输入与本轮投影", el("pre", JSON.stringify(body, null, 2), "code-block")));
        if (nextCursor) {
          const more = button("继续读取输入清单", () => void run(more, async () => {await loadInputs(nextCursor); more.remove();}), "button secondary small-button");
          inputPages.append(more);
        }
      }
      panel.body.append(button("查看当时调查输入", () => void run(undefined, async () => {inputPages.replaceChildren(); await loadInputs();}), "button secondary small-button"), inputPages);
      panel.body.append(
        button(
          "读取步骤与轮次",
          () =>
            void run(undefined, async () => {
              const data = await invoke("investigations.snapshot", {
                runId: job.runId!,
              });
              if (!valid()) return;
              const steps = card(
                "调查步骤",
                `运行 ${data.run.id.slice(0, 8)} · 基于案件版本 ${data.run.baseRevision}`,
              );
              for (const step of data.steps) {
                const row = el("article", undefined, "timeline-step");
                row.append(
                  el("span", step.phase, "eyebrow"),
                  el("h3", step.summary),
                  el("p", step.purpose ?? "未提供额外目的", "muted small"),
                  el("p", formatTime(step.createdAt), "small muted"),
                );
                steps.body.append(row);
              }
              if (!data.steps.length)
                steps.body.append(
                  empty(
                    "尚无步骤记录",
                    "请稍后读取，界面不会根据任务文案推断进展。",
                    undefined,
                    "requests",
                  ),
                );
              steps.body.append(
                disclosure(
                  "运行范围与预算",
                  el(
                    "pre",
                    JSON.stringify(
                      { run: data.run, budget: data.budget },
                      null,
                      2,
                    ),
                    "code-block",
                  ),
                ),
              );
              current.replaceChildren(steps.root);
            }),
          "button secondary small-button",
          "requests",
        ),
      );
    }
    if (
      request.state === "awaiting_scope" ||
      (job &&
        !["succeeded", "failed", "cancelled", "needs_review"].includes(
          job.state,
        ))
    ) {
      const supplement = el("form", undefined, "form-grid"),
        key = submissionKey();
      field(
        supplement,
        job ? "补充说明（下一轮使用）" : "补充说明",
        "text",
        "",
        "textarea",
        false,
      );
      if (request.state === "awaiting_scope") {
        supplement.append(
          notice(
            `缺少：${request.missingFields.join("、") || "请核对设备与时间"}`,
            "warning",
          ),
        );
        ctx.scopeFields(supplement, scope);
      } else
        supplement.append(
          notice(
            "已提交轮次不会因补充说明而被静默修改；说明由核心保存为后续输入。",
          ),
        );
      submit(supplement, "保存补充输入", async () => {
        const payload = {
          requestId: request.id,
          ...(request.state === "awaiting_scope"
            ? { scope: ctx.readScope(supplement) }
            : {}),
          ...(value(supplement, "text")
            ? { text: value(supplement, "text") }
            : {}),
        };
        await invoke("requests.provideInput", {
          ...payload,
          idempotencyKey: key(payload),
        });
        if (valid()) {
          ctx.notify(
            job ? "补充说明已登记，供下一轮使用。" : "补充输入已保存。",
          );
          await reread();
        }
      });
      panel.body.append(disclosure("补充范围与说明", supplement));
    }
    if (
      request.state !== "withdrawn" &&
      (!job ||
        !["succeeded", "failed", "cancelled", "needs_review"].includes(
          job.state,
        ))
    ) {
      const cancel = el("form", undefined, "form-grid");
      field(cancel, "停止理由", "reason", "", "textarea");
      submit(cancel, "请求停止调查", async () => {
        await invoke("requests.cancel", {
          requestId: request.id,
          reason: value(cancel, "reason"),
        });
        if (valid()) {
          ctx.notify("停止请求已提交；需以服务端确认状态为准。");
          await reread();
        }
      });
      panel.body.append(disclosure("停止调查", cancel));
    }
    if (job && canResume(job))
      panel.body.append(
        button(
          "恢复未提交任务",
          () =>
            void run(undefined, async () => {
              await invoke("requests.resume", {
                requestId: request.id,
                expectedJobRevision: job.revision,
              });
              if (valid()) await reread();
            }),
          "button secondary small-button",
          "refresh",
        ),
      );
    if (job?.state === "uncertain") {
      panel.body.append(
        notice(
          "远端可能仍在运行。先核实状态；明确放弃只记录本地决定，不代表远端已经停止。",
          "warning",
        ),
        button(
          "核实远端状态",
          () =>
            void run(undefined, async () => {
              await invoke("requests.reconcile", {
                requestId: request.id,
                expectedJobRevision: job.revision,
              });
              if (valid()) await reread();
            }),
          "button secondary small-button",
          "refresh",
        ),
      );
      const abandon = el("form", undefined, "form-grid");
      field(abandon, "明确放弃理由", "reason", "", "textarea");
      submit(abandon, "明确放弃本地等待", async () => {
        await invoke("requests.abandon", {
          requestId: request.id,
          expectedJobRevision: job.revision,
          reason: value(abandon, "reason"),
        });
        if (valid()) await reread();
      });
      panel.body.append(disclosure("明确放弃", abandon));
    }
    const results = el("div"),
      resultActions = el("div", undefined, "actions");
    resultActions.append(
      button(
        "读取结果包",
        () =>
          void run(undefined, async () => {
            const data = await invoke("results.get", { requestId: request.id });
            if (!valid()) return;
            const resultCard = card(
              "调查结果",
              `版本 ${data.resultVersion} · ${data.review === "unreviewed" ? "未经人工审核" : stateText(data.review)}`,
            );
            resultCard.body.append(
              state(data.terminalState, jobStates[data.terminalState]),
              el("p", data.summary, "preserve-lines"),
            );
            if (data.gaps.length)
              resultCard.body.append(notice(data.gaps.join("；"), "warning"));
            if (data.error)
              resultCard.body.append(
                notice(`${data.error.code}：${data.error.message}`, "danger"),
              );
            resultCard.body.append(
              disclosure(
                "结果与引用详情",
                el("pre", JSON.stringify(data, null, 2), "code-block"),
              ),
            );
            results.replaceChildren(resultCard.root);
          }),
        "button secondary small-button",
        "reports",
      ),
      button(
        "读取投递状态",
        () =>
          void run(undefined, async () => {
            const data = await invoke("deliveries.status", {
              requestId: request.id,
            });
            if (!valid()) return;
            const grid = table(["结果版本", "投递状态", "尝试次数", "回执", "恢复"]);
            for (const item of data) {
              const recovery = el("span", "无需恢复");
              if (item.state === "blocked" || item.state === "uncertain" || item.state === "retryable_failed") {
                const expectedState = item.state;
                recovery.replaceChildren(button("核实并恢复", () => {
                  const modal = dialog("核实投递并恢复", "宿主确认已收到时记录回执；确认安全重试时进入待投递队列。无法确认时保留原状态。");
                  const form = el("form", undefined, "form-grid");
                  field(form, "恢复原因", "reason", "", "textarea");
                  submit(form, "核实并恢复", async () => {
                    const result = await invoke("deliveries.recover", {deliveryId:item.id, expectedState, expectedAttempts:item.attempts, reason:value(form,"reason")});
                    if (modal.valid()) {modal.close(); ctx.notify(`投递状态已更新：${stateText(result.state)}`);}
                  });
                  modal.body.append(form);
                }, "button secondary small-button"));
              }
              grid.row([
                String(item.resultVersion),
                state(item.state),
                String(item.attempts),
                item.receipt
                  ? JSON.stringify(item.receipt)
                  : (item.lastError?.message ?? "尚无确认回执"),
                recovery,
              ]);
            }
            results.replaceChildren(
              data.length
                ? grid.root
                : empty(
                    "暂无投递记录",
                    "没有记录不等于投递成功。",
                    undefined,
                    "connections",
                  ),
            );
          }),
        "button secondary small-button",
        "connections",
      ),
    );
    panel.body.append(
      resultActions,
      results,
      disclosure(
        "查看请求诊断",
        facts([
          ["请求 ID", request.id],
          ["任务 ID", job?.id ?? "尚未创建"],
          ["轮次 ID", job?.runId ?? "尚未创建"],
          ["任务版本", job ? String(job.revision) : "未知"],
        ]),
      ),
    );
  }
  function statusDialog(status: RequestStatus) {
    const modal = dialog(
      "调查任务",
      "任务、案件、人工审核和投递状态分别展示。",
    );
    renderStatus(modal.body, status, modal.valid);
  }
  async function show() {
    const page = begin("requests"),
      snapshot = await invoke("workspace.snapshot", {});
    if (!page.valid()) return;
    const list = card(
      "当前工作空间的请求",
      "包含客户端、告警和来源对话的请求",
      button("发起调查", () => open(), "button primary", "plus"),
    );
    const lookup = el("form", undefined, "filter-bar");
    field(lookup, "按请求 ID 定位", "requestId");
    submit(lookup, "读取请求", async () => {
      const data = await invoke("requests.status", {
        requestId: value(lookup, "requestId"),
      });
      if (page.valid()) statusDialog(data);
    });
    list.body.append(lookup);
    const grid = table(["问题 / 来源", "请求状态", "任务状态", "创建时间", ""]);
    for (const request of snapshot.requests) {
      const job = snapshot.jobs.find((j) => j.requestId === request.id),
        title = el("div", undefined, "table-title");
      title.append(
        el("strong", request.question),
        el(
          "span",
          `${stateText(request.origin)} · ${request.id.slice(0, 8)}`,
          "small muted",
        ),
      );
      grid.row([
        title,
        state(
          request.state,
          request.state === "accepted" ? "已受理" : stateText(request.state),
        ),
        job
          ? state(job.state, jobStates[job.state])
          : request.jobId
            ? "状态待读取"
            : "尚未创建任务",
        formatTime(request.createdAt),
        button(
          "查看进展",
          () =>
            void run(undefined, async () => {
              const data = await invoke("requests.status", {
                requestId: request.id,
              });
              if (page.valid()) statusDialog(data);
            }),
          "button ghost small-button",
          "arrow",
        ),
      ]);
    }
    list.body.append(
      snapshot.requests.length
        ? grid.root
        : empty(
            "暂无调查请求",
            "已有案件和人工背景仍可继续维护；调查服务不可用时会明确返回原因。",
            button("发起调查", () => open(), "button secondary", "plus"),
            "requests",
          ),
    );
    page.body.append(
      list.root,
      notice("运行预算与当前用量由调查服务提供；没有取得的用量保持未知。"),
    );
  }
  return { form, open, show, statusDialog };
}
