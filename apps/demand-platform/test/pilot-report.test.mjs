import test from "node:test";
import assert from "node:assert/strict";
import { formatPilotReport } from "../src/reports/pilot-report.mjs";

test("试点指标可生成注明口径与缺口的Markdown周报", () => {
  const markdown = formatPilotReport({
    window: { days: 7, since: "2026-08-06T00:00:00.000Z", generatedAt: "2026-08-13T00:00:00.000Z" },
    interactions: { total: 10, uniqueEmployees: 6, byType: { ANSWER: 4, SERVICE_SUGGESTIONS: 5, HANDOFF_SUGGESTED: 1 } },
    demands: { total: 3, externalTickets: 2, byStatus: { SUBMITTED: 2, DRAFT: 1 }, byService: { CRM_ACCOUNT_CHANGE: 3 } },
    handoffs: { total: 1, byStatus: { OPEN: 1 } },
    integrations: { total: 3, byStatus: { SUCCEEDED: 2, RETRY_WAIT: 1 } },
    feedback: { total: 3, resolvedCount: 2, averageRating: 4.3, byReasonCode: { ANSWER_HELPFUL: 2, MISSING_INFORMATION: 1 } },
    indicators: { answerRate: 0.4, serviceSuggestionRate: 0.5, handoffSuggestionRate: 0.1, demandCreationRate: 0.3, externalTicketRate: 0.6667, confirmedHandoffRate: 1, feedbackResponseRate: 0.3, employeeConfirmedResolutionRate: 0.6667, positiveRatingRate: 0.6667, integrationTerminalSuccessRate: 1 },
  });
  assert.match(markdown, /知识回答占比 \| 40\.0%/);
  assert.match(markdown, /CRM_ACCOUNT_CHANGE/);
  assert.match(markdown, /不等同于员工确认已解决/);
  assert.match(markdown, /不保存原始问句/);
  assert.match(markdown, /RETRY_WAIT/);
  assert.match(markdown, /确认解决率（反馈样本）/);
  assert.match(markdown, /主动反馈样本/);
});
