import test from "node:test";
import assert from "node:assert/strict";
import { createApplication } from "../src/server.mjs";
import { metricsInternals } from "../src/observability/metrics.mjs";

test("指标端点使用独立Bearer凭据并且不暴露员工、密钥或高基数路径", async (t) => {
  const metricsApiKey = "metrics-test-key-that-is-long-and-unique";
  const app = createApplication({ databasePath: ":memory:", metricsApiKey, authRateLimit: 1 });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  assert.equal((await fetch(`${baseUrl}/internal/metrics`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/internal/metrics`, { headers: { authorization: "Bearer wrong" } })).status, 429);
  const employeeId = "E-METRIC-PRIVATE";
  assert.equal((await fetch(`${baseUrl}/api/v1/services`, { headers: { "x-employee-id": employeeId, "x-department-id": "D-ORG" } })).status, 200);
  for (let index = 0; index < 5; index += 1) assert.equal((await fetch(`${baseUrl}/unknown/${index}-${employeeId}`)).status, 404);

  const response = await fetch(`${baseUrl}/internal/metrics`, { headers: { authorization: `Bearer ${metricsApiKey}` } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/openmetrics-text/);
  const body = await response.text();
  assert.match(body, /ai_demand_build_info\{version="1\.17\.0"\} 1/);
  assert.match(body, /ai_demand_identity_states\{status="BLOCKED"\} 0/);
  assert.match(body, /ai_demand_http_requests_total\{method="GET",route="api_v1_services",status_class="2xx"\} 1/);
  assert.match(body, /ai_demand_http_requests_total\{method="GET",route="other",status_class="4xx"\} 5/);
  assert.match(body, /ai_demand_cases\{status="DRAFT"\} 0/);
  assert.match(body, /ai_demand_audit_chain_startup_valid 1/);
  assert.match(body, /ai_demand_organization_directory_required_services 0/);
  assert.match(body, /ai_demand_organization_directory_available\{state="missing"\} 1/);
  assert.match(body, /ai_demand_rate_limit_rejections_total\{scope="auth",overloaded="false"\} 1/);
  assert.match(body, /# EOF\n$/);
  assert.equal(body.includes(employeeId), false);
  assert.equal(body.includes(metricsApiKey), false);
  assert.equal(body.includes("unknown/0"), false);
});

test("指标路由标签只允许固定集合并折叠动态业务编号", () => {
  assert.equal(metricsInternals.routeLabel("/api/v1/cases/REQ-20260817-000001"), "api_v1_cases_number");
  assert.equal(metricsInternals.routeLabel("/api/v1/admin/integration-tasks/123e4567-e89b-12d3-a456-426614174000/retry"), "api_v1_admin_integration_tasks_id_retry");
  assert.equal(metricsInternals.routeLabel("/api/v1/webhooks/CRM/status"), "api_v1_webhooks_system_status");
  assert.equal(metricsInternals.routeLabel("/api/v1/tools/attacker-controlled-value"), "other");
  assert.equal(metricsInternals.routeLabel("/contains/private/employee-id"), "other");
  assert.equal(metricsInternals.methodLabel("TRACE"), "OTHER");
});

test("未配置监控凭据时指标端点保持关闭", async (t) => {
  const app = createApplication({ databasePath: ":memory:" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/internal/metrics`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "METRICS_DISABLED");
});
