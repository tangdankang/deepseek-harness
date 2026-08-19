import test from "node:test";
import assert from "node:assert/strict";
import { createApplication } from "../src/server.mjs";
import { capacityTestMarkdown, runCapacityTest, validateCapacityReport } from "../src/performance/capacity-test.mjs";

const toolKey = "capacity-test-tool-key-long-enough";
const identitySecret = "capacity-test-identity-secret-long-enough";

async function startApp() {
  const app = createApplication({
    databasePath: ":memory:",
    toolApiKey: toolKey,
    identityHmacSecret: identitySecret,
    confirmationSecret: "capacity-confirmation-secret-long-enough",
    webhookSecret: "capacity-webhook-secret-long-enough-different",
    analyticsHashSecret: "capacity-analytics-secret-long-enough",
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  return { ...app, baseUrl: `http://127.0.0.1:${app.server.address().port}` };
}

test("容量测试以多虚拟员工完成固定请求并输出脱敏运行时证据", async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const report = await runCapacityTest({
    baseUrl: app.baseUrl,
    toolKey,
    identitySecret,
    virtualEmployees: 30,
    requests: 90,
    concurrency: 10,
    targetRps: 300,
    warmupRequests: 6,
    departments: 3,
    thresholds: {
      maxErrorRate: 0,
      maxP95Ms: 2000,
      maxP99Ms: 3000,
      minThroughputRps: 1,
      maxEventLoopP99Ms: 1000,
      maxHeapGrowthMb: 256,
      maxRssGrowthMb: 256,
      maxRateLimitedRate: 0,
    },
    topology: "TEST_COMBINED_PROCESS",
  });
  assert.equal(report.outcome, "PASS");
  assert.equal(report.profile.virtualEmployees, 30);
  assert.equal(report.profile.arrivalModel, "OPEN_LOOP_SCHEDULED_RATE");
  assert.equal(report.profile.targetRps, 300);
  assert.equal(report.summary.completedRequests, 90);
  assert.equal(report.summary.successfulRequests, 90);
  assert.equal(report.summary.failedRequests, 0);
  assert.equal(report.summary.statusCounts["200"], 90);
  assert.equal(report.assertions.length, 9);
  assert.equal(report.safety.businessWritesGenerated, false);
  assert.equal(Number(app.db.prepare("SELECT COUNT(*) AS count FROM tool_invocations").get().count), 96);
  assert.equal(Number(app.db.prepare("SELECT COUNT(*) AS count FROM demand_cases").get().count), 0);
  assert.deepEqual(validateCapacityReport(report, { minVirtualEmployees: 30, minRequests: 90, minConcurrency: 10 }), { valid: true, findings: [], scope: { minVirtualEmployees: 30, minRequests: 90, minConcurrency: 10 } });
  const serialized = JSON.stringify(report);
  for (const secret of [toolKey, identitySecret, "CAP-DEPT", "http://127.0.0.1"]) assert.equal(serialized.includes(secret), false);
  assert.match(capacityTestMarkdown(report), /结果：\*\*PASS\*\*/);
});

test("容量门禁对不现实吞吐目标返回FAIL且报告校验拒绝小样本", async () => {
  const report = await runCapacityTest({
    baseUrl: "https://capacity-test.example",
    toolKey,
    identitySecret,
    virtualEmployees: 10,
    requests: 30,
    concurrency: 5,
    warmupRequests: 0,
    fetchImpl: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    thresholds: { minThroughputRps: 1000000, maxP95Ms: 5000, maxP99Ms: 5000, maxEventLoopP99Ms: 1000 },
  });
  assert.equal(report.outcome, "FAIL");
  assert.equal(report.assertions.find((item) => item.id === "THROUGHPUT_RPS").passed, false);
  assert.equal(validateCapacityReport(report).valid, false);
  await assert.rejects(() => runCapacityTest({ baseUrl: "https://capacity-test.example", toolKey, identitySecret, virtualEmployees: 20, requests: 10 }), /requests/);
});
