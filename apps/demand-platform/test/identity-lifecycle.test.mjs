import assert from "node:assert/strict";
import test from "node:test";
import { createApplication } from "../src/server.mjs";
import { signWebhook } from "../src/domain/confirmation-token.mjs";
import { signIdentityContext } from "../src/domain/identity-signature.mjs";
import { runIdentityLifecycleConformance } from "../src/conformance/identity-lifecycle-conformance.mjs";

const identityHmacSecret = "identity-lifecycle-gateway-secret-long-enough";
const identityEventSecret = "identity-lifecycle-event-secret-long-enough";
const sourceSystem = "CORP_IAM";

function employeeHeaders(employeeId = "E-LIFECYCLE") {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    "X-Employee-Id": employeeId,
    "X-Department-Id": "D-ORG",
    "X-Employee-Name": encodeURIComponent("生命周期员工"),
    "X-Identity-Timestamp": String(timestamp),
    "X-Identity-Signature": signIdentityContext({ employeeId, departmentId: "D-ORG", timestamp, secret: identityHmacSecret }),
  };
}

function event(sequence, eventType, overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: `EVT-${sequence}`,
    sourceSystem,
    employeeId: "E-LIFECYCLE",
    sequence,
    eventType,
    occurredAt: new Date().toISOString(),
    reasonCode: eventType === "EMPLOYMENT_TERMINATED" ? "EMPLOYEE_LEFT" : "IAM_SYNC",
    ...overrides,
  };
}

