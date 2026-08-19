import crypto from "node:crypto";
import { signIdentityContext } from "../domain/identity-signature.mjs";

const PATHS = Object.freeze({
  search_service_catalog: "/api/v1/tools/search-service-catalog",
  get_service_form_schema: "/api/v1/tools/get-service-form-schema",
  get_employee_context: "/api/v1/tools/get-employee-context",
  search_knowledge: "/api/v1/tools/search-knowledge",
  validate_request_draft: "/api/v1/tools/validate-request-draft",
  create_or_update_draft: "/api/v1/tools/create-or-update-draft",
  prepare_confirmation: "/api/v1/tools/prepare-confirmation",
  submit_request: "/api/v1/tools/submit-request",
  get_request_status: "/api/v1/tools/get-request-status",
  handoff_to_human: "/api/v1/tools/handoff-to-human",
  get_handoff_status: "/api/v1/tools/get-handoff-status",
  record_feedback: "/api/v1/tools/record-feedback",
  guided_request_turn: "/api/v1/tools/guided-request-turn",
});

function normalizeBaseUrl(value) {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("baseUrl格式无效");
  return parsed.href.replace(/\/$/, "");
}

function classifyTarget(value) {
  const hostname = new URL(value).hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" ? "LOOPBACK" : "REMOTE";
}

function idempotency(prefix, runId) {
  return `${prefix}-${runId}`.slice(0, 180);
}

