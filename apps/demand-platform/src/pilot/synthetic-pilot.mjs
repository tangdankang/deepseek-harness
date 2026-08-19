import crypto from "node:crypto";
import { signIdentityContext } from "../domain/identity-signature.mjs";

const TOOL_PATHS = Object.freeze({
  search_service_catalog: "/api/v1/tools/search-service-catalog",
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
});

function integer(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name}必须为${minimum}至${maximum}的整数`);
  return parsed;
}

function finite(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name}必须为${minimum}至${maximum}的数字`);
  return parsed;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function pooled(items, concurrency, operation) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await operation(items[index], index);
    }
  });
  await Promise.all(workers);
}

export async function runSyntheticPilot({
  baseUrl,
  toolKey,
  identitySecret,
  employeeCount = 50,
  concurrency = 10,
  allowWrite = false,
  writeEmployeeCount = 20,
  serviceCode,
  sampleFields,
  query = "CRM",
  departments = ["D-PILOT-A", "D-PILOT-B"],
  thresholds = {},
  fetchImpl = globalThis.fetch,
} = {}) {
  const target = new URL(baseUrl);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.search || target.hash) throw new Error("baseUrl格式无效");
  if (!toolKey || !identitySecret) throw new Error("toolKey和identitySecret必须通过安全环境变量注入");
  const totalEmployees = integer(employeeCount, "employeeCount", 2, 500);
  const workerCount = integer(concurrency, "concurrency", 1, 100);
  const writeCount = allowWrite ? integer(writeEmployeeCount, "writeEmployeeCount", 1, totalEmployees) : 0;
  if (!Array.isArray(departments) || departments.length < 2 || departments.some((item) => !String(item).trim())) throw new Error("至少需要两个有效部门编码");
  if (allowWrite && (!serviceCode || !sampleFields || typeof sampleFields !== "object" || Array.isArray(sampleFields))) throw new Error("写入模式必须提供serviceCode和sampleFields");

  const policy = {
    maxErrorRate: finite(thresholds.maxErrorRate ?? 0, "maxErrorRate", 0, 1),
    maxP95Ms: finite(thresholds.maxP95Ms ?? 2000, "maxP95Ms", 1, 120000),
    minCrossEmployeeDenialRate: finite(thresholds.minCrossEmployeeDenialRate ?? 1, "minCrossEmployeeDenialRate", 0, 1),
    minIdempotentReplayRate: finite(thresholds.minIdempotentReplayRate ?? 1, "minIdempotentReplayRate", 0, 1),
    maxDuplicateTicketFindings: integer(thresholds.maxDuplicateTicketFindings ?? 0, "maxDuplicateTicketFindings", 0, 100),
  };
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const calls = [];
  const failures = [];
  const perOperation = new Map();
  const security = { crossEmployeeChecks: 0, crossEmployeeDenied: 0 };
  const idempotency = { replayChecks: 0, replayConfirmed: 0, duplicateTicketFindings: 0 };
  const business = { casesCreated: 0, externalTicketsObserved: 0, handoffsCreated: 0, feedbackRecorded: 0 };
  let invocationSequence = 0;

  const employees = Array.from({ length: totalEmployees }, (_, index) => ({
    employeeId: `SYN-${runId.slice(0, 8)}-${String(index + 1).padStart(4, "0")}`,
    departmentId: String(departments[index % departments.length]),
    name: `合成试点员工${index + 1}`,
  }));

  const invoke = async (employee, operationId, body, expectedStatus = 200) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const invocationId = `pilot:${runId}:${++invocationSequence}`;
    const requestStarted = Date.now();
    let response;
    let payload = null;
    try {
      response = await fetchImpl(`${target.href.replace(/\/$/, "")}${TOOL_PATHS[operationId]}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tool-key": toolKey,
          "x-tool-invocation-id": invocationId,
          "x-employee-id": employee.employeeId,
          "x-department-id": employee.departmentId,
          "x-employee-name": encodeURIComponent(employee.name),
          "x-identity-timestamp": String(timestamp),
          "x-identity-signature": signIdentityContext({ employeeId: employee.employeeId, departmentId: employee.departmentId, timestamp, secret: identitySecret }),
        },
        body: JSON.stringify(body ?? {}),
      });
      payload = await response.json().catch(() => null);
    } catch (error) {
      const durationMs = Date.now() - requestStarted;
      calls.push({ operationId, status: 0, durationMs, passed: false });
      failures.push({ operationId, status: 0, errorCode: "NETWORK_ERROR", message: "网络请求失败，目标地址已从报告中移除" });
      throw error;
    }
    const durationMs = Date.now() - requestStarted;
    const passed = response.status === expectedStatus;
    calls.push({ operationId, status: response.status, durationMs, passed });
    if (!perOperation.has(operationId)) perOperation.set(operationId, []);
    perOperation.get(operationId).push(durationMs);
    if (!passed) {
      failures.push({ operationId, status: response.status, errorCode: payload?.error?.code ?? null, message: `期望HTTP ${expectedStatus}` });
      throw new Error(`${operationId}期望HTTP ${expectedStatus}，实际${response.status}`);
    }
    return payload;
  };

  await pooled(employees, workerCount, async (employee) => {
    try {
      await invoke(employee, "get_employee_context", {});
      await invoke(employee, "search_service_catalog", { query });
      await invoke(employee, "search_knowledge", { query: "如何重置密码" });
    } catch { /* 失败已去标识记录，其他员工继续。 */ }
  });

  if (allowWrite) {
    await pooled(employees.slice(0, writeCount), workerCount, async (employee, index) => {
      try {
        const validation = await invoke(employee, "validate_request_draft", { serviceCode, fields: sampleFields });
        if (validation?.valid !== true) throw new Error("样本字段未通过Schema校验");
        const draft = await invoke(employee, "create_or_update_draft", { serviceCode, fields: sampleFields, conversationId: `SYN-${runId}-${index}` }, 201);
        business.casesCreated += 1;
        const requestNo = draft.case.globalRequestNo;
        const confirmation = await invoke(employee, "prepare_confirmation", { globalRequestNo: requestNo });
        const submitBody = {
          globalRequestNo: requestNo,
          draftVersion: confirmation.case.version,
          confirmationToken: confirmation.confirmationToken,
          idempotencyKey: `synthetic-submit-${runId}-${index}`,
        };
        const submitted = await invoke(employee, "submit_request", submitBody);
        const replay = await invoke(employee, "submit_request", submitBody);
        idempotency.replayChecks += 1;
        const firstTicket = submitted.externalTickets?.[0]?.ticketNo;
        if (firstTicket) business.externalTicketsObserved += 1;
        const replayTicket = replay.externalTickets?.[0]?.ticketNo;
        if (replay.idempotentReplay === true && firstTicket && firstTicket === replayTicket) idempotency.replayConfirmed += 1;
        else idempotency.duplicateTicketFindings += 1;
        await invoke(employee, "get_request_status", { globalRequestNo: requestNo });

        const other = employees[(index + 1) % employees.length];
        security.crossEmployeeChecks += 1;
        try {
          const denied = await invoke(other, "get_request_status", { globalRequestNo: requestNo }, 404);
          if (denied?.error?.code === "CASE_NOT_FOUND") security.crossEmployeeDenied += 1;
        } catch { /* invoke已记录非预期结果。 */ }

        const handoff = await invoke(employee, "handoff_to_human", {
          employeeConfirmed: true,
          originalMessage: "合成试点人工接管验证",
          summary: "合成试点人工接管验证",
          reasonCode: "USER_REQUEST",
          conversationId: `SYN-${runId}-${index}`,
          idempotencyKey: `synthetic-handoff-${runId}-${index}`,
        }, 201);
        business.handoffsCreated += 1;
        await invoke(employee, "get_handoff_status", { handoffNo: handoff.handoff.handoffNo });
        await invoke(employee, "record_feedback", {
          employeeConfirmed: true,
          subjectType: "CASE",
          subjectId: requestNo,
          resolved: true,
          rating: 5,
          reasonCodes: ["ANSWER_HELPFUL"],
          idempotencyKey: `synthetic-feedback-${runId}-${index}`,
        }, 201);
        business.feedbackRecorded += 1;
      } catch (error) {
        if (String(error.message) === "样本字段未通过Schema校验") failures.push({ operationId: "validate_request_draft", status: 200, errorCode: "SAMPLE_FIELDS_INVALID", message: error.message });
      }
    });
  }

  const durations = calls.map((item) => item.durationMs);
  const errorRate = calls.length === 0 ? 1 : calls.filter((item) => !item.passed).length / calls.length;
  const crossEmployeeDenialRate = security.crossEmployeeChecks === 0 ? null : security.crossEmployeeDenied / security.crossEmployeeChecks;
  const idempotentReplayRate = idempotency.replayChecks === 0 ? null : idempotency.replayConfirmed / idempotency.replayChecks;
  const latencyByOperation = Object.fromEntries([...perOperation.entries()].sort().map(([operationId, values]) => [operationId, { calls: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), p99Ms: percentile(values, 0.99), maxMs: Math.max(...values) }]));
  const assertions = [
    { id: "ERROR_RATE", actual: errorRate, target: policy.maxErrorRate, passed: errorRate <= policy.maxErrorRate },
    { id: "P95_LATENCY_MS", actual: percentile(durations, 0.95), target: policy.maxP95Ms, passed: percentile(durations, 0.95) !== null && percentile(durations, 0.95) <= policy.maxP95Ms },
  ];
  if (allowWrite) assertions.push(
    { id: "CROSS_EMPLOYEE_DENIAL_RATE", actual: crossEmployeeDenialRate, target: policy.minCrossEmployeeDenialRate, passed: crossEmployeeDenialRate >= policy.minCrossEmployeeDenialRate },
    { id: "IDEMPOTENT_REPLAY_RATE", actual: idempotentReplayRate, target: policy.minIdempotentReplayRate, passed: idempotentReplayRate >= policy.minIdempotentReplayRate },
    { id: "DUPLICATE_TICKET_FINDINGS", actual: idempotency.duplicateTicketFindings, target: policy.maxDuplicateTicketFindings, passed: idempotency.duplicateTicketFindings <= policy.maxDuplicateTicketFindings },
  );

  return {
    schemaVersion: 1,
    runId,
    mode: allowWrite ? "SYNTHETIC_FULL_WRITE" : "SYNTHETIC_READ_ONLY",
    target: "REDACTED_TARGET",
    startedAt,
    completedAt: new Date().toISOString(),
    outcome: assertions.every((item) => item.passed) && failures.length === 0 ? "PASS" : "FAIL",
    profile: { employees: totalEmployees, departments: departments.length, concurrency: workerCount, writeEmployees: writeCount },
    summary: { totalCalls: calls.length, passedCalls: calls.filter((item) => item.passed).length, failedCalls: calls.filter((item) => !item.passed).length, errorRate, p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95), p99Ms: percentile(durations, 0.99), maxMs: durations.length ? Math.max(...durations) : null },
    security: { ...security, crossEmployeeDenialRate },
    idempotency: { ...idempotency, idempotentReplayRate },
    business,
    latencyByOperation,
    assertions,
    failures: failures.slice(0, 50),
    warning: "合成试点只验证技术容量、隔离和幂等，不替代真人体验、真实答案质量、租户网络、业务Owner和安全签字。",
  };
}

export function syntheticPilotMarkdown(report) {
  const operationRows = Object.entries(report.latencyByOperation).map(([name, item]) => `| \`${name}\` | ${item.calls} | ${item.p50Ms} | ${item.p95Ms} | ${item.p99Ms} | ${item.maxMs} |`).join("\n");
  const assertionRows = report.assertions.map((item) => `| ${item.id} | ${item.actual ?? "—"} | ${item.target} | ${item.passed ? "PASS" : "FAIL"} |`).join("\n");
  return `# AI统一需求平台合成试点报告\n\n- 运行编号：\`${report.runId}\`\n- 模式：\`${report.mode}\`\n- 结果：\`${report.outcome}\`\n- 合成员工：${report.profile.employees}\n- 部门：${report.profile.departments}\n- 并发：${report.profile.concurrency}\n- 写入员工：${report.profile.writeEmployees}\n- HTTP调用：${report.summary.passedCalls}/${report.summary.totalCalls} 成功\n- 总体P95：${report.summary.p95Ms} ms\n\n## 门槛\n\n| 项目 | 实际 | 门槛 | 结论 |\n|---|---:|---:|---|\n${assertionRows}\n\n## 工具延迟\n\n| 工具 | 调用 | P50(ms) | P95(ms) | P99(ms) | Max(ms) |\n|---|---:|---:|---:|---:|---:|\n${operationRows}\n\n## 安全、幂等与业务闭环\n\n- 跨员工拒绝：${report.security.crossEmployeeDenied}/${report.security.crossEmployeeChecks}\n- 幂等重放确认：${report.idempotency.replayConfirmed}/${report.idempotency.replayChecks}\n- 重复工单发现：${report.idempotency.duplicateTicketFindings}\n- 创建需求：${report.business?.casesCreated ?? 0}\n- 观察到下游工单：${report.business?.externalTicketsObserved ?? 0}\n- 创建人工事项：${report.business?.handoffsCreated ?? 0}\n- 记录结构化反馈：${report.business?.feedbackRecorded ?? 0}\n- 失败记录：${report.failures.length}\n\n${report.warning}\n`;
}

