import test from "node:test";
import assert from "node:assert/strict";
import { createApplication } from "../src/server.mjs";

const employeeHeaders = { "X-Employee-Id": "E-FEEDBACK", "X-Department-Id": "D-ORG" };

async function request(baseUrl, path, { method = "GET", body, headers = employeeHeaders } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

test("员工只能对本人真实对象提交一次明确反馈，且统计不保存自由文本", async (t) => {
  const app = createApplication({
    databasePath: ":memory:",
    confirmationSecret: "feedback-confirmation-secret-long-enough",
    webhookSecret: "feedback-webhook-secret-is-long-enough",
    adminApiKey: "feedback-admin-api-key-is-long-enough",
    analyticsHashSecret: "feedback-analytics-hash-secret-long-enough",
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.db.close();
  });
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const answer = await request(baseUrl, "/api/v1/assistant/messages", { method: "POST", body: { message: "客户归属怎么改？", conversationId: "CONV-FEEDBACK-1" } });
  assert.equal(answer.payload.type, "ANSWER");

  const body = {
    employeeConfirmed: true,
    subjectType: "CONVERSATION",
    subjectId: "CONV-FEEDBACK-1",
    resolved: true,
    rating: 5,
    reasonCodes: ["ANSWER_HELPFUL"],
    idempotencyKey: "feedback-conv-feedback-1",
  };
  const created = await request(baseUrl, "/api/v1/feedback", { method: "POST", body });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.feedback.resolved, true);
  const replay = await request(baseUrl, "/api/v1/feedback", { method: "POST", body });
  assert.equal(replay.payload.idempotentReplay, true);
  const changed = await request(baseUrl, "/api/v1/feedback", { method: "POST", body: { ...body, resolved: false } });
  assert.equal(changed.response.status, 409);
  assert.equal(changed.payload.error.code, "IDEMPOTENCY_CONFLICT");

  const duplicate = await request(baseUrl, "/api/v1/feedback", { method: "POST", body: { ...body, idempotencyKey: "feedback-second-key-001" } });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.payload.error.code, "FEEDBACK_ALREADY_RECORDED");
  const foreign = await request(baseUrl, "/api/v1/feedback", { method: "POST", headers: { "X-Employee-Id": "E-OTHER", "X-Department-Id": "D-OTHER" }, body: { ...body, idempotencyKey: "feedback-foreign-key-001" } });
  assert.equal(foreign.response.status, 404);

  const metrics = await request(baseUrl, "/api/v1/admin/metrics?days=7", { headers: { "X-Admin-Key": "feedback-admin-api-key-is-long-enough" } });
  assert.equal(metrics.payload.feedback.total, 1);
  assert.equal(metrics.payload.feedback.resolvedCount, 1);
  assert.equal(metrics.payload.feedback.averageRating, 5);
  assert.equal(metrics.payload.indicators.employeeConfirmedResolutionRate, 1);
  assert.equal(metrics.payload.indicators.feedbackResponseRate, 1);
  assert.equal(metrics.payload.privacy.freeTextFeedbackStored, false);

  const stored = app.db.prepare("SELECT * FROM employee_feedback LIMIT 1").get();
  assert.equal("comment" in stored, false);
  assert.equal(stored.employee_hash.includes("E-FEEDBACK"), false);
});

test("反馈校验拒绝未确认、伪造对象、无效评分和自由文本外字段", async (t) => {
  const app = createApplication({ databasePath: ":memory:", confirmationSecret: "feedback-validation-confirmation-secret", webhookSecret: "feedback-validation-webhook-secret", analyticsHashSecret: "feedback-validation-analytics-secret" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => app.server.close(resolve)); app.db.close(); });
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  await request(baseUrl, "/api/v1/assistant/messages", { method: "POST", body: { message: "客户归属怎么改？", conversationId: "CONV-FEEDBACK-2" } });
  const base = { subjectType: "CONVERSATION", subjectId: "CONV-FEEDBACK-2", resolved: false, rating: 2, reasonCodes: ["MISSING_INFORMATION"], idempotencyKey: "feedback-validation-001" };
  assert.equal((await request(baseUrl, "/api/v1/feedback", { method: "POST", body: base })).payload.error.code, "FEEDBACK_CONFIRMATION_REQUIRED");
  assert.equal((await request(baseUrl, "/api/v1/feedback", { method: "POST", body: { ...base, employeeConfirmed: true, rating: 6 } })).payload.error.code, "INVALID_FEEDBACK");
  assert.equal((await request(baseUrl, "/api/v1/feedback", { method: "POST", body: { ...base, employeeConfirmed: true, subjectId: "CONV-NOT-OWNED" } })).payload.error.code, "FEEDBACK_SUBJECT_NOT_FOUND");
  assert.equal((await request(baseUrl, "/api/v1/feedback", { method: "POST", body: { ...base, employeeConfirmed: true, comment: "这里不应保存自由文本" } })).payload.error.code, "INVALID_FEEDBACK");
});

test("需求和人工受理反馈同样执行本人归属校验", (t) => {
  const app = createApplication({ databasePath: ":memory:", confirmationSecret: "feedback-resource-confirmation-secret", webhookSecret: "feedback-resource-webhook-secret", analyticsHashSecret: "feedback-resource-analytics-secret" });
  t.after(() => app.db.close());
  const employee = { employeeId: "E-RESOURCE", departmentId: "D-ORG", name: "资源员工" };
  const other = { employeeId: "E-OTHER", departmentId: "D-OTHER", name: "其他员工" };
  const draft = app.services.demands.createDraft(employee, { serviceCode: "SYSTEM_ACCESS_HELP", fields: {} });
  const handoff = app.services.handoffs.create(employee, {
    employeeConfirmed: true,
    originalMessage: "目录外资源反馈事项",
    summary: "用于验证人工事项反馈归属",
    reasonCode: "NO_MATCH",
    idempotencyKey: "handoff-resource-feedback-001",
  });
  const caseFeedback = app.services.feedback.record(employee, { employeeConfirmed: true, subjectType: "CASE", subjectId: draft.case.globalRequestNo, resolved: false, rating: 3, reasonCodes: ["TOO_COMPLEX"], idempotencyKey: "feedback-case-resource-001" });
  assert.equal(caseFeedback.feedback.subjectType, "CASE");
  const handoffFeedback = app.services.feedback.record(employee, { employeeConfirmed: true, subjectType: "HANDOFF", subjectId: handoff.handoff.handoffNo, resolved: true, rating: 5, reasonCodes: ["ANSWER_HELPFUL"], idempotencyKey: "feedback-handoff-resource-001" });
  assert.equal(handoffFeedback.feedback.subjectType, "HANDOFF");
  assert.throws(() => app.services.feedback.record(other, { employeeConfirmed: true, subjectType: "CASE", subjectId: draft.case.globalRequestNo, resolved: false, rating: 1, reasonCodes: ["OTHER"], idempotencyKey: "feedback-foreign-resource-001" }), (error) => error.code === "FEEDBACK_SUBJECT_NOT_FOUND");
});
