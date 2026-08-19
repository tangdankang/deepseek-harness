import test from "node:test";
import assert from "node:assert/strict";
import { createApplication } from "../src/server.mjs";
import { signWebhook } from "../src/domain/confirmation-token.mjs";

const employeeHeaders = {
  "X-Employee-Id": "E10001",
  "X-Department-Id": "D-ORG",
  "X-Employee-Name": encodeURIComponent("测试员工"),
};

async function startApp(options = {}) {
  const app = createApplication({
    databasePath: ":memory:",
    confirmationSecret: "test-confirmation-secret-which-is-long",
    webhookSecret: "test-webhook-secret-which-is-different",
    confirmationTtlSeconds: 600,
    ...options,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  return { ...app, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function request(baseUrl, path, { method = "GET", body, headers = employeeHeaders } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  });
  const payload = await response.json();
  return { response, payload };
}

test("端到端：追问字段、确认、幂等建单、员工隔离和状态回传", async (t) => {
  const app = await startApp();
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.db.close();
  });

  const health = await request(app.baseUrl, "/health", { headers: {} });
  assert.equal(health.response.status, 200);

  const draft = await request(app.baseUrl, "/api/v1/cases/drafts", {
    method: "POST",
    body: { serviceCode: "CRM_ACCOUNT_CHANGE", fields: { customerCode: "C000123", newOwnerEmployeeId: "E20002" } },
  });
  assert.equal(draft.response.status, 201);
  assert.equal(draft.payload.case.status, "WAITING_INFORMATION");
  assert.deepEqual(draft.payload.validation.missingFields.map((item) => item.name).sort(), ["currentOwnerEmployeeId", "effectiveDate", "reason"]);

  const requestNo = draft.payload.case.globalRequestNo;
  const incompletePrepare = await request(app.baseUrl, `/api/v1/cases/${requestNo}/prepare-confirmation`, { method: "POST", body: {} });
  assert.equal(incompletePrepare.response.status, 422);
  assert.equal(incompletePrepare.payload.error.code, "DRAFT_INCOMPLETE");

  const updated = await request(app.baseUrl, `/api/v1/cases/${requestNo}/draft`, {
    method: "PATCH",
    body: {
      expectedVersion: draft.payload.case.version,
      fields: { currentOwnerEmployeeId: "E10009", reason: "区域职责发生调整", effectiveDate: "2026-08-20" },
    },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.payload.case.status, "DRAFT");
  assert.equal(updated.payload.case.version, 2);

  const staleUpdate = await request(app.baseUrl, `/api/v1/cases/${requestNo}/draft`, {
    method: "PATCH",
    body: { expectedVersion: 1, fields: { reason: "使用旧版本覆盖" } },
  });
  assert.equal(staleUpdate.response.status, 409);
  assert.equal(staleUpdate.payload.error.code, "VERSION_CONFLICT");

  const confirmation = await request(app.baseUrl, `/api/v1/cases/${requestNo}/prepare-confirmation`, { method: "POST", body: {} });
  assert.equal(confirmation.response.status, 200);
  assert.equal(confirmation.payload.case.status, "WAITING_CONFIRMATION");
  assert.equal(confirmation.payload.preview.fields.length, 5);

  const invalidSubmit = await request(app.baseUrl, `/api/v1/cases/${requestNo}/submit`, {
    method: "POST",
    body: { draftVersion: 2, confirmationToken: `${confirmation.payload.confirmationToken}tampered`, idempotencyKey: `${requestNo}-v2-submit` },
  });
  assert.equal(invalidSubmit.response.status, 400);
  assert.equal(invalidSubmit.payload.error.code, "INVALID_CONFIRMATION");

  const submitBody = { draftVersion: 2, confirmationToken: confirmation.payload.confirmationToken, idempotencyKey: `${requestNo}-v2-submit` };
  const submitted = await request(app.baseUrl, `/api/v1/cases/${requestNo}/submit`, { method: "POST", body: submitBody });
  assert.equal(submitted.response.status, 200);
  assert.equal(submitted.payload.case.status, "SUBMITTED");
  assert.equal(submitted.payload.externalTickets.length, 1);
  assert.equal(submitted.payload.idempotentReplay, false);

  const repeated = await request(app.baseUrl, `/api/v1/cases/${requestNo}/submit`, { method: "POST", body: submitBody });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.payload.idempotentReplay, true);
  assert.equal(repeated.payload.externalTickets[0].ticketNo, submitted.payload.externalTickets[0].ticketNo);

  const otherEmployee = await request(app.baseUrl, `/api/v1/cases/${requestNo}`, { headers: { ...employeeHeaders, "X-Employee-Id": "E-OTHER" } });
  assert.equal(otherEmployee.response.status, 404);
  assert.equal(otherEmployee.payload.error.code, "CASE_NOT_FOUND");

  const event = { eventId: "evt-001", ticketNo: submitted.payload.externalTickets[0].ticketNo, rawStatus: "RESOLVED", occurredAt: new Date().toISOString(), sequence: 1 };
  const rawEvent = JSON.stringify(event);
  const invalidWebhook = await request(app.baseUrl, "/api/v1/webhooks/CRM/status", { method: "POST", body: rawEvent, headers: { "X-Webhook-Signature": "bad" } });
  assert.equal(invalidWebhook.response.status, 401);

  const signature = signWebhook(rawEvent, app.secrets.webhookSecret);
  const webhook = await request(app.baseUrl, "/api/v1/webhooks/CRM/status", { method: "POST", body: rawEvent, headers: { "X-Webhook-Signature": signature } });
  assert.equal(webhook.response.status, 200);
  assert.equal(webhook.payload.duplicate, false);
  assert.equal(webhook.payload.case.status, "RESOLVED");

  const duplicate = await request(app.baseUrl, "/api/v1/webhooks/CRM/status", { method: "POST", body: rawEvent, headers: { "X-Webhook-Signature": signature } });
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.payload.duplicate, true);

  const reused = JSON.stringify({ ...event, rawStatus: "CLOSED" });
  const reusedResponse = await request(app.baseUrl, "/api/v1/webhooks/CRM/status", { method: "POST", body: reused, headers: { "X-Webhook-Signature": signWebhook(reused, app.secrets.webhookSecret) } });
  assert.equal(reusedResponse.response.status, 409);
  assert.equal(reusedResponse.payload.error.code, "EVENT_ID_REUSE");

  const stale = JSON.stringify({ ...event, eventId: "evt-stale", rawStatus: "CLOSED" });
  const staleResponse = await request(app.baseUrl, "/api/v1/webhooks/CRM/status", { method: "POST", body: stale, headers: { "X-Webhook-Signature": signWebhook(stale, app.secrets.webhookSecret) } });
  assert.equal(staleResponse.response.status, 409);
  assert.equal(staleResponse.payload.error.code, "STATUS_EVENT_OUT_OF_ORDER");

  const expired = JSON.stringify({ ...event, eventId: "evt-expired", sequence: 2, occurredAt: new Date(Date.now() - 86401_000).toISOString() });
  const expiredResponse = await request(app.baseUrl, "/api/v1/webhooks/CRM/status", { method: "POST", body: expired, headers: { "X-Webhook-Signature": signWebhook(expired, app.secrets.webhookSecret) } });
  assert.equal(expiredResponse.response.status, 409);
  assert.equal(expiredResponse.payload.error.code, "STATUS_EVENT_EXPIRED");

  const future = JSON.stringify({ ...event, eventId: "evt-future", sequence: 2, occurredAt: new Date(Date.now() + 301_000).toISOString() });
  const futureResponse = await request(app.baseUrl, "/api/v1/webhooks/CRM/status", { method: "POST", body: future, headers: { "X-Webhook-Signature": signWebhook(future, app.secrets.webhookSecret) } });
  assert.equal(futureResponse.response.status, 409);
  assert.equal(futureResponse.payload.error.code, "STATUS_EVENT_IN_FUTURE");

  const finalCase = await request(app.baseUrl, `/api/v1/cases/${requestNo}`);
  assert.equal(finalCase.payload.case.status, "RESOLVED");
  assert.equal(finalCase.payload.case.externalTickets[0].unifiedStatus, "RESOLVED");
  assert.equal(finalCase.payload.case.externalTickets[0].lastEventSequence, 1);

  const audit = app.services.audit.listForCase(finalCase.payload.case.caseId);
  assert.ok(audit.some((item) => item.action === "PREPARE_CONFIRMATION"));
  assert.ok(audit.some((item) => item.action === "CREATE_EXTERNAL_TICKET"));
  assert.ok(audit.some((item) => item.action === "APPLY_STATUS_EVENT"));
  assert.ok(audit.every((item) => !JSON.stringify(item.details).includes(confirmation.payload.confirmationToken)));
});

