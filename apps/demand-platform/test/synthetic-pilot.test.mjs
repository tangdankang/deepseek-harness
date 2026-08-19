import assert from "node:assert/strict";
import test from "node:test";
import { runSyntheticPilot, validateSyntheticPilotReport } from "../src/pilot/synthetic-pilot.mjs";
import { createApplication } from "../src/server.mjs";

const toolApiKey = "synthetic-pilot-tool-key-long-enough-v08";
const identityHmacSecret = "synthetic-pilot-identity-secret-long-v08";

async function startApp() {
  const app = createApplication({
    databasePath: ":memory:",
    confirmationSecret: "synthetic-pilot-confirmation-secret-v08",
    webhookSecret: "synthetic-pilot-webhook-secret-v08-different",
    analyticsHashSecret: "synthetic-pilot-analytics-secret-v08",
    toolApiKey,
    identityHmacSecret,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  return { ...app, baseUrl: `http://127.0.0.1:${app.server.address().port}` };
}

const sampleFields = {
  customerCode: "C-SYNTHETIC-001",
  currentOwnerEmployeeId: "E10001",
  newOwnerEmployeeId: "E20002",
  reason: "合成试点完整业务闭环验证",
  effectiveDate: "2026-08-20",
};

test("只读合成试点并发模拟20名员工且不产生业务写入", async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const report = await runSyntheticPilot({ baseUrl: app.baseUrl, toolKey: toolApiKey, identitySecret: identityHmacSecret, employeeCount: 20, concurrency: 5 });

  assert.equal(report.outcome, "PASS");
  assert.equal(report.mode, "SYNTHETIC_READ_ONLY");
  assert.equal(report.profile.employees, 20);
  assert.equal(report.profile.departments, 2);
  assert.equal(report.summary.totalCalls, 60);
  assert.equal(report.summary.failedCalls, 0);
  assert.equal(Number(app.db.prepare("SELECT COUNT(*) AS count FROM demand_cases").get().count), 0);
  assert.equal(Number(app.db.prepare("SELECT COUNT(*) AS count FROM tool_invocations").get().count), 60);
});

test("全量合成试点验证跨员工隔离、重复提交和无重复下游工单", async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const report = await runSyntheticPilot({
    baseUrl: app.baseUrl,
    toolKey: toolApiKey,
    identitySecret: identityHmacSecret,
    employeeCount: 20,
    concurrency: 5,
    allowWrite: true,
    writeEmployeeCount: 10,
    serviceCode: "CRM_ACCOUNT_CHANGE",
    sampleFields,
  });

  assert.equal(report.outcome, "PASS");
  assert.equal(report.summary.totalCalls, 160);
  assert.equal(report.security.crossEmployeeDenied, 10);
  assert.equal(report.security.crossEmployeeDenialRate, 1);
  assert.equal(report.idempotency.replayConfirmed, 10);
  assert.equal(report.idempotency.idempotentReplayRate, 1);
  assert.equal(report.idempotency.duplicateTicketFindings, 0);
  assert.deepEqual(report.business, { casesCreated: 10, externalTicketsObserved: 10, handoffsCreated: 10, feedbackRecorded: 10 });
  assert.deepEqual(validateSyntheticPilotReport(report), { valid: true, findings: [], scope: { minEmployees: 20, minDepartments: 2, minWriteEmployees: 10, minCalls: 100 } });
  assert.equal(validateSyntheticPilotReport({ ...report, security: { ...report.security, crossEmployeeDenialRate: 0.9 } }).valid, false);
  assert.equal(Number(app.db.prepare("SELECT COUNT(*) AS count FROM demand_cases").get().count), 10);
  assert.equal(Number(app.db.prepare("SELECT COUNT(*) AS count FROM external_tickets").get().count), 10);
  assert.equal(Number(app.db.prepare("SELECT COUNT(*) AS count FROM handoff_items").get().count), 10);
  assert.equal(Number(app.db.prepare("SELECT COUNT(*) AS count FROM employee_feedback").get().count), 10);
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes("C-SYNTHETIC-001"));
  assert.ok(!serialized.includes("E10001"));
  assert.ok(!serialized.includes(toolApiKey));
  await assert.rejects(() => runSyntheticPilot({ baseUrl: app.baseUrl, toolKey: toolApiKey, identitySecret: identityHmacSecret, thresholds: { maxP95Ms: 0 } }), /maxP95Ms/);
});
