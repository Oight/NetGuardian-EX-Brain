import { dtoSchemas, type JsonObject } from "@campussec/contracts";
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: JsonObject;
    required: string[];
    additionalProperties: false;
  };
}
function schema(name: keyof typeof dtoSchemas): JsonObject {
  const { $schema: _, ...value } = dtoSchemas[name].toJSONSchema({
    io: "input",
    target: "draft-07",
    reused: "inline",
  });
  return value as JsonObject;
}
const scope = schema("Scope"),
  scopeProps = scope.properties as JsonObject;
const page = schema("PageRequest"),
  ref = schema("EvidenceRef"),
  step = schema("InvestigationStepInput");
const text = { type: "string", minLength: 1 },
  ids = { type: "array", items: text, minItems: 1, maxItems: 5 };
const queries = {
  agentIds: ids,
  from: scopeProps.from!,
  to: scopeProps.to!,
  page,
  purpose: { type: "string", maxLength: 500 },
  step,
};
const single = {
  agentId: text,
  page,
  purpose: { type: "string", maxLength: 500 },
  step,
};
function tool(
  name: string,
  description: string,
  properties: JsonObject,
  required: string[],
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}
const request = schema("CreateRequest"),
  requestProps = { ...(request.properties as JsonObject) };
for (const name of ["origin", "originBindingId", "autoCandidateId"])
  delete requestProps[name];
const requestRequired = (request.required as string[]).filter((name) =>
  Object.hasOwn(requestProps, name),
);
const report = schema("ReportCandidate"),
  requestId = (schema("InvestigationRequest").properties as JsonObject).id!;
export const catalog: ToolDefinition[] = [
  tool(
    "list_investigation_scope",
    "列出当前主体允许的连接摘要；指定 connectionId 后分页列出设备和已核实能力，不返回凭据。",
    { connectionId: scopeProps.connectionId!, page },
    ["page"],
  ),
  tool(
    "request_investigation",
    "向本地队列提交调查请求；来源由可信传输绑定，缺少范围时只等待补充，不运行模型。",
    requestProps,
    requestRequired,
  ),
  tool(
    "provide_investigation_input",
    "补充请求范围或文字；已冻结的轮次不会被静默修改。",
    {
      requestId: requestId,
      scope,
      text: { type: "string", maxLength: 8000 },
      idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
    },
    ["requestId", "idempotencyKey"],
  ),
  tool(
    "get_investigation_status",
    "读取当前来源订阅的调查状态，不轮询或重新运行模型。",
    { requestId: requestId },
    ["requestId"],
  ),
  tool(
    "get_investigation_result",
    "取回已持久化的结果版本；没有终态结果时明确返回未就绪。",
    { requestId: requestId, resultVersion: { type: "integer", minimum: 1 } },
    ["requestId"],
  ),
  tool(
    "cancel_investigation",
    "请求所有者取消调查；普通订阅者只退出自己的订阅。",
    {
      requestId: requestId,
      reason: { type: "string", minLength: 1, maxLength: 2000 },
    },
    ["requestId", "reason"],
  ),
  tool(
    "get_case_context",
    "读取本轮冻结的问题、设备/时间范围、能力、已交付背景和种子；不接受会话或身份参数。",
    {},
    [],
  ),
  tool(
    "get_evidence",
    "读取本轮获准证据版本的白名单字段投影；必须使用实际返回的证据引用。",
    {
      ref,
      fieldNames: { type: "array", items: text, minItems: 1, maxItems: 100 },
    },
    ["ref", "fieldNames"],
  ),
  tool(
    "search_related_alerts",
    "在本轮范围内按设备、规则和原生等级查询告警；完整性与采集覆盖分别返回。",
    { ...queries, filter: schema("AlertFilter") },
    ["agentIds"],
  ),
  tool(
    "search_authentication_events",
    "仅在认证事件映射已核实时查询；账号必须包含 namespace 和 name。",
    {
      ...queries,
      outcome: { enum: ["success", "failure", "any"] },
      account: {
        type: "object",
        properties: { namespace: text, name: text },
        required: ["namespace", "name"],
        additionalProperties: false,
      },
      sourceIp: text,
    },
    ["agentIds"],
  ),
  tool(
    "get_host_inventory",
    "查询单台获准设备的指定资产类别；分页数据不代表所有类别完整。",
    {
      ...single,
      category: { enum: ["os", "hardware", "packages", "processes", "ports"] },
    },
    ["agentId", "category"],
  ),
  tool(
    "search_file_changes",
    "仅查询已核实的 FIM 事件映射，不读取任意远端文件。",
    { ...queries, pathEquals: text },
    ["agentIds"],
  ),
  tool(
    "get_host_findings",
    "查询单台设备已核实的配置检查或漏洞类别；拒绝/未知不能解释为零风险。",
    { ...single, category: { enum: ["sca", "vulnerabilities"] } },
    ["agentId", "category"],
  ),
  tool(
    "record_investigation_step",
    "记录可公开的阶段摘要与证据引用，不提交私有思维链。",
    step.properties as JsonObject,
    step.required as string[],
  ),
  tool(
    "propose_report",
    "提交结构化候选报告，引用必须来自本轮实际交付材料；不会自行完成任务或确认攻击。",
    report.properties as JsonObject,
    report.required as string[],
  ),
];
export const delegation = new Set(catalog.slice(0, 6).map((t) => t.name));
