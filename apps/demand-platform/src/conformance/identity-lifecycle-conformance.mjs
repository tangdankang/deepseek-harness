import crypto from "node:crypto";
import { signWebhook } from "../domain/confirmation-token.mjs";
import { signIdentityContext } from "../domain/identity-signature.mjs";

function normalizeBaseUrl(value) {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("baseUrl格式无效");
  return parsed.href.replace(/\/$/, "");
}

function classifyTarget(value) {
  const hostname = new URL(value).hostname.toLowerCase();
  return ["localhost", "127.0.0.1", "::1"].includes(hostname) ? "LOOPBACK" : "REMOTE";
}

function employeeHash(employeeId) {
  return crypto.createHash("sha256").update(`identity-conformance:${employeeId}`).digest("hex").toUpperCase();
}

export async function runIdentityLifecycleConformance({
  baseUrl,
  eventSecret,
  identitySecret,
  toolKey,
  sourceSystem,
  startingSequence,
  employee,
  testEmployeeConfirmed = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  const target = normalizeBaseUrl(baseUrl);
  const targetClass = classifyTarget(target);
  if (![eventSecret, identitySecret, toolKey].every((value) => typeof value === "string" && value.length >= 16)) throw new Error("事件、身份和工具密钥必须通过安全环境变量提供");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/.test(sourceSystem ?? "")) throw new Error("sourceSystem格式无效");
  if (!Number.isSafeInteger(startingSequence) || startingSequence < 1) throw new Error("startingSequence必须为正整数");
  for (const [name, value] of Object.entries({ employeeId: employee?.employeeId, departmentId: employee?.departmentId, name: employee?.name })) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${name}不能为空`);
  }
  if (testEmployeeConfirmed !== true) throw new Error("必须明确确认使用专用测试员工");

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const cases = [];
  const covered = new Set();
  let failure = null;
  let restoreEvent = null;
  let restoreRaw = null;
  let recovery = { required: false, outcome: "NOT_REQUIRED", status: null, errorCode: null };

  const identityHeaders = () => {
    const timestamp = Math.floor(Date.now() / 1000);
    return {
      "x-employee-id": employee.employeeId,
      "x-department-id": employee.departmentId,
      "x-employee-name": encodeURIComponent(employee.name),
      "x-identity-timestamp": String(timestamp),
      "x-identity-signature": signIdentityContext({ employeeId: employee.employeeId, departmentId: employee.departmentId, timestamp, secret: identitySecret }),
    };
  };
  const parse = async (response) => { try { return await response.json(); } catch { return null; } };
  const record = (name, scenario, expectedStatus, response, payload, started, semantic = true) => {
    const item = { name, scenario, expectedStatus, actualStatus: response.status, passed: response.status === expectedStatus && semantic, durationMs: Date.now() - started, errorCode: payload?.error?.code ?? null, traceId: response.headers.get("x-trace-id") };
    cases.push(item);
    if (item.passed) covered.add(scenario);
    if (!item.passed) throw Object.assign(new Error(`${name}期望HTTP ${expectedStatus}且语义校验通过，实际${response.status}`), { remoteErrorCode: item.errorCode });
    return payload;
  };
  const employeeCall = async (name, scenario, pathname, expectedStatus, { method = "GET", body, cookie, tool = false, semantic = () => true } = {}) => {
    const headers = { ...identityHeaders(), ...(cookie ? { cookie } : {}), ...(tool ? { "x-tool-key": toolKey, "x-tool-invocation-id": `ilc:${runId}:${cases.length + 1}` } : {}) };
    if (body !== undefined) headers["content-type"] = "application/json";
    const started = Date.now();
    const response = await fetchImpl(`${target}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const payload = await parse(response);
    record(name, scenario, expectedStatus, response, payload, started, semantic(payload));
    return { response, payload };
  };
  const eventDocument = (sequence, eventType, suffix, reasonCode) => ({
    schemaVersion: 1,
    eventId: `ILC-${runId}-${suffix}`,
    sourceSystem,
    employeeId: employee.employeeId,
    sequence,
    eventType,
    occurredAt: new Date().toISOString(),
    reasonCode,
  });
  const eventCall = async (name, scenario, document, expectedStatus, { raw = JSON.stringify(document), invalidSignature = false, semantic = () => true } = {}) => {
    const signature = invalidSignature ? "0".repeat(64) : signWebhook(raw, eventSecret);
    const started = Date.now();
    const response = await fetchImpl(`${target}/api/v1/webhooks/identity/events`, { method: "POST", headers: { "content-type": "application/json", "x-identity-event-signature": signature }, body: raw });
    const payload = await parse(response);
    record(name, scenario, expectedStatus, response, payload, started, semantic(payload));
    return { response, payload, raw };
  };

  try {
    const invalid = eventDocument(startingSequence, "MEMBERSHIP_CHANGED", "invalid-signature", "CONFORMANCE_TEST");
    await eventCall("篡改签名必须拒绝", "INVALID_SIGNATURE_REJECTED", invalid, 401, { invalidSignature: true, semantic: (payload) => payload?.error?.code === "INVALID_IDENTITY_EVENT_SIGNATURE" });
    const login = await employeeCall("创建待撤销员工会话", "SESSION_CREATED", "/api/v1/auth/session", 201, { method: "POST", body: {} });
    const cookie = login.response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("身份交换未返回会话Cookie");

    const membership = eventDocument(startingSequence, "MEMBERSHIP_CHANGED", "membership", "CONFORMANCE_TEST");
    await eventCall("成员关系变化撤销旧上下文", "MEMBERSHIP_CHANGED", membership, 200, { semantic: (payload) => payload?.applied === true && payload?.state?.accessStatus === "ACTIVE" });
    const revokedStarted = Date.now();
    const revokedResponse = await fetchImpl(`${target}/api/v1/auth/me`, { headers: { cookie } });
    const revokedPayload = await parse(revokedResponse);
    record("成员关系变化后旧会话失效", "SESSION_REVOKED", 401, revokedResponse, revokedPayload, revokedStarted, revokedPayload?.error?.code === "INVALID_SESSION");
    await employeeCall("使用新身份上下文重新登录", "SESSION_RECREATED", "/api/v1/auth/session", 201, { method: "POST", body: {} });

    const suspended = eventDocument(startingSequence + 1, "ACCESS_SUSPENDED", "suspend", "CONFORMANCE_TEST");
    recovery.required = true;
    restoreEvent = eventDocument(startingSequence + 2, "ACCESS_RESTORED", "restore", "CONFORMANCE_CLEANUP");
    restoreRaw = JSON.stringify(restoreEvent);
    const suspendedResult = await eventCall("停用测试员工", "ACCESS_SUSPENDED", suspended, 200, { semantic: (payload) => payload?.state?.accessStatus === "BLOCKED" });
    await employeeCall("停用员工浏览器通道被阻断", "BROWSER_BLOCKED", "/api/v1/services", 403, { semantic: (payload) => payload?.error?.code === "EMPLOYEE_ACCESS_BLOCKED" });
    await employeeCall("停用员工DEAP工具通道被阻断", "DEAP_TOOL_BLOCKED", "/api/v1/tools/search-service-catalog", 403, { method: "POST", body: { query: "CRM" }, tool: true, semantic: (payload) => payload?.error?.code === "EMPLOYEE_ACCESS_BLOCKED" });
    await eventCall("相同事件重放保持幂等", "DUPLICATE_IDEMPOTENT", suspended, 200, { raw: suspendedResult.raw, semantic: (payload) => payload?.duplicate === true && payload?.applied === false });
    const outOfOrder = eventDocument(startingSequence + 1, "ACCESS_RESTORED", "out-of-order", "CONFORMANCE_TEST");
    await eventCall("非递增事件序号必须拒绝", "OUT_OF_ORDER_REJECTED", outOfOrder, 409, { semantic: (payload) => payload?.error?.code === "IDENTITY_EVENT_OUT_OF_ORDER" });
    await eventCall("恢复测试员工访问", "ACCESS_RESTORED", restoreEvent, 200, { raw: restoreRaw, semantic: (payload) => payload?.state?.accessStatus === "ACTIVE" });
    recovery = { required: true, outcome: "PASS", status: 200, errorCode: null };
    await employeeCall("恢复后身份通道重新开放", "POST_RESTORE_ACCESS", "/api/v1/services", 200);
  } catch (error) {
    failure = { message: error.message, errorCode: error.remoteErrorCode ?? null };
  } finally {
    if (recovery.required && recovery.outcome !== "PASS" && restoreEvent && restoreRaw) {
      try {
        const response = await fetchImpl(`${target}/api/v1/webhooks/identity/events`, { method: "POST", headers: { "content-type": "application/json", "x-identity-event-signature": signWebhook(restoreRaw, eventSecret) }, body: restoreRaw });
        const payload = await parse(response);
        recovery = { required: true, outcome: response.status === 200 && payload?.state?.accessStatus === "ACTIVE" ? "PASS" : "FAIL", status: response.status, errorCode: payload?.error?.code ?? null };
      } catch {
        recovery = { required: true, outcome: "FAIL", status: null, errorCode: "RECOVERY_REQUEST_FAILED" };
      }
    }
  }

  const requiredScenarios = ["INVALID_SIGNATURE_REJECTED", "SESSION_REVOKED", "BROWSER_BLOCKED", "DEAP_TOOL_BLOCKED", "DUPLICATE_IDEMPOTENT", "OUT_OF_ORDER_REJECTED", "ACCESS_RESTORED"];
  const scenariosCovered = [...covered].sort();
  const missingScenarios = requiredScenarios.filter((item) => !covered.has(item));
  return {
    reportType: "AI_DEMAND_PLATFORM_IDENTITY_LIFECYCLE_CONFORMANCE",
    reportVersion: 1,
    runId,
    mode: "FULL_WRITE",
    target: "REDACTED_TARGET",
    targetClass,
    targetFingerprint: crypto.createHash("sha256").update(target).digest("hex").toUpperCase(),
    testEmployeeHash: employeeHash(employee.employeeId),
    sourceSystem,
    startedAt,
    completedAt: new Date().toISOString(),
    outcome: !failure && recovery.outcome === "PASS" && missingScenarios.length === 0 && cases.every((item) => item.passed) ? "PASS" : "FAIL",
    scenariosCovered,
    missingScenarios,
    summary: { total: cases.length, passed: cases.filter((item) => item.passed).length, failed: cases.filter((item) => !item.passed).length },
    recovery,
    failure,
    cases,
    safety: { testEmployeeConfirmed: true, containsRawEmployeeId: false, containsSecret: false, productionEmployeeDataRead: false },
  };
}

export function identityLifecycleConformanceMarkdown(report) {
  const rows = report.cases.map((item) => `| ${item.name} | \`${item.scenario}\` | ${item.expectedStatus} | ${item.actualStatus} | ${item.passed ? "PASS" : "FAIL"} |`).join("\n");
  return `# 身份生命周期事件联调报告\n\n- 结果：**${report.outcome}**\n- 目标类别：\`${report.targetClass}\`\n- 模式：\`${report.mode}\`\n- 测试员工摘要：\`${report.testEmployeeHash}\`\n- 清理恢复：\`${report.recovery.outcome}\`\n- 场景覆盖：${report.scenariosCovered.length}/${report.scenariosCovered.length + report.missingScenarios.length}\n\n| 用例 | 场景 | 期望HTTP | 实际HTTP | 结果 |\n|---|---|---:|---:|---|\n${rows}\n\n${report.failure ? `失败说明：${report.failure.message}\n` : "未发现失败项。\n"}`;
}
