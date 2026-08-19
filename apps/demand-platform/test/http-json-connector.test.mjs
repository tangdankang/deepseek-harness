import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createApplication } from "../src/server.mjs";
import { HttpJsonConnector, validateConnectorConfiguration } from "../src/connectors/http-json-connector.mjs";
import { verifyConnectorContract } from "../src/connectors/connector-contract.mjs";

function configuration(baseUrl, overrides = {}) {
  const connector = {
    type: "http-json",
    systemCode: "CRM",
    baseUrl,
    timeoutMs: 3000,
    maxResponseBytes: 65536,
    allowInsecureHttp: true,
    auth: { type: "bearer-env", envVar: "CRM_TEST_TOKEN" },
    createTicket: {
      path: "/tickets",
      method: "POST",
      idempotencyHeader: "Idempotency-Key",
      headers: { "X-Client-System": "AI_DEMAND_PLATFORM" },
      services: {
        CRM_ACCOUNT_CHANGE: {
          requestMapping: {
            global_request_no: "case.globalRequestNo",
            service_code: "case.serviceCode",
            ticket_type: { value: "ACCOUNT_CHANGE" },
            "requester.employee_id": "requester.employeeId",
            "payload.customer_no": "fields.customerCode",
            "payload.reason": "fields.reason",
          },
        },
      },
      responseMapping: { ticketNo: "data.ticket_no", rawStatus: "data.status", ticketUrl: "data.ticket_url" },
    },
    getTicket: {
      pathTemplate: "/tickets/{ticketNo}",
      method: "GET",
      headers: { "X-Client-System": "AI_DEMAND_PLATFORM" },
      responseMapping: { ticketNo: "data.ticket_no", rawStatus: "data.status", ticketUrl: "data.ticket_url" },
    },
    statusMapping: { OPEN: "SUBMITTED", WORKING: "IN_PROGRESS", RESOLVED: "RESOLVED", CLOSED: "CLOSED" },
    unknownStatus: "IN_PROGRESS",
    ...overrides,
  };
  return { version: 1, connectors: [connector] };
}

async function startDownstream() {
  const calls = [];
  const idempotency = new Map();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : null;
    const key = String(req.headers["idempotency-key"] ?? "");
    calls.push({ method: req.method, url: req.url, headers: req.headers, body, raw });
    if (req.method === "GET") {
      const ticketNo = decodeURIComponent(String(req.url).split("/").at(-1));
      const address = server.address();
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: { ticket_no: ticketNo, status: "WORKING", ticket_url: `http://127.0.0.1:${address.port}/tickets/${ticketNo}` } }));
    }
    const existing = idempotency.get(key);
    if (existing && existing !== raw) {
      res.writeHead(409, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "IDEMPOTENCY_CONFLICT" }));
    }
    idempotency.set(key, raw);
    const address = server.address();
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: { ticket_no: `CRM-${key.slice(-8)}`, status: "OPEN", ticket_url: `http://127.0.0.1:${address.port}/tickets/${key}` } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, calls, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

function requestFixture(idempotencyKey = "http-connector-contract-0001") {
  return {
    case: { globalRequestNo: "REQ-20260813-900001", serviceCode: "CRM_ACCOUNT_CHANGE" },
    service: { serviceCode: "CRM_ACCOUNT_CHANGE", targetSystem: "CRM" },
    fields: { customerCode: "C000123", reason: "区域职责调整" },
    requester: { employeeId: "E-CONNECTOR", departmentId: "D-ORG" },
    idempotencyKey,
  };
}

test("HTTP JSON连接器按映射调用下游并满足异步幂等契约", async (t) => {
  const downstream = await startDownstream();
  t.after(() => new Promise((resolve) => downstream.server.close(resolve)));
  const connector = new HttpJsonConnector(configuration(downstream.baseUrl).connectors[0], { env: { CRM_TEST_TOKEN: "connector-test-token" } });
  const validRequest = requestFixture();
  const report = await verifyConnectorContract(connector, {
    validRequest,
    invalidRequest: { ...validRequest, service: { targetSystem: "OTHER" } },
    conflictingRequest: { ...validRequest, fields: { ...validRequest.fields, reason: "相同幂等键的不同内容" } },
    rawStatuses: ["OPEN", "WORKING", "RESOLVED", "CLOSED", "UNKNOWN"],
  });
  assert.equal(report.systemCode, "CRM");
  assert.equal(report.idempotencyVerified, true);
  assert.equal(report.idempotencyConflictVerified, true);
  assert.equal(report.queryVerified, true);
  assert.equal(downstream.calls[0].headers.authorization, "Bearer connector-test-token");
  assert.equal(downstream.calls[0].headers["x-client-system"], "AI_DEMAND_PLATFORM");
  assert.equal(downstream.calls[0].body.payload.customer_no, "C000123");
  assert.equal(downstream.calls[0].body.requester.employee_id, "E-CONNECTOR");
  const queried = await connector.getTicket(report.sampleTicketNo);
  assert.equal(queried.ticketNo, report.sampleTicketNo);
  assert.equal(queried.unifiedStatus, "IN_PROGRESS");
});