test("首问FAQ带来源；无法可靠回答时不编造", async (t) => {
  const app = await startApp();
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.db.close();
  });

  const answer = await request(app.baseUrl, "/api/v1/assistant/messages", { method: "POST", body: { message: "客户归属怎么改？" } });
  assert.equal(answer.response.status, 200);
  assert.equal(answer.payload.type, "ANSWER");
  assert.equal(answer.payload.citations.length, 1);
  assert.match(answer.payload.citations[0].url, /^https:\/\//);

  const suggestion = await request(app.baseUrl, "/api/v1/assistant/messages", { method: "POST", body: { message: "ERP物料主数据有问题" } });
  assert.equal(suggestion.response.status, 200);
  assert.equal(suggestion.payload.type, "SERVICE_SUGGESTIONS");
  assert.equal(suggestion.payload.services[0].serviceCode, "ERP_MASTER_DATA_ISSUE");

  const unknown = await request(app.baseUrl, "/api/v1/assistant/messages", { method: "POST", body: { message: "我要办理一个目录里完全没有的神秘事项" } });
  assert.equal(unknown.response.status, 200);
  assert.equal(unknown.payload.type, "HANDOFF_SUGGESTED");
  assert.match(unknown.payload.message, /不会编造答案/);
});

test("员工网页入口通过引导式API逐轮补充、预览并明确确认提交", async (t) => {
  const app = await startApp();
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.db.close();
  });

  const first = await request(app.baseUrl, "/api/v1/guided-intake/turn", {
    method: "POST",
    body: { action: "COLLECT", serviceCode: "CRM_ACCOUNT_CHANGE", conversationId: "WEB-GUIDED-001", fieldUpdates: { customerCode: "C-WEB-001" } },
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.payload.stage, "COLLECTING_INFORMATION");
  assert.ok(first.payload.nextQuestions.length >= 1);
  assert.equal(Number(app.db.prepare("SELECT COUNT(*) AS count FROM external_tickets").get().count), 0);

  const completed = await request(app.baseUrl, "/api/v1/guided-intake/turn", {
    method: "POST",
    body: {
      action: "COLLECT",
      conversationId: "WEB-GUIDED-001",
      globalRequestNo: first.payload.case.globalRequestNo,
      expectedVersion: first.payload.case.version,
      fieldUpdates: { currentOwnerEmployeeId: "E10001", newOwnerEmployeeId: "E20002", reason: "网页逐轮引导验证", effectiveDate: "2026-08-20" },
    },
  });
  assert.equal(completed.payload.stage, "READY_FOR_CONFIRMATION");

  const prepared = await request(app.baseUrl, "/api/v1/guided-intake/turn", {
    method: "POST",
    body: { action: "PREPARE_CONFIRMATION", conversationId: "WEB-GUIDED-001", globalRequestNo: first.payload.case.globalRequestNo },
  });
  assert.equal(prepared.payload.stage, "AWAITING_EXPLICIT_CONFIRMATION");

  const denied = await request(app.baseUrl, "/api/v1/guided-intake/turn", {
    method: "POST",
    body: { action: "CONFIRM_SUBMIT", conversationId: "WEB-GUIDED-001", globalRequestNo: first.payload.case.globalRequestNo, draftVersion: prepared.payload.case.version, confirmationToken: prepared.payload.confirmationToken, idempotencyKey: "web-guided-submit-001", employeeConfirmed: false },
  });
  assert.equal(denied.response.status, 409);
  assert.equal(denied.payload.error.code, "EXPLICIT_CONFIRMATION_REQUIRED");

  const submitted = await request(app.baseUrl, "/api/v1/guided-intake/turn", {
    method: "POST",
    body: { action: "CONFIRM_SUBMIT", conversationId: "WEB-GUIDED-001", globalRequestNo: first.payload.case.globalRequestNo, draftVersion: prepared.payload.case.version, confirmationToken: prepared.payload.confirmationToken, idempotencyKey: "web-guided-submit-001", employeeConfirmed: true },
  });
  assert.equal(submitted.response.status, 200);
  assert.equal(submitted.payload.stage, "SUBMITTED");
  assert.equal(Number(app.db.prepare("SELECT COUNT(*) AS count FROM external_tickets").get().count), 1);

  const scriptResponse = await fetch(`${app.baseUrl}/app.js`);
  const script = await scriptResponse.text();
  assert.equal(scriptResponse.status, 200);
  assert.match(script, /\/api\/v1\/guided-intake\/turn/);
  assert.match(script, /employeeConfirmed:\s*true/);
  assert.match(script, /一次填写完整表单/);
});

