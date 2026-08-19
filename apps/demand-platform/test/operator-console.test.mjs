import assert from "node:assert/strict";
import test from "node:test";
import { createApplication } from "../src/server.mjs";
import { OperatorRole, signOperatorContext } from "../src/domain/operator-signature.mjs";

const operatorHmacSecret = "operator-gateway-signing-secret-long-enough-v06";
const adminApiKey = "operator-console-admin-key-long-enough-v06";

async function startApp(options = {}) {
  const app = createApplication({
    databasePath: ":memory:",
    confirmationSecret: "operator-console-confirmation-secret-v06",
    webhookSecret: "operator-console-webhook-secret-v06-different",
    adminApiKey,
    operatorHmacSecret,
    operatorBootstrapEnabled: true,
    ...options,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  return { ...app, baseUrl: `http://127.0.0.1:${app.server.address().port}` };
}

function operatorHeaders({ operatorId = "OPS-READER", name = "运营只读", roles = [OperatorRole.OPS_VIEWER], secret = operatorHmacSecret } = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    "X-Operator-Id": operatorId,
    "X-Operator-Name": encodeURIComponent(name),
    "X-Operator-Roles": roles.join(","),
    "X-Operator-Timestamp": String(timestamp),
    "X-Operator-Signature": signOperatorContext({ operatorId, name, roles, timestamp, secret }),
  };
}

async function request(baseUrl, pathname, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

async function signedLogin(app, context) {
  return request(app.baseUrl, "/api/v1/operator/auth/session", { method: "POST", headers: operatorHeaders(context), body: {} });
}

test("运营身份网关签名生成独立HttpOnly会话，权限和CSRF均在服务端执行", async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const viewerLogin = await signedLogin(app, { operatorId: "OPS-VIEWER", roles: [OperatorRole.OPS_VIEWER] });
  assert.equal(viewerLogin.response.status, 201);
  assert.equal(viewerLogin.payload.operator.operatorId, "OPS-VIEWER");
  assert.ok(viewerLogin.payload.operator.permissions.includes("VIEW_OVERVIEW"));
  assert.ok(!viewerLogin.payload.operator.permissions.includes("MANAGE_SESSIONS"));
  const viewerCookie = viewerLogin.response.headers.get("set-cookie").split(";")[0];
  assert.match(viewerLogin.response.headers.get("set-cookie"), /HttpOnly/);
  assert.match(viewerLogin.response.headers.get("set-cookie"), /SameSite=Strict/);

  const me = await request(app.baseUrl, "/api/v1/operator/auth/me", { headers: { Cookie: viewerCookie } });
  assert.equal(me.response.status, 200);
  assert.equal(me.payload.operator.roles[0], OperatorRole.OPS_VIEWER);
  const overview = await request(app.baseUrl, "/api/v1/admin/overview", { headers: { Cookie: viewerCookie } });
  assert.equal(overview.response.status, 200);
  assert.deepEqual(overview.payload.connectors.sort(), ["CRM", "ERP", "OA", "TB"]);
  const cases = await request(app.baseUrl, "/api/v1/admin/cases", { headers: { Cookie: viewerCookie } });
  assert.equal(cases.response.status, 200);
  const audit = await request(app.baseUrl, "/api/v1/admin/audit-events?actorType=OPERATOR", { headers: { Cookie: viewerCookie } });
  assert.equal(audit.response.status, 200);

  const forbidden = await request(app.baseUrl, "/api/v1/admin/auth-sessions/revoke", {
    method: "POST",
    headers: { Cookie: viewerCookie, "X-CSRF-Token": me.payload.csrfToken },
    body: { employeeId: "E1", reason: "SECURITY_EVENT" },
  });
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.payload.error.code, "OPERATOR_PERMISSION_DENIED");

  const tamperedRoles = operatorHeaders({ operatorId: "OPS-TAMPER", roles: [OperatorRole.OPS_VIEWER] });
  tamperedRoles["X-Operator-Roles"] = OperatorRole.PLATFORM_ADMIN;
  const tampered = await request(app.baseUrl, "/api/v1/operator/auth/session", { method: "POST", headers: tamperedRoles, body: {} });
  assert.equal(tampered.response.status, 401);
  assert.equal(tampered.payload.error.code, "INVALID_OPERATOR_SIGNATURE");
});