export function validateSyntheticPilotReport(report, { minEmployees = 20, minDepartments = 2, minWriteEmployees = 10, minCalls = 100 } = {}) {
  const findings = [];
  if (report?.schemaVersion !== 1) findings.push("报告schemaVersion必须为1");
  if (report?.mode !== "SYNTHETIC_FULL_WRITE") findings.push("生产门禁只接受全量写入合成试点");
  if (report?.outcome !== "PASS") findings.push("合成试点结果不是PASS");
  if (Number(report?.profile?.employees ?? 0) < minEmployees) findings.push(`合成员工少于${minEmployees}`);
  if (Number(report?.profile?.departments ?? 0) < minDepartments) findings.push(`合成部门少于${minDepartments}`);
  if (Number(report?.profile?.writeEmployees ?? 0) < minWriteEmployees) findings.push(`写入员工少于${minWriteEmployees}`);
  if (Number(report?.summary?.totalCalls ?? 0) < minCalls) findings.push(`HTTP调用少于${minCalls}`);
  if (Number(report?.summary?.failedCalls ?? 1) !== 0) findings.push("存在失败HTTP调用");
  if (Number(report?.security?.crossEmployeeDenialRate ?? 0) !== 1) findings.push("跨员工越权拒绝率不是100%");
  if (Number(report?.idempotency?.idempotentReplayRate ?? 0) !== 1) findings.push("幂等重放确认率不是100%");
  if (Number(report?.idempotency?.duplicateTicketFindings ?? 1) !== 0) findings.push("发现重复下游工单");
  for (const [name, value] of Object.entries(report?.business ?? {})) if (Number(value) < minWriteEmployees) findings.push(`${name}少于${minWriteEmployees}`);
  if (!report?.business || Object.keys(report.business).length < 4) findings.push("缺少业务闭环计数");
  if (!Array.isArray(report?.assertions) || report.assertions.length < 5 || report.assertions.some((item) => item?.passed !== true)) findings.push("合成试点门槛未全部通过");
  if (!Array.isArray(report?.failures) || report.failures.length !== 0) findings.push("报告包含失败记录");
  return { valid: findings.length === 0, findings, scope: { minEmployees, minDepartments, minWriteEmployees, minCalls } };
}
