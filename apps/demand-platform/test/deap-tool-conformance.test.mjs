import assert from "node:assert/strict";
import test from "node:test";
import { runDeapToolConformance } from "../src/conformance/deap-tool-conformance.mjs";
import { signIdentityContext } from "../src/domain/identity-signature.mjs";
import { createApplication } from "../src/server.mjs";

const toolApiKey = "deap-conformance-tool-key-long-enough-v07";
const identityHmacSecret = "deap-conformance-identity-secret-long-v07";
const adminApiKey = "deap-conformance-admin-key-long-enough-v07";

async function startApp() {
  const app = createApplication({
    databasePath: ":memory:",
    confirmationSecret: "deap-conformance-confirmation-secret-v07",
    webhookSecret: "deap-conformance-webhook-secret-v07-different",
    analyticsHashSecret: "deap-conformance-analytics-hash-secret-v07",
    toolApiKey,
    identityHmacSecret,
    adminApiKey,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  return { ...app, baseUrl: `http://127.0.0.1:${app.server.address().port}` };
}

test("DEAP只读联调器验证双层鉴权、调用防重放和五个基础工具", async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const report = await runDeapToolConformance({ baseUrl: app.baseUrl, toolKey: toolApiKey, identitySecret: identityHmacSecret });

  assert.equal(report.outcome, "PASS");
  assert.equal(report.mode, "READ_ONLY");
  assert.equal(report.target, "REDACTED_TARGET");
  assert.equal(report.targetClass, "LOOPBACK");
  assert.match(report.targetFingerprint, /^[A-F0-9]{64}$/);
  assert.ok(!JSON.stringify(report).includes(app.baseUrl));
  assert.equal(report.summary.failed, 0);
  assert.equal(report.operationsCovered.length, 5);
  assert.equal(report.missingOperations.length, 0);
  assert.ok(report.cases.some((item) => item.errorCode === "INVALID_TOOL_CREDENTIAL"));
  assert.ok(report.cases.some((item) => item.errorCode === "INVALID_IDENTITY_SIGNATURE"));
  assert.ok(report.cases.some((item) => item.errorCode === "TOOL_INVOCATION_REPLAY"));

  const rows = app.services.toolInvocations.listAdmin({ limit: 20 });
  assert.equal(rows.length, 5);
  assert.ok(rows.every((row) => row.outcome === "SUCCESS"));
  assert.ok(rows.every((row) => !Object.hasOwn(row, "employeeHash")));

  app.db.prepare("UPDATE tool_invocations SET created_at = ?, completed_at = ? WHERE invocation_id = ?").run("2020-01-01T00:00:00.000Z", "2020-01-01T00:00:01.000Z", rows[0].invocationId);
  app.services.toolInvocations.nextCleanupAt = 0;
  const cleanupProbe = app.services.toolInvocations.start({ requestedId: "retention:cleanup:probe", operationId: "get_employee_context", employee: { employeeId: "E-CLEANUP", departmentId: "D-ORG" }, traceId: "retention-trace" });
  app.services.toolInvocations.finish(cleanupProbe, { outcome: "SUCCESS", httpStatus: 200 });
  assert.equal(app.db.prepare("SELECT invocation_id FROM tool_invocations WHERE invocation_id = ?").get(rows[0].invocationId), undefined);
});

test("DEAP全量联调器经明确允许后覆盖十三个工具并生成真实业务闭环", async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const report = await runDeapToolConformance({
    baseUrl: app.baseUrl,
    toolKey: toolApiKey,
    identitySecret: identityHmacSecret,
    allowWrite: true,
    serviceCode: "CRM_ACCOUNT_CHANGE",
    sampleFields: {
      customerCode: "C-DEAP-001",
      currentOwnerEmployeeId: "E10001",
      newOwnerEmployeeId: "E20002",
      reason: "DEAP工具链全量联调验证",
      effectiveDate: "2026-08-20",
    },
  });

  assert.equal(report.outcome, "PASS");
  assert.equal(report.mode, "FULL_WRITE");
  assert.equal(report.operationsCovered.length, 13);
  assert.equal(report.missingOperations.length, 0);
  assert.ok(!JSON.stringify(report).includes("C-DEAP-001"));
  assert.equal(Number(app.db.prepare("SELECT COUNT(*) AS count FROM demand_cases").get().count), 1);
  assert.equal(Number(app.db.prepare("SELECT COUNT(*) AS count FROM handoff_items").get().count), 1);
  assert.equal(Number(app.db.prepare("SELECT COUNT(*) AS count FROM employee_feedback").get().count), 1);

  const adminResponse = await fetch(`${app.baseUrl}/api/v1/admin/tool-invocations?outcome=SUCCESS&limit=200`, { headers: { "X-Admin-Key": adminApiKey } });
  assert.equal(adminResponse.status, 200);
  const adminPayload = await adminResponse.json();
  assert.ok(adminPayload.invocations.length >= 13);
  assert.ok(adminPayload.invocations.every((row) => !JSON.stringify(row).includes("E-DEAP-CONFORMANCE")));
  const adminHtml = await (await fetch(`${app.baseUrl}/admin`)).text();
  const adminScript = await (await fetch(`${app.baseUrl}/admin.js`)).text();
  assert.match(adminHtml, /data-view="tool-calls"/);
  assert.match(adminHtml, /id="tool-call-table"/);
  assert.match(adminScript, /\/api\/v1\/admin\/tool-invocations/);
});

test("失败的已认证工具调用保留错误码和关联编号但不保存业务正文", async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const timestamp = Math.floor(Date.now() / 1000);
  const invocationId = "failure:deap:tool:0001";
  const response = await fetch(`${app.baseUrl}/api/v1/tools/get-service-form-schema`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Tool-Key": toolApiKey,
      "X-Employee-Id": "E-FAILURE",
      "X-Department-Id": "D-SECRET",
      "X-Identity-Timestamp": String(timestamp),
      "X-Identity-Signature": signIdentityContext({ employeeId: "E-FAILURE", departmentId: "D-SECRET", timestamp, secret: identityHmacSecret }),
      "X-Tool-Invocation-Id": invocationId,
    },
    body: JSON.stringify({ serviceCode: "NOT_A_REAL_SERVICE", confidentialValue: "must-not-be-stored" }),
  });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("x-tool-invocation-id"), invocationId);
  const rows = app.services.toolInvocations.listAdmin({ outcome: "FAILURE" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].errorCode, "SERVICE_NOT_FOUND");
  const persisted = JSON.stringify(app.db.prepare("SELECT * FROM tool_invocations WHERE invocation_id = ?").get(invocationId));
  assert.ok(!persisted.includes("must-not-be-stored"));
  assert.ok(!persisted.includes("E-FAILURE"));
});