test("平台管理员可管理人工队列、集成和员工会话，写操作必须CSRF且注销立即失效", async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const employee = { employeeId: "E-REVOKE", departmentId: "D-ORG", name: "待撤销员工" };
  app.services.sessions.create(employee);
  app.services.handoffs.create(employee, {
    employeeConfirmed: true,
    reasonCode: "USER_REQUEST",
    queueCode: "ORG_SERVICE_DESK",
    summary: "需要人工协助处理权限申请",
    originalMessage: "请人工处理权限申请",
    idempotencyKey: "operator-console-handoff-0001",
  });

  const login = await signedLogin(app, { operatorId: "OPS-ADMIN", name: "平台管理员", roles: [OperatorRole.PLATFORM_ADMIN] });
  const cookie = login.response.headers.get("set-cookie").split(";")[0];
  const csrf = login.payload.csrfToken;

  const noCsrf = await request(app.baseUrl, "/api/v1/admin/auth-sessions/revoke", {
    method: "POST", headers: { Cookie: cookie }, body: { employeeId: employee.employeeId, reason: "SECURITY_EVENT" },
  });
  assert.equal(noCsrf.response.status, 403);
  assert.equal(noCsrf.payload.error.code, "CSRF_REQUIRED");

  const sessionList = await request(app.baseUrl, "/api/v1/admin/auth-sessions", { headers: { Cookie: cookie } });
  assert.equal(sessionList.response.status, 200);
  assert.equal(sessionList.payload.sessions[0].employeeId, employee.employeeId);
  assert.equal(JSON.stringify(sessionList.payload).includes("csrf"), false);

  const handoffs = await request(app.baseUrl, "/api/v1/admin/handoffs?status=OPEN", { headers: { Cookie: cookie } });
  assert.equal(handoffs.payload.handoffs.length, 1);
  const handoffNo = handoffs.payload.handoffs[0].handoffNo;
  const assigned = await request(app.baseUrl, `/api/v1/admin/handoffs/${handoffNo}`, {
    method: "PATCH", headers: { Cookie: cookie, "X-CSRF-Token": csrf }, body: { status: "ASSIGNED", assignedTo: "OPS-ADMIN" },
  });
  assert.equal(assigned.response.status, 200);
  assert.equal(assigned.payload.handoff.status, "ASSIGNED");

  const revoked = await request(app.baseUrl, "/api/v1/admin/auth-sessions/revoke", {
    method: "POST", headers: { Cookie: cookie, "X-CSRF-Token": csrf }, body: { employeeId: employee.employeeId, reason: "SECURITY_EVENT" },
  });
  assert.equal(revoked.response.status, 200);
  assert.equal(revoked.payload.revokedSessions, 1);

  const worker = await request(app.baseUrl, "/api/v1/admin/integration-tasks/run", {
    method: "POST", headers: { Cookie: cookie, "X-CSRF-Token": csrf }, body: { limit: 5 },
  });
  assert.equal(worker.response.status, 200);

  const logout = await request(app.baseUrl, "/api/v1/operator/auth/logout", {
    method: "POST", headers: { Cookie: cookie, "X-CSRF-Token": csrf }, body: {},
  });
  assert.equal(logout.response.status, 200);
  assert.match(logout.response.headers.get("set-cookie"), /Max-Age=0/);
  const afterLogout = await request(app.baseUrl, "/api/v1/admin/overview", { headers: { Cookie: cookie } });
  assert.equal(afterLogout.response.status, 401);
  assert.equal(afterLogout.payload.error.code, "INVALID_OPERATOR_SESSION");
});

test("开发引导只在显式启用时接受Admin Key且不将原始密钥落库", async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const wrong = await request(app.baseUrl, "/api/v1/operator/auth/session", { method: "POST", body: { adminKey: "wrong", operatorId: "LOCAL-OPS" } });
  assert.equal(wrong.response.status, 401);
  const login = await request(app.baseUrl, "/api/v1/operator/auth/session", { method: "POST", body: { adminKey: adminApiKey, operatorId: "LOCAL-OPS", operatorName: "本地运营" } });
  assert.equal(login.response.status, 201);
  assert.equal(login.payload.identitySource, "development-admin-key-bootstrap");
  const rows = app.db.prepare("SELECT * FROM operator_sessions").all();
  assert.equal(rows.length, 1);
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(adminApiKey));
  const audits = app.db.prepare("SELECT details_json FROM audit_events").all();
  assert.doesNotMatch(JSON.stringify(audits), new RegExp(adminApiKey));
});
