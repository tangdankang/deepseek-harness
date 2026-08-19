import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePilotGate, formatPilotGateReport } from "../src/reports/pilot-gate.mjs";

function metrics() {
  return {
    interactions: { total: 500, uniqueEmployees: 120 },
    feedback: { total: 100, averageRating: 4.5 },
    integrations: { byStatus: { SUCCEEDED: 200, DEAD: 0 } },
    indicators: { feedbackResponseRate: 0.25, employeeConfirmedResolutionRate: 0.6, integrationTerminalSuccessRate: 1 },
  };
}

function evidence() {
  return {
    pilotDays: 7,
    criticalSecurityIncidents: 0,
    duplicateDownstreamTickets: 0,
    criticalEvalPassRate: 1,
    routingAccuracy: 0.95,
    visualQaPassed: true,
    syntheticPilotPassed: true,
    rollbackDrillPassed: true,
    businessSignoff: true,
    securitySignoff: true,
    opsSignoff: true,
  };
}

test("全部自动指标和人工证据满足时才判定GO", () => {
  const result = evaluatePilotGate(metrics(), evidence());
  assert.equal(result.decision, "GO");
  assert.equal(result.summary.failed, 0);
  assert.equal(result.summary.missing, 0);
  assert.match(formatPilotGateReport(result), /GO（满足放行门槛）/);
});

test("任何失败项判定NO_GO，缺证据但无失败项判定NOT_READY", () => {
  const securityFailure = evaluatePilotGate(metrics(), { ...evidence(), criticalSecurityIncidents: 1 });
  assert.equal(securityFailure.decision, "NO_GO");
  assert.equal(securityFailure.rules.find((item) => item.id === "SECURITY_INCIDENTS").status, "FAIL");

  const incomplete = evaluatePilotGate(metrics(), {});
  assert.equal(incomplete.decision, "NOT_READY");
  assert.ok(incomplete.summary.missing > 0);
  assert.match(formatPilotGateReport(incomplete), /证据不完整/);
});

test("样本不足不能凭高比例误判可上线", () => {
  const tiny = metrics();
  tiny.interactions.total = 2;
  tiny.interactions.uniqueEmployees = 1;
  tiny.feedback.total = 1;
  const result = evaluatePilotGate(tiny, evidence());
  assert.equal(result.decision, "NO_GO");
  assert.equal(result.rules.find((item) => item.id === "INTERACTIONS").status, "FAIL");
  assert.equal(result.rules.find((item) => item.id === "FEEDBACK_COUNT").status, "FAIL");
});