async function postEvent(baseUrl, payload, secret = identityEventSecret) {
  const raw = JSON.stringify(payload);
  const response = await fetch(`${baseUrl}/api/v1/webhooks/identity/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Identity-Event-Signature": signWebhook(raw, secret) },
    body: raw,
  });
  return { response, payload: await response.json(), raw };
}

async function startApp() {
  const app = createApplication({
    databasePath: ":memory:",
    confirmationSecret: "identity-lifecycle-confirmation-long-enough",
    webhookSecret: "identity-lifecycle-business-webhook-long-enough",
    toolApiKey: "identity-lifecycle-tool-key-long-enough",
    adminApiKey: "identity-lifecycle-admin-key-long-enough",
    identityHmacSecret,
    identityEventSecret,
    identityEventSource: sourceSystem,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  return { ...app, baseUrl: `http://127.0.0.1:${app.server.address().port}` };
}

test("身份事件立即撤销会话，并在浏览器与DEAP工具链阻断停用员工", async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const headers = employeeHeaders();
  const login = await fetch(`${app.baseUrl}/api/v1/auth/session`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" });
  assert.equal(login.status, 201);
  const cookie = login.headers.get("set-cookie").split(";")[0];

  const changed = await postEvent(app.baseUrl, event(1, "MEMBERSHIP_CHANGED"));
  assert.equal(changed.response.status, 200);
  assert.equal(changed.payload.applied, true);
  assert.equal(changed.payload.revokedSessions, 1);
  assert.equal(changed.payload.state.accessStatus, "ACTIVE");
  const revokedAfterChange = await fetch(`${app.baseUrl}/api/v1/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(revokedAfterChange.status, 401);

  const relogin = await fetch(`${app.baseUrl}/api/v1/auth/session`, { method: "POST", headers: { ...employeeHeaders(), "content-type": "application/json" }, body: "{}" });
  assert.equal(relogin.status, 201);
  const suspended = await postEvent(app.baseUrl, event(2, "ACCESS_SUSPENDED", { reasonCode: "SECURITY_EVENT" }));
  assert.equal(suspended.response.status, 200);
  assert.equal(suspended.payload.state.accessStatus, "BLOCKED");
  assert.equal(suspended.payload.revokedSessions, 1);

  const browser = await fetch(`${app.baseUrl}/api/v1/services`, { headers: employeeHeaders() });
  assert.equal(browser.status, 403);
  assert.equal((await browser.json()).error.code, "EMPLOYEE_ACCESS_BLOCKED");
  const tool = await fetch(`${app.baseUrl}/api/v1/tools/search-service-catalog`, {
    method: "POST",
    headers: { ...employeeHeaders(), "X-Tool-Key": "identity-lifecycle-tool-key-long-enough", "content-type": "application/json" },
    body: JSON.stringify({ query: "CRM" }),
  });
  assert.equal(tool.status, 403);
  assert.equal((await tool.json()).error.code, "EMPLOYEE_ACCESS_BLOCKED");
  const blockedLogin = await fetch(`${app.baseUrl}/api/v1/auth/session`, { method: "POST", headers: { ...employeeHeaders(), "content-type": "application/json" }, body: "{}" });
  assert.equal(blockedLogin.status, 403);
  const states = await fetch(`${app.baseUrl}/api/v1/admin/identity-states?accessStatus=BLOCKED`, { headers: { "X-Admin-Key": "identity-lifecycle-admin-key-long-enough" } });
  assert.equal(states.status, 200);
  assert.equal((await states.json()).states[0].employeeId, "E-LIFECYCLE");
});

test("身份事件校验签名、来源、重放、事件ID复用与单调序号", async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const first = event(10, "EMPLOYMENT_TERMINATED");
  const invalidSignature = await postEvent(app.baseUrl, first, "wrong-identity-event-secret-long-enough");
  assert.equal(invalidSignature.response.status, 401);
  assert.equal(invalidSignature.payload.error.code, "INVALID_IDENTITY_EVENT_SIGNATURE");

  const accepted = await postEvent(app.baseUrl, first);
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.payload.duplicate, false);
  const duplicate = await postEvent(app.baseUrl, first);
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.payload.duplicate, true);

  const reused = await postEvent(app.baseUrl, { ...first, reasonCode: "SECURITY_EVENT" });
  assert.equal(reused.response.status, 409);
  assert.equal(reused.payload.error.code, "IDENTITY_EVENT_ID_REUSE");
  const outOfOrder = await postEvent(app.baseUrl, event(9, "ACCESS_RESTORED", { eventId: "EVT-OLDER" }));
  assert.equal(outOfOrder.response.status, 409);
  assert.equal(outOfOrder.payload.error.code, "IDENTITY_EVENT_OUT_OF_ORDER");
  const wrongSource = await postEvent(app.baseUrl, event(11, "ACCESS_RESTORED", { eventId: "EVT-SOURCE", sourceSystem: "UNTRUSTED" }));
  assert.equal(wrongSource.response.status, 401);
  assert.equal(wrongSource.payload.error.code, "IDENTITY_EVENT_SOURCE_MISMATCH");

  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM identity_lifecycle_events").get().count, 1);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'APPLY_IDENTITY_LIFECYCLE_EVENT'").get().count, 1);
  assert.throws(() => app.db.prepare("UPDATE identity_lifecycle_events SET reason_code = 'TAMPERED'").run(), /immutable/);
  assert.throws(() => app.db.prepare("DELETE FROM identity_lifecycle_events").run(), /immutable/);
});

test("非授权资料变更不会解除停用，只有更高序号的恢复事件可重新开放", async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await postEvent(app.baseUrl, event(1, "ACCESS_SUSPENDED", { reasonCode: "SECURITY_EVENT" }));
  const profile = await postEvent(app.baseUrl, event(2, "IDENTITY_PROFILE_CHANGED"));
  assert.equal(profile.payload.state.accessStatus, "BLOCKED");
  const restored = await postEvent(app.baseUrl, event(3, "ACCESS_RESTORED", { reasonCode: "SECURITY_CLEARED" }));
  assert.equal(restored.response.status, 200);
  assert.equal(restored.payload.state.accessStatus, "ACTIVE");
  const login = await fetch(`${app.baseUrl}/api/v1/auth/session`, { method: "POST", headers: { ...employeeHeaders(), "content-type": "application/json" }, body: "{}" });
  assert.equal(login.status, 201);
});

test("身份事件拒绝过期、未来时间、未知字段和无效序号", async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const expired = await postEvent(app.baseUrl, event(1, "ACCESS_SUSPENDED", { occurredAt: new Date(Date.now() - 86401_000).toISOString() }));
  assert.equal(expired.response.status, 409);
  assert.equal(expired.payload.error.code, "IDENTITY_EVENT_EXPIRED");
  const future = await postEvent(app.baseUrl, event(1, "ACCESS_SUSPENDED", { occurredAt: new Date(Date.now() + 301_000).toISOString() }));
  assert.equal(future.response.status, 409);
  assert.equal(future.payload.error.code, "IDENTITY_EVENT_IN_FUTURE");
  const unknown = await postEvent(app.baseUrl, { ...event(1, "ACCESS_SUSPENDED"), rawProfile: "forbidden" });
  assert.equal(unknown.response.status, 400);
  assert.equal(unknown.payload.error.code, "INVALID_IDENTITY_EVENT");
  const invalidSequence = await postEvent(app.baseUrl, event(0, "ACCESS_SUSPENDED"));
  assert.equal(invalidSequence.response.status, 400);
});

test("身份生命周期联调器覆盖完整停用恢复链且报告不含原始员工号或密钥", async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const report = await runIdentityLifecycleConformance({
    baseUrl: app.baseUrl,
    eventSecret: identityEventSecret,
    identitySecret: identityHmacSecret,
    toolKey: "identity-lifecycle-tool-key-long-enough",
    sourceSystem,
    startingSequence: 100,
    employee: { employeeId: "E-CONFORMANCE-SECRET", departmentId: "D-ORG", name: "联调专用员工" },
    testEmployeeConfirmed: true,
  });
  assert.equal(report.outcome, "PASS");
  assert.equal(report.recovery.outcome, "PASS");
  assert.equal(report.missingScenarios.length, 0);
  assert.equal(report.summary.failed, 0);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /E-CONFORMANCE-SECRET/);
  assert.doesNotMatch(serialized, /identity-lifecycle-event-secret/);
  assert.equal(app.services.identityLifecycle.getState("E-CONFORMANCE-SECRET").accessStatus, "ACTIVE");
});