test("DEAP工具端点要求平台凭据，并继续校验员工身份上下文", async (t) => {
  const app = await startApp({ toolApiKey: "test-tool-api-key" });
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.db.close();
  });

  const missingCredential = await request(app.baseUrl, "/api/v1/tools/search-service-catalog", {
    method: "POST",
    body: { query: "CRM客户归属" },
  });
  assert.equal(missingCredential.response.status, 401);
  assert.equal(missingCredential.payload.error.code, "INVALID_TOOL_CREDENTIAL");

  const missingEmployee = await request(app.baseUrl, "/api/v1/tools/search-service-catalog", {
    method: "POST",
    headers: { "X-Tool-Key": "test-tool-api-key" },
    body: { query: "CRM客户归属" },
  });
  assert.equal(missingEmployee.response.status, 401);
  assert.equal(missingEmployee.payload.error.code, "AUTH_REQUIRED");

  const authorized = await request(app.baseUrl, "/api/v1/tools/search-service-catalog", {
    method: "POST",
    headers: { ...employeeHeaders, "X-Tool-Key": "test-tool-api-key" },
    body: { query: "CRM客户归属" },
  });
  assert.equal(authorized.response.status, 200);
  assert.equal(authorized.payload.services[0].serviceCode, "CRM_ACCOUNT_CHANGE");
});

