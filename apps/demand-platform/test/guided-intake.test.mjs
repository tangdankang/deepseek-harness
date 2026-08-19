import assert from "node:assert/strict";
import test from "node:test";
import { createApplication } from "../src/server.mjs";

const headers = {
  "content-type": "application/json",
  "x-tool-key": "guided-intake-tool-key-long-enough-v1",
  "x-employee-id": "E-GUIDED-001",
  "x-department-id": "D-ORG",
};

async function startApp() {
  const app = createApplication({
    databasePath: ":memory:",
    confirmationSecret: "guided-intake-confirmation-secret-v1",
    webhookSecret: "guided-intake-webhook-secret-v1-different",
    analyticsHashSecret: "guided-intake-analytics-secret-v1",
    toolApiKey: headers["x-tool-key"],
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  return { ...app, baseUrl: `http://127.0.0.1:${app.server.address().port}` };
}

async function turn(app, body, invocationId) {
  const response = await fetch(`${app.baseUrl}/api/v1/tools/guided-request-turn`, {
    method: "POST",
    headers: { ...headers, "x-tool-invocation-id": invocationId },
    body: JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

test("引导式填单跨轮收集字段并在信息完整后进入确认阶段", async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const first = await turn(app, {
    action: "COLLECT",
    conversationId: "CONV-GUIDED-001",
    serviceCode: "CRM_ACCOUNT_CHANGE",
    fieldUpdates: { customerCode: "C-GUIDED-001" },
  }, "guided:collect:001");
  assert.equal(first.response.status, 200);
  assert.equal(first.payload.stage, "COLLECTING_INFORMATION");
  assert.equal(first.payload.case.conversationId, "CONV-GUIDED-001");
  assert.ok(first.payload.nextQuestions.some((item) => item.fieldName === "reason"));
  assert.ok(!JSON.stringify(first.payload.nextQuestions).includes("C-GUIDED-001"));

  const second = await turn(app, {
    action: "COLLECT",
    conversationId: "CONV-GUIDED-001",
    globalRequestNo: first.payload.case.globalRequestNo,
    expectedVersion: first.payload.case.version,
    fieldUpdates: {
      currentOwnerEmployeeId: "E10001",
      newOwnerEmployeeId: "E20002",
      reason: "客户归属调整，已获得业务负责人同意",
      effectiveDate: "2026-08-20",
    },
  }, "guided:collect:002");
  assert.equal(second.response.status, 200);
  assert.equal(second.payload.stage, "READY_FOR_CONFIRMATION");
  assert.equal(second.payload.validation.valid, true);
  assert.deepEqual(second.payload.nextQuestions, []);
  assert.equal(Number(app.db.prepare("SELECT COUNT(*) AS count FROM external_tickets").get().count), 0);
});

test("引导式填单拒绝未知字段、串线会话和未经员工确认的提交", async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const badField = await turn(app, {
    action: "COLLECT",
    conversationId: "CONV-GUIDED-002",
    serviceCode: "CRM_ACCOUNT_CHANGE",
    fieldUpdates: { injectedField: "不得写入" },
  }, "guided:bad-field:001");
  assert.equal(badField.response.status, 200);
  assert.equal(badField.payload.stage, "COLLECTING_INFORMATION");
  assert.ok(badField.payload.validation.fieldErrors.some((item) => item.code === "UNKNOWN_FIELD"));
  assert.equal(Object.hasOwn(badField.payload.case.fields, "injectedField"), false);

  const unknownInput = await turn(app, {
    action: "COLLECT",
    serviceCode: "CRM_ACCOUNT_CHANGE",
    fieldUpdates: {},
    rawEmployeeMessage: "不应被高层工具接收或保存",
  }, "guided:unknown-input:001");
  assert.equal(unknownInput.response.status, 400);
  assert.equal(unknownInput.payload.error.code, "INVALID_GUIDED_INTAKE_REQUEST");

  const mismatch = await turn(app, {
    action: "COLLECT",
    conversationId: "CONV-WRONG",
    globalRequestNo: badField.payload.case.globalRequestNo,
    expectedVersion: badField.payload.case.version,
    fieldUpdates: { customerCode: "C-002" },
  }, "guided:mismatch:001");
  assert.equal(mismatch.response.status, 409);
  assert.equal(mismatch.payload.error.code, "CONVERSATION_MISMATCH");

  const ready = await turn(app, {
    action: "COLLECT",
    conversationId: "CONV-GUIDED-003",
    serviceCode: "CRM_ACCOUNT_CHANGE",
    fieldUpdates: {
      customerCode: "C-GUIDED-003",
      currentOwnerEmployeeId: "E10001",
      newOwnerEmployeeId: "E20002",
      reason: "完整字段用于验证显式确认门禁",
      effectiveDate: "2026-08-20",
    },
  }, "guided:ready:001");
  const prepared = await turn(app, {
    action: "PREPARE_CONFIRMATION",
    conversationId: "CONV-GUIDED-003",
    globalRequestNo: ready.payload.case.globalRequestNo,
  }, "guided:prepare:001");
  assert.equal(prepared.payload.stage, "AWAITING_EXPLICIT_CONFIRMATION");

  const denied = await turn(app, {
    action: "CONFIRM_SUBMIT",
    conversationId: "CONV-GUIDED-003",
    globalRequestNo: ready.payload.case.globalRequestNo,
    draftVersion: prepared.payload.case.version,
    confirmationToken: prepared.payload.confirmationToken,
    idempotencyKey: "guided-submit-without-confirmation",
    employeeConfirmed: false,
  }, "guided:submit:denied");
  assert.equal(denied.response.status, 409);
  assert.equal(denied.payload.error.code, "EXPLICIT_CONFIRMATION_REQUIRED");
  assert.equal(Number(app.db.prepare("SELECT COUNT(*) AS count FROM external_tickets").get().count), 0);

  const submitted = await turn(app, {
    action: "CONFIRM_SUBMIT",
    conversationId: "CONV-GUIDED-003",
    globalRequestNo: ready.payload.case.globalRequestNo,
    draftVersion: prepared.payload.case.version,
    confirmationToken: prepared.payload.confirmationToken,
    idempotencyKey: "guided-submit-explicitly-confirmed",
    employeeConfirmed: true,
  }, "guided:submit:confirmed");
  assert.equal(submitted.response.status, 200);
  assert.equal(submitted.payload.stage, "SUBMITTED");
  assert.equal(Number(app.db.prepare("SELECT COUNT(*) AS count FROM external_tickets").get().count), 1);
});