test("配置校验拒绝生产明文HTTP、无鉴权、内嵌密钥和不安全请求头", () => {
  const base = configuration("https://crm-test.company.example");
  assert.equal(validateConnectorConfiguration(base, { productionMode: true }).valid, true);

  const httpProduction = configuration("http://127.0.0.1:9999");
  assert.throws(() => validateConnectorConfiguration(httpProduction, { productionMode: true }), (error) => error.code === "INVALID_CONNECTOR_CONFIGURATION");

  const noAuth = configuration("https://crm-test.company.example");
  noAuth.connectors[0].auth = { type: "none" };
  assert.throws(() => validateConnectorConfiguration(noAuth, { productionMode: true }), (error) => error.code === "INVALID_CONNECTOR_CONFIGURATION");

  const embeddedSecret = configuration("https://crm-test.company.example");
  embeddedSecret.connectors[0].auth.token = "must-not-be-here";
  assert.throws(() => validateConnectorConfiguration(embeddedSecret), (error) => error.code === "INVALID_CONNECTOR_CONFIGURATION");

  const unsafeHeader = configuration("https://crm-test.company.example");
  unsafeHeader.connectors[0].createTicket.headers.Host = "attacker.example";
  assert.throws(() => validateConnectorConfiguration(unsafeHeader), (error) => error.code === "INVALID_CONNECTOR_CONFIGURATION");
});

test("HTTP连接器将限流、未知结果超时、重定向和响应契约错误分开归类", async () => {
  const definition = configuration("https://crm-test.company.example").connectors[0];
  const options = (fetchImpl) => ({ env: { CRM_TEST_TOKEN: "connector-test-token" }, productionMode: true, fetchImpl });
  const fixture = requestFixture("http-error-classification-0001");

  const rateLimited = new HttpJsonConnector(definition, options(async () => new Response("{}", { status: 429 })));
  await assert.rejects(() => rateLimited.createTicket(fixture), (error) => error.code === "DOWNSTREAM_RATE_LIMITED" && error.status === 503);

  const timedOut = new HttpJsonConnector(definition, options(async () => { const error = new Error("timeout"); error.name = "TimeoutError"; throw error; }));
  await assert.rejects(() => timedOut.createTicket(fixture), (error) => error.code === "DOWNSTREAM_TIMEOUT_UNKNOWN_RESULT" && error.status === 503);

  const redirected = new HttpJsonConnector(definition, options(async () => new Response("", { status: 302, headers: { location: "https://redirect.example" } })));
  await assert.rejects(() => redirected.createTicket(fixture), (error) => error.code === "DOWNSTREAM_REDIRECT_REJECTED" && error.status === 422);

  const invalidJson = new HttpJsonConnector(definition, options(async () => new Response("not-json", { status: 200 })));
  await assert.rejects(() => invalidJson.createTicket(fixture), (error) => error.code === "DOWNSTREAM_CONTRACT_ERROR" && error.status === 422);

  const missingField = requestFixture("http-missing-field-0001");
  delete missingField.fields.customerCode;
  assert.equal(rateLimited.validate(missingField).errors.some((error) => error.code === "MISSING_MAPPED_FIELD"), true);
});

test("真实HTTP连接器可进入需求Outbox闭环且重复提交不二次调用下游", async (t) => {
  const downstream = await startDownstream();
  const app = createApplication({
    databasePath: ":memory:",
    confirmationSecret: "http-app-confirmation-secret-long-enough",
    webhookSecret: "http-app-webhook-secret-long-enough-different",
    connectorConfiguration: configuration(downstream.baseUrl),
    connectorEnv: { CRM_TEST_TOKEN: "connector-app-token" },
  });
  t.after(async () => {
    await app.close();
    await new Promise((resolve) => downstream.server.close(resolve));
  });
  const employee = { employeeId: "E-HTTP", departmentId: "D-ORG", name: "HTTP联调员工" };
  const fields = {
    customerCode: "C000123",
    currentOwnerEmployeeId: "E10009",
    newOwnerEmployeeId: "E20002",
    reason: "区域职责发生调整",
    effectiveDate: "2026-08-20",
  };
  const draft = app.services.demands.createDraft(employee, { serviceCode: "CRM_ACCOUNT_CHANGE", fields });
  const confirmation = app.services.demands.prepareConfirmation(employee, draft.case.globalRequestNo);
  const body = {
    draftVersion: confirmation.case.version,
    confirmationToken: confirmation.confirmationToken,
    idempotencyKey: `${confirmation.case.globalRequestNo}-v${confirmation.case.version}-submit`,
  };
  const submitted = await app.services.demands.submit(employee, confirmation.case.globalRequestNo, body);
  assert.equal(submitted.case.status, "SUBMITTED");
  assert.equal(submitted.externalTickets[0].systemCode, "CRM");
  assert.equal(downstream.calls.length, 1);
  const replay = await app.services.demands.submit(employee, confirmation.case.globalRequestNo, body);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(downstream.calls.length, 1);
  const reconciled = await app.services.demands.reconcileExternalTickets({ systemCode: "CRM", limit: 10 });
  assert.equal(reconciled.updated, 1);
  assert.equal(reconciled.failed, 0);
  assert.equal(app.services.demands.getOwned(employee, confirmation.case.globalRequestNo).status, "IN_PROGRESS");
  assert.equal(downstream.calls.filter((call) => call.method === "GET").length, 1);
  const unchanged = await app.services.demands.reconcileExternalTickets({ systemCode: "CRM", limit: 10 });
  assert.equal(unchanged.unchanged, 1);
});

test("生产应用拒绝在没有真实连接器配置时隐式启用模拟器", () => {
  assert.throws(() => createApplication({
    productionMode: true,
    databasePath: "production-connector-gate.db",
    confirmationSecret: "c".repeat(40),
    webhookSecret: "w".repeat(40),
    toolApiKey: "t".repeat(40),
    adminApiKey: "a".repeat(40),
    identityHmacSecret: "i".repeat(40),
    analyticsHashSecret: "h".repeat(40),
  }), (error) => error.code === "INSECURE_PRODUCTION_CONFIGURATION");
});