export async function runDeapToolConformance({
  baseUrl,
  toolKey,
  identitySecret,
  employee = { employeeId: "E-DEAP-CONFORMANCE", departmentId: "D-ORG", name: "DEAP联调员工" },
  query = "CRM",
  allowWrite = false,
  serviceCode,
  sampleFields,
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const targetClassification = classifyTarget(normalizedBaseUrl);
  const targetFingerprint = crypto.createHash("sha256").update(normalizedBaseUrl).digest("hex").toUpperCase();
  if (!toolKey || !identitySecret) throw new Error("toolKey和identitySecret均为必填，且必须通过安全环境变量注入");
  if (allowWrite && (!serviceCode || !sampleFields || typeof sampleFields !== "object" || Array.isArray(sampleFields))) {
    throw new Error("写入联调必须明确提供serviceCode和sampleFields");
  }
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const cases = [];
  const covered = new Set();
  let sequence = 0;

  const invoke = async (name, operationId, body, expectedStatus, overrides = {}) => {
    sequence += 1;
    const timestamp = Math.floor(Date.now() / 1000);
    const invocationId = overrides.invocationId ?? `conf:${runId}:${sequence}`;
    const signature = overrides.invalidSignature
      ? "0".repeat(64)
      : signIdentityContext({ employeeId: employee.employeeId, departmentId: employee.departmentId, timestamp, secret: identitySecret });
    const headers = {
      "content-type": "application/json",
      "x-employee-id": employee.employeeId,
      "x-department-id": employee.departmentId,
      "x-employee-name": encodeURIComponent(employee.name),
      "x-identity-timestamp": String(timestamp),
      "x-identity-signature": signature,
      "x-tool-invocation-id": invocationId,
    };
    if (!overrides.omitToolKey) headers["x-tool-key"] = toolKey;
    const callStarted = Date.now();
    const response = await fetchImpl(`${normalizedBaseUrl}${PATHS[operationId]}`, { method: "POST", headers, body: JSON.stringify(body ?? {}) });
    let payload;
    try { payload = await response.json(); }
    catch { payload = null; }
    const result = {
      name,
      operationId,
      expectedStatus,
      actualStatus: response.status,
      passed: response.status === expectedStatus,
      durationMs: Date.now() - callStarted,
      invocationId: response.headers.get("x-tool-invocation-id") ?? invocationId,
      traceId: response.headers.get("x-trace-id"),
      errorCode: payload?.error?.code ?? null,
    };
    cases.push(result);
    if (!overrides.securityNegative) covered.add(operationId);
    if (!result.passed) throw Object.assign(new Error(`${name}期望HTTP ${expectedStatus}，实际${response.status}`), { remoteErrorCode: payload?.error?.code ?? null });
    return { response, payload, result };
  };

  let failure = null;
  try {
    await invoke("缺少工具凭据必须拒绝", "get_employee_context", {}, 401, { omitToolKey: true, securityNegative: true });
    await invoke("伪造员工身份签名必须拒绝", "get_employee_context", {}, 401, { invalidSignature: true, securityNegative: true });

    const contextInvocationId = `conf:${runId}:context`;
    await invoke("读取最小员工上下文", "get_employee_context", {}, 200, { invocationId: contextInvocationId });
    await invoke("重复工具调用编号必须拒绝", "get_employee_context", {}, 409, { invocationId: contextInvocationId, securityNegative: true });
    const search = await invoke("检索服务目录", "search_service_catalog", { query }, 200);
    const selectedServiceCode = serviceCode ?? search.payload?.services?.[0]?.serviceCode;
    if (!selectedServiceCode) throw new Error("服务目录未返回可用于联调的服务，请调整query或显式传入serviceCode");
    await invoke("读取动态表单Schema", "get_service_form_schema", { serviceCode: selectedServiceCode }, 200);
    await invoke("检索带权限知识", "search_knowledge", { query: "如何重置密码" }, 200);
    await invoke("校验空草稿并返回缺失字段", "validate_request_draft", { serviceCode: selectedServiceCode, fields: {} }, 200);

    if (allowWrite) {
      const validation = await invoke("校验写入样本字段", "validate_request_draft", { serviceCode, fields: sampleFields }, 200);
      if (validation.payload?.valid !== true) throw Object.assign(new Error("sampleFields未通过服务Schema校验"), { remoteErrorCode: "SAMPLE_FIELDS_INVALID" });
      const draft = await invoke("创建联调需求草稿", "create_or_update_draft", { serviceCode, fields: sampleFields, conversationId: `CONF-${runId}` }, 201);
      const requestNo = draft.payload?.case?.globalRequestNo;
      await invoke("验证引导式填单已就绪且不会自动提交", "guided_request_turn", {
        action: "COLLECT",
        conversationId: `CONF-${runId}`,
        globalRequestNo: requestNo,
        fieldUpdates: {},
      }, 200);
      const confirmation = await invoke("生成提交预览和确认令牌", "prepare_confirmation", { globalRequestNo: requestNo }, 200);
      await invoke("幂等提交联调需求", "submit_request", {
        globalRequestNo: requestNo,
        draftVersion: confirmation.payload?.case?.version,
        confirmationToken: confirmation.payload?.confirmationToken,
        idempotencyKey: idempotency("deap-conformance-submit", runId),
      }, 200);
      await invoke("查询本人需求状态", "get_request_status", { globalRequestNo: requestNo }, 200);
      const handoff = await invoke("经确认创建人工受理", "handoff_to_human", {
        employeeConfirmed: true,
        originalMessage: "DEAP联调验证需要人工接管",
        summary: "DEAP工具链人工接管联调验证",
        reasonCode: "USER_REQUEST",
        conversationId: `CONF-${runId}`,
        idempotencyKey: idempotency("deap-conformance-handoff", runId),
      }, 201);
      await invoke("查询本人人工受理状态", "get_handoff_status", { handoffNo: handoff.payload?.handoff?.handoffNo ?? handoff.payload?.handoffNo }, 200);
      await invoke("记录本人明确结构化反馈", "record_feedback", {
        employeeConfirmed: true,
        subjectType: "CASE",
        subjectId: requestNo,
        resolved: true,
        rating: 5,
        reasonCodes: ["ANSWER_HELPFUL"],
        idempotencyKey: idempotency("deap-conformance-feedback", runId),
      }, 201);
    }
  } catch (error) {
    failure = { message: error.message, errorCode: error.remoteErrorCode ?? null };
  }

  const requiredOperations = allowWrite ? Object.keys(PATHS) : ["get_employee_context", "search_service_catalog", "get_service_form_schema", "search_knowledge", "validate_request_draft"];
  const missingOperations = requiredOperations.filter((operationId) => !covered.has(operationId));
  return {
    schemaVersion: 1,
    runId,
    mode: allowWrite ? "FULL_WRITE" : "READ_ONLY",
    target: "REDACTED_TARGET",
    targetClass: targetClassification,
    targetFingerprint,
    startedAt,
    completedAt: new Date().toISOString(),
    outcome: !failure && cases.every((item) => item.passed) && missingOperations.length === 0 ? "PASS" : "FAIL",
    operationsCovered: [...covered].sort(),
    missingOperations,
    summary: { total: cases.length, passed: cases.filter((item) => item.passed).length, failed: cases.filter((item) => !item.passed).length },
    failure,
    cases,
  };
}

export function conformanceMarkdown(report) {
  const rows = report.cases.map((item) => `| ${item.name} | \`${item.operationId}\` | ${item.expectedStatus} | ${item.actualStatus} | ${item.passed ? "PASS" : "FAIL"} | ${item.durationMs} |`).join("\n");
  return `# DEAP 工具链联调报告\n\n- 运行编号：\`${report.runId}\`\n- 模式：\`${report.mode}\`\n- 目标：\`${report.target}\`\n- 结果：\`${report.outcome}\`\n- 用例：${report.summary.passed}/${report.summary.total} 通过\n- 工具覆盖：${report.operationsCovered.length}/${report.mode === "FULL_WRITE" ? Object.keys(PATHS).length : 5}\n\n| 用例 | operationId | 期望 HTTP | 实际 HTTP | 结果 | 耗时(ms) |\n|---|---|---:|---:|---|---:|\n${rows}\n\n${report.failure ? `失败说明：${report.failure.message}\n` : "未发现失败项。\n"}`;
}
