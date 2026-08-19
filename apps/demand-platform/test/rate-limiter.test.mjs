import assert from "node:assert/strict";
import test from "node:test";
import { FixedWindowRateLimiter } from "../src/security/rate-limiter.mjs";
import { createApplication } from "../src/server.mjs";

async function startApp(options = {}) {
  const app = createApplication({
    databasePath: ":memory:",
    analyticsHashSecret: "rate-limit-analytics-hash-secret-long-enough",
    ...options,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  return { ...app, baseUrl: `http://127.0.0.1:${app.server.address().port}` };
}

test("固定窗口按HMAC主体隔离、只记录首次拒绝并在新窗口恢复", () => {
  let now = Date.parse("2026-08-17T08:00:00.000Z");
  const limiter = new FixedWindowRateLimiter({ secret: "unit-rate-limit-secret-long-enough", windowSeconds: 60, maxEntries: 2, now: () => now });
  assert.equal(limiter.consume({ scope: "tool", subject: "EMPLOYEE-SECRET-001", limit: 2 }).allowed, true);
  assert.equal(limiter.consume({ scope: "tool", subject: "EMPLOYEE-SECRET-001", limit: 2 }).remaining, 0);
  const rejected = limiter.consume({ scope: "tool", subject: "EMPLOYEE-SECRET-001", limit: 2 });
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.firstRejected, true);
  assert.equal(limiter.consume({ scope: "tool", subject: "EMPLOYEE-SECRET-001", limit: 2 }).firstRejected, false);
  assert.ok(!JSON.stringify([...limiter.entries.keys()]).includes("EMPLOYEE-SECRET-001"));
  assert.equal(limiter.consume({ scope: "tool", subject: "EMPLOYEE-OTHER", limit: 2 }).allowed, true);
  const overloaded = limiter.consume({ scope: "tool", subject: "EMPLOYEE-THIRD", limit: 2 });
  assert.equal(overloaded.overloaded, true);
  assert.equal(overloaded.firstRejected, true);
  assert.equal(limiter.consume({ scope: "tool", subject: "EMPLOYEE-FOURTH", limit: 2 }).firstRejected, false);
  now += 60000;
  assert.equal(limiter.consume({ scope: "tool", subject: "EMPLOYEE-SECRET-001", limit: 2 }).allowed, true);
});

test("员工接口超限返回429和Retry-After且不影响其他员工", async (t) => {
  const app = await startApp({ employeeRateLimit: 2 });
  t.after(() => app.close());
  const request = (employeeId) => fetch(`${app.baseUrl}/api/v1/services`, { headers: { "X-Employee-Id": employeeId, "X-Department-Id": "D-RATE" } });
  assert.equal((await request("E-RATE-1")).status, 200);
  assert.equal((await request("E-RATE-1")).status, 200);
  const limited = await request("E-RATE-1");
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.equal(limited.headers.get("x-ratelimit-limit"), "2");
  const payload = await limited.json();
  assert.equal(payload.error.code, "RATE_LIMIT_EXCEEDED");
  assert.equal(JSON.stringify(payload).includes("E-RATE-1"), false);
  assert.equal((await request("E-RATE-2")).status, 200);
  const events = app.db.prepare("SELECT action, outcome, details_json FROM audit_events WHERE action = 'RATE_LIMITED'").all();
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "FAILURE");
});

test("DEAP工具超限仍生成调用编号和失败追踪", async (t) => {
  const toolApiKey = "rate-limit-tool-api-key-long-enough";
  const app = await startApp({ toolApiKey, toolRateLimit: 2 });
  t.after(() => app.close());
  const invoke = (index) => fetch(`${app.baseUrl}/api/v1/tools/get-employee-context`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Tool-Key": toolApiKey,
      "X-Employee-Id": "E-TOOL-RATE",
      "X-Department-Id": "D-RATE",
      "X-Tool-Invocation-Id": `rate-limit-tool-${index}`,
    },
    body: "{}",
  });
  assert.equal((await invoke(1)).status, 200);
  assert.equal((await invoke(2)).status, 200);
  const limited = await invoke(3);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("x-tool-invocation-id"), "rate-limit-tool-3");
  const tracked = app.db.prepare("SELECT outcome, http_status, error_code FROM tool_invocations WHERE invocation_id = ?").get("rate-limit-tool-3");
  assert.equal(tracked.outcome, "FAILURE");
  assert.equal(tracked.http_status, 429);
  assert.equal(tracked.error_code, "RATE_LIMIT_EXCEEDED");
});

test("无效DEAP凭据尝试受到独立认证限流", async (t) => {
  const app = await startApp({ toolApiKey: "valid-tool-api-key-long-enough", authRateLimit: 2 });
  t.after(() => app.close());
  const invoke = () => fetch(`${app.baseUrl}/api/v1/tools/get-employee-context`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Tool-Key": "invalid", "X-Employee-Id": "E-ATTACK", "X-Department-Id": "D-RATE" },
    body: "{}",
  });
  assert.equal((await invoke()).status, 401);
  assert.equal((await invoke()).status, 401);
  const limited = await invoke();
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.code, "RATE_LIMIT_EXCEEDED");
  assert.equal(Number(app.db.prepare("SELECT COUNT(*) AS count FROM tool_invocations").get().count), 0);
});
