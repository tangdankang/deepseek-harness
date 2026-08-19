import assert from "node:assert/strict";
import test from "node:test";
import { createApplication } from "../src/server.mjs";
import { openDatabase } from "../src/db.mjs";
import { signIdentityContext } from "../src/domain/identity-signature.mjs";
import { SessionService } from "../src/services/session-service.mjs";

async function startApp() {
  const identityHmacSecret = "session-identity-gateway-secret-long-enough";
  const app = createApplication({
    databasePath: ":memory:",
    confirmationSecret: "session-confirmation-secret-long-enough",
    webhookSecret: "session-webhook-secret-long-enough-different",
    toolApiKey: "session-tool-key-long-enough",
    identityHmacSecret,
    sessionTtlSeconds: 3600,
    sessionCookieSecure: false,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  return { ...app, identityHmacSecret, baseUrl: `http://127.0.0.1:${app.server.address().port}` };
}

function gatewayHeaders(secret, employeeId = "E-SESSION", departmentId = "D-ORG", departmentIds = undefined) {
  const timestamp = Math.floor(Date.now() / 1000);
  const name = "会话测试员工";
  return {
    "X-Employee-Id": employeeId,
    "X-Department-Id": departmentId,
    "X-Employee-Name": encodeURIComponent(name),
    ...(departmentIds ? { "X-Identity-Version": "v2", "X-Department-Ids": departmentIds.join(",") } : {}),
    "X-Identity-Timestamp": String(timestamp),
    "X-Identity-Signature": signIdentityContext({ employeeId, departmentId, departmentIds, name, timestamp, secret }),
  };
}

async function jsonRequest(baseUrl, pathname, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

test("可信身份交换生成HttpOnly会话，写操作校验CSRF且退出立即撤销", async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const exchange = await jsonRequest(app.baseUrl, "/api/v1/auth/session", {
    method: "POST",
    headers: gatewayHeaders(app.identityHmacSecret),
    body: {},
  });
  assert.equal(exchange.response.status, 201);
  assert.equal(exchange.payload.employee.employeeId, "E-SESSION");
  assert.equal(exchange.payload.authMode, "server-session");
  const setCookie = exchange.response.headers.get("set-cookie");
  assert.match(setCookie, /^ai_demand_session=[A-Za-z0-9_-]+;/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.doesNotMatch(setCookie, /; Secure/);
  const cookie = setCookie.split(";")[0];

  const me = await jsonRequest(app.baseUrl, "/api/v1/auth/me", { headers: { Cookie: cookie } });
  assert.equal(me.response.status, 200);
  assert.equal(me.payload.employee.departmentId, "D-ORG");
  assert.match(me.payload.csrfToken, /^[A-Za-z0-9_-]{40,100}$/);
  const secondTab = await jsonRequest(app.baseUrl, "/api/v1/auth/me", { headers: { Cookie: cookie } });
  assert.equal(secondTab.payload.csrfToken, me.payload.csrfToken);

  const services = await jsonRequest(app.baseUrl, "/api/v1/services", { headers: { Cookie: cookie } });
  assert.equal(services.response.status, 200);

  const noCsrf = await jsonRequest(app.baseUrl, "/api/v1/cases/drafts", {
    method: "POST",
    headers: { Cookie: cookie },
    body: { serviceCode: "CRM_ACCOUNT_CHANGE", fields: {} },
  });
  assert.equal(noCsrf.response.status, 403);
  assert.equal(noCsrf.payload.error.code, "CSRF_REQUIRED");

  const wrongCsrf = await jsonRequest(app.baseUrl, "/api/v1/cases/drafts", {
    method: "POST",
    headers: { Cookie: cookie, "X-CSRF-Token": "wrong-token" },
    body: { serviceCode: "CRM_ACCOUNT_CHANGE", fields: {} },
  });
  assert.equal(wrongCsrf.response.status, 403);
  assert.equal(wrongCsrf.payload.error.code, "INVALID_CSRF");

  const created = await jsonRequest(app.baseUrl, "/api/v1/cases/drafts", {
    method: "POST",
    headers: { Cookie: cookie, "X-CSRF-Token": me.payload.csrfToken },
    body: { serviceCode: "CRM_ACCOUNT_CHANGE", fields: {} },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.case.requester.employeeId, "E-SESSION");

  const sessionWins = await jsonRequest(app.baseUrl, `/api/v1/cases/${created.payload.case.globalRequestNo}`, {
    headers: { Cookie: cookie, "X-Employee-Id": "E-OTHER", "X-Department-Id": "D-OTHER" },
  });
  assert.equal(sessionWins.response.status, 200);
  assert.equal(sessionWins.payload.case.requester.employeeId, "E-SESSION");

  const toolCannotUseBrowserSession = await jsonRequest(app.baseUrl, "/api/v1/tools/search-service-catalog", {
    method: "POST",
    headers: { Cookie: cookie, "X-CSRF-Token": me.payload.csrfToken, "X-Tool-Key": "session-tool-key-long-enough" },
    body: { query: "CRM" },
  });
  assert.equal(toolCannotUseBrowserSession.response.status, 401);
  assert.equal(toolCannotUseBrowserSession.payload.error.code, "AUTH_REQUIRED");

  const logout = await jsonRequest(app.baseUrl, "/api/v1/auth/logout", {
    method: "POST",
    headers: { Cookie: cookie, "X-CSRF-Token": me.payload.csrfToken },
    body: {},
  });
  assert.equal(logout.response.status, 200);
  assert.match(logout.response.headers.get("set-cookie"), /Max-Age=0/);

  const revoked = await jsonRequest(app.baseUrl, "/api/v1/services", { headers: { Cookie: cookie } });
  assert.equal(revoked.response.status, 401);
  assert.equal(revoked.payload.error.code, "INVALID_SESSION");
  const actions = app.db.prepare("SELECT action FROM audit_events ORDER BY audit_id").all().map((row) => row.action);
  assert.ok(actions.includes("CREATE_AUTH_SESSION"));
  assert.ok(actions.includes("REVOKE_AUTH_SESSION"));
});

test("服务端会话按绝对有效期失效，生产Cookie带Secure且数据库不保存原始Token", () => {
  let now = 1_700_000_000_000;
  const db = openDatabase(":memory:", { seedDemo: false });
  const sessions = new SessionService({ db, ttlSeconds: 300, cookieSecure: true, now: () => now });
  try {
    const created = sessions.create({ employeeId: "E1", departmentId: "D1", departmentIds: ["D2", "D1"], name: "测试员工" });
    assert.deepEqual(created.employee.departmentIds, ["D1", "D2"]);
    assert.match(created.setCookie, /; Secure/);
    assert.match(created.setCookie, /^__Host-ai_demand_session=/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM auth_sessions WHERE session_id_hash = ?").get(created.token).count, 0);
    const req = { headers: { cookie: `__Host-ai_demand_session=${created.token}` } };
    assert.deepEqual(sessions.authenticate(req).employee.departmentIds, ["D1", "D2"]);
    now += 301_000;
    assert.throws(() => sessions.authenticate(req), (error) => error.code === "SESSION_EXPIRED");
    const limited = new SessionService({ db, ttlSeconds: 300, maxSessionsPerEmployee: 2, cookieSecure: true, now: () => now });
    const first = limited.create({ employeeId: "E2", departmentId: "D1", name: "多端员工" });
    const second = limited.create({ employeeId: "E2", departmentId: "D1", name: "多端员工" });
    const third = limited.create({ employeeId: "E2", departmentId: "D1", name: "多端员工" });
    assert.throws(() => limited.authenticate({ headers: { cookie: `__Host-ai_demand_session=${first.token}` } }), (error) => error.code === "INVALID_SESSION");
    assert.equal(limited.authenticate({ headers: { cookie: `__Host-ai_demand_session=${second.token}` } }).employee.employeeId, "E2");
    assert.equal(limited.authenticate({ headers: { cookie: `__Host-ai_demand_session=${third.token}` } }).employee.employeeId, "E2");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM auth_sessions WHERE employee_id = 'E2' AND revoked_at IS NULL").get().count, 2);
  } finally { db.close(); }
});

test("v2签名头绑定主部门、全部成员关系和姓名，拒绝降级与篡改", async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  app.db.prepare("UPDATE service_items SET audience_policy_json = ? WHERE service_code = 'ERP_MASTER_DATA_ISSUE'")
    .run(JSON.stringify({ visibility: "DEPARTMENTS", departmentIds: ["D-MATRIX"], includeDescendants: false, includeEmployeeIds: [], excludeEmployeeIds: [] }));
  app.db.prepare("UPDATE knowledge_items SET allowed_departments_json = ? WHERE knowledge_id = 'KB-DEMO-002'").run(JSON.stringify(["D-MATRIX"]));

  const headers = gatewayHeaders(app.identityHmacSecret, "E-MATRIX", "D-ORG", ["D-MATRIX", "D-ORG"]);
  const exchange = await jsonRequest(app.baseUrl, "/api/v1/auth/session", { method: "POST", headers, body: {} });
  assert.equal(exchange.response.status, 201);
  assert.deepEqual(exchange.payload.employee.departmentIds, ["D-ORG", "D-MATRIX"]);
  const toolContext = await jsonRequest(app.baseUrl, "/api/v1/tools/get-employee-context", { method: "POST", headers: { ...headers, "X-Tool-Key": "session-tool-key-long-enough" }, body: {} });
  assert.equal(toolContext.response.status, 200);
  assert.deepEqual(toolContext.payload.employee.departmentIds, ["D-ORG", "D-MATRIX"]);
  const cookie = exchange.response.headers.get("set-cookie").split(";")[0];
  const services = await jsonRequest(app.baseUrl, "/api/v1/services?query=ERP", { headers: { Cookie: cookie } });
  assert.equal(services.payload.services[0].serviceCode, "ERP_MASTER_DATA_ISSUE");
  const answer = await jsonRequest(app.baseUrl, "/api/v1/assistant/messages", { method: "POST", headers: { Cookie: cookie, "X-CSRF-Token": exchange.payload.csrfToken }, body: { message: "客户归属怎么改" } });
  assert.equal(answer.payload.type, "ANSWER");

  const downgraded = { ...headers };
  delete downgraded["X-Identity-Version"];
  const downgradeResponse = await jsonRequest(app.baseUrl, "/api/v1/auth/session", { method: "POST", headers: downgraded, body: {} });
  assert.equal(downgradeResponse.response.status, 401);
  assert.equal(downgradeResponse.payload.error.code, "INVALID_IDENTITY_CONTEXT");

  const tampered = { ...headers, "X-Department-Ids": "D-ORG,D-MATRIX,D-FIN" };
  const tamperedResponse = await jsonRequest(app.baseUrl, "/api/v1/auth/session", { method: "POST", headers: tampered, body: {} });
  assert.equal(tamperedResponse.response.status, 401);
  assert.equal(tamperedResponse.payload.error.code, "INVALID_IDENTITY_SIGNATURE");

  const renamed = { ...headers, "X-Employee-Name": encodeURIComponent("被篡改姓名") };
  const renamedResponse = await jsonRequest(app.baseUrl, "/api/v1/auth/session", { method: "POST", headers: renamed, body: {} });
  assert.equal(renamedResponse.response.status, 401);
  assert.equal(renamedResponse.payload.error.code, "INVALID_IDENTITY_SIGNATURE");
});