test("受限服务不会被跨部门搜索、读取Schema或绕过前端直接建单", async (t) => {
  const app = await startApp({ toolApiKey: "audience-tool-key" });
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.db.close();
  });
  app.db.prepare("UPDATE service_items SET audience_policy_json = ? WHERE service_code = 'ERP_MASTER_DATA_ISSUE'")
    .run(JSON.stringify({ visibility: "DEPARTMENTS", departmentIds: ["D-ERP"] }));

  const deniedHeaders = { ...employeeHeaders, "X-Department-Id": "D-ORG" };
  const allowedHeaders = { ...employeeHeaders, "X-Department-Id": "D-ERP" };
  const deniedCatalog = await request(app.baseUrl, "/api/v1/services?query=ERP", { headers: deniedHeaders });
  assert.deepEqual(deniedCatalog.payload.services, []);
  const allowedCatalog = await request(app.baseUrl, "/api/v1/services?query=ERP", { headers: allowedHeaders });
  assert.equal(allowedCatalog.payload.services[0].serviceCode, "ERP_MASTER_DATA_ISSUE");

  const deniedSchema = await request(app.baseUrl, "/api/v1/services/ERP_MASTER_DATA_ISSUE/schema", { headers: deniedHeaders });
  assert.equal(deniedSchema.response.status, 404);
  assert.equal(deniedSchema.payload.error.code, "SERVICE_NOT_FOUND");
  const bypassDraft = await request(app.baseUrl, "/api/v1/cases/drafts", {
    method: "POST",
    headers: deniedHeaders,
    body: { serviceCode: "ERP_MASTER_DATA_ISSUE", fields: {} },
  });
  assert.equal(bypassDraft.response.status, 404);

  const toolSearch = await request(app.baseUrl, "/api/v1/tools/search-service-catalog", {
    method: "POST",
    headers: { ...deniedHeaders, "X-Tool-Key": "audience-tool-key" },
    body: { query: "ERP" },
  });
  assert.deepEqual(toolSearch.payload.services, []);
});

