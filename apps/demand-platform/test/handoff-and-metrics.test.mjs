import test from "node:test";
import assert from "node:assert/strict";
import { createApplication } from "../src/server.mjs";

const employeeHeaders = { "X-Employee-Id": "E-HANDOFF", "X-Department-Id": "D-ORG", "X-Employee-Name": encodeURIComponent("接管测试员工") };

async function request(baseUrl, path, { method = "GET", body, headers = employeeHeaders } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

test("无法匹配事项可经员工确认转人工、幂等处理并由管理队列闭环", async (t) => {
  const app = createApplication({
    databasePath: ":memory:",
    confirmationSecret: "handoff-confirmation-secret-long-enough",
    webhookSecret: "handoff-webhook-secret-is-long-enough",
    adminApiKey: "handoff-admin-api-key-is-long-enough",
    analyticsHashSecret: "handoff-analytics-hash-secret-long-enough",
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.db.close();
  });
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const originalMessage = "我要办理一个目录中完全没有的特殊事项";
  const assistant = await request(baseUrl, "/api/v1/assistant/messages", { method: "POST", body: { message: originalMessage, conversationId: "CONV-HANDOFF-1" } });
  assert.equal(assistant.payload.type, "HANDOFF_SUGGESTED");

  const handoffBody = {
    originalMessage,
    summary: "员工提出目录外特殊事项，需要人工识别承接团队。",
    reasonCode: "NO_MATCH",
    conversationId: "CONV-HANDOFF-1",
    idempotencyKey: "handoff-conv-handoff-1",
  };
  const unconfirmed = await request(baseUrl, "/api/v1/handoffs", { method: "POST", body: handoffBody });
  assert.equal(unconfirmed.response.status, 409);
  assert.equal(unconfirmed.payload.error.code, "HANDOFF_CONFIRMATION_REQUIRED");

  const created = await request(baseUrl, "/api/v1/handoffs", { method: "POST", body: { ...handoffBody, employeeConfirmed: true } });
  assert.equal(created.response.status, 201);
  assert.match(created.payload.handoff.handoffNo, /^HOF-\d{8}-\d{6}$/);
  assert.equal(created.payload.handoff.status, "OPEN");
  assert.equal(created.payload.idempotentReplay, false);
  const handoffNo = created.payload.handoff.handoffNo;

  const replay = await request(baseUrl, "/api/v1/handoffs", { method: "POST", body: { ...handoffBody, employeeConfirmed: true } });
  assert.equal(replay.payload.idempotentReplay, true);
  assert.equal(replay.payload.handoff.handoffNo, handoffNo);
  const conflict = await request(baseUrl, "/api/v1/handoffs", { method: "POST", body: { ...handoffBody, summary: "不同内容", employeeConfirmed: true } });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.payload.error.code, "IDEMPOTENCY_CONFLICT");

  const otherEmployee = await request(baseUrl, `/api/v1/handoffs/${handoffNo}`, { headers: { ...employeeHeaders, "X-Employee-Id": "E-OTHER" } });
  assert.equal(otherEmployee.response.status, 404);

  const statusAnswer = await request(baseUrl, "/api/v1/assistant/messages", { method: "POST", body: { message: `查询 ${handoffNo} 进度` } });
  assert.equal(statusAnswer.payload.type, "HANDOFF_STATUS");

  const noAdmin = await request(baseUrl, "/api/v1/admin/handoffs", { headers: {} });
  assert.equal(noAdmin.response.status, 401);
  const adminHeaders = { "X-Admin-Key": "handoff-admin-api-key-is-long-enough", "X-Admin-Id": "OPS-1" };
  const adminList = await request(baseUrl, "/api/v1/admin/handoffs?status=OPEN", { headers: adminHeaders });
  assert.equal(adminList.payload.handoffs.length, 1);

  const missingAssignee = await request(baseUrl, `/api/v1/admin/handoffs/${handoffNo}`, { method: "PATCH", headers: adminHeaders, body: { status: "ASSIGNED" } });
  assert.equal(missingAssignee.response.status, 422);
  const assigned = await request(baseUrl, `/api/v1/admin/handoffs/${handoffNo}`, { method: "PATCH", headers: adminHeaders, body: { status: "ASSIGNED", assignedTo: "ORG-SERVICE-AGENT-1" } });
  assert.equal(assigned.payload.handoff.status, "ASSIGNED");
  const resolved = await request(baseUrl, `/api/v1/admin/handoffs/${handoffNo}`, { method: "PATCH", headers: adminHeaders, body: { status: "RESOLVED", resolutionSummary: "已识别承接团队并通过原流程受理。" } });
  assert.equal(resolved.payload.handoff.status, "RESOLVED");

  const metrics = await request(baseUrl, "/api/v1/admin/metrics?days=7", { headers: adminHeaders });
  assert.equal(metrics.response.status, 200);
  assert.equal(metrics.payload.interactions.total, 2);
  assert.equal(metrics.payload.interactions.uniqueEmployees, 1);
  assert.equal(metrics.payload.handoffs.total, 1);
  assert.equal(metrics.payload.privacy.rawMessagesStoredInAnalytics, false);
  const storedInteraction = app.db.prepare("SELECT * FROM assistant_interactions LIMIT 1").get();
  assert.equal(JSON.stringify(storedInteraction).includes(originalMessage), false);
  const auditActions = app.db.prepare("SELECT action FROM audit_events ORDER BY audit_id").all().map((row) => row.action);
  assert.ok(auditActions.includes("CREATE_HANDOFF"));
  assert.ok(auditActions.includes("UPDATE_HANDOFF"));
  assert.ok(auditActions.includes("VIEW_HANDOFF_QUEUE"));
  assert.ok(auditActions.includes("VIEW_PILOT_METRICS"));
});