test("服务受众策略收紧后阻止旧草稿继续修改和生成确认", async (t) => {
  const app = await startApp();
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.db.close();
  });
  const draft = await request(app.baseUrl, "/api/v1/cases/drafts", {
    method: "POST",
    body: { serviceCode: "CRM_ACCOUNT_CHANGE", fields: { customerCode: "C-POLICY-001" } },
  });
  app.db.prepare("UPDATE service_items SET audience_policy_json = ? WHERE service_code = 'CRM_ACCOUNT_CHANGE'")
    .run(JSON.stringify({ visibility: "DEPARTMENTS", departmentIds: ["D-OTHER"] }));

  const update = await request(app.baseUrl, `/api/v1/cases/${draft.payload.case.globalRequestNo}/draft`, {
    method: "PATCH",
    body: { expectedVersion: draft.payload.case.version, fields: { reason: "不应允许继续修改" } },
  });
  assert.equal(update.response.status, 404);
  assert.equal(update.payload.error.code, "SERVICE_NOT_FOUND");
  const prepare = await request(app.baseUrl, `/api/v1/cases/${draft.payload.case.globalRequestNo}/prepare-confirmation`, { method: "POST", body: {} });
  assert.equal(prepare.response.status, 404);
  assert.equal(prepare.payload.error.code, "SERVICE_NOT_FOUND");

  app.db.prepare("UPDATE service_items SET audience_policy_json = ? WHERE service_code = 'CRM_ACCOUNT_CHANGE'")
    .run(JSON.stringify({ visibility: "ALL_EMPLOYEES", departmentIds: [] }));
  const complete = await request(app.baseUrl, "/api/v1/cases/drafts", {
    method: "POST",
    body: { serviceCode: "CRM_ACCOUNT_CHANGE", fields: { customerCode: "C-POLICY-002", currentOwnerEmployeeId: "E10001", newOwnerEmployeeId: "E20002", reason: "提交前权限收紧验证", effectiveDate: "2026-08-20" } },
  });
  const confirmation = await request(app.baseUrl, `/api/v1/cases/${complete.payload.case.globalRequestNo}/prepare-confirmation`, { method: "POST", body: {} });
  assert.equal(confirmation.response.status, 200);
  app.db.prepare("UPDATE service_items SET audience_policy_json = ? WHERE service_code = 'CRM_ACCOUNT_CHANGE'")
    .run(JSON.stringify({ visibility: "DEPARTMENTS", departmentIds: ["D-OTHER"] }));
  const submit = await request(app.baseUrl, `/api/v1/cases/${complete.payload.case.globalRequestNo}/submit`, {
    method: "POST",
    body: { draftVersion: confirmation.payload.case.version, confirmationToken: confirmation.payload.confirmationToken, idempotencyKey: "policy-revoked-before-submit" },
  });
  assert.equal(submit.response.status, 404);
  assert.equal(submit.payload.error.code, "SERVICE_NOT_FOUND");
  assert.equal(Number(app.db.prepare("SELECT COUNT(*) AS count FROM external_tickets WHERE case_id = ?").get(complete.payload.case.caseId).count), 0);
});
