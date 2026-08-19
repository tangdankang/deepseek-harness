import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { connectorAcceptanceMarkdown, runConnectorAcceptance, validateConnectorAcceptanceFixture } from "../src/conformance/connector-acceptance.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const configuration = JSON.parse(fs.readFileSync(path.join(projectRoot, "deploy", "connectors.production.example.json"), "utf8"));
const fixture = JSON.parse(fs.readFileSync(path.join(projectRoot, "config", "connector-acceptance-fixture.example.json"), "utf8"));

test("连接器验收夹具绑定目标系统、服务映射和幂等冲突", () => {
  const result = validateConnectorAcceptanceFixture(fixture, configuration);
  assert.equal(result.valid, true);
  assert.equal(result.systemCode, "CRM");
  assert.match(result.fixtureHash, /^[A-F0-9]{64}$/);

  const bad = structuredClone(fixture);
  bad.conflictingRequest.idempotencyKey = "different-idempotency-key";
  assert.throws(() => validateConnectorAcceptanceFixture(bad, configuration), (error) => error.code === "INVALID_CONNECTOR_ACCEPTANCE_FIXTURE");
});

test("未授权写入时只验证配置并明确返回NOT_READY", async () => {
  const report = await runConnectorAcceptance({ configuration, fixture, env: {}, allowWrite: false, productionMode: true });
  assert.equal(report.outcome, "NOT_READY");
  assert.equal(report.mode, "CONFIGURATION_ONLY");
  assert.equal(report.summary.passed, 2);
  assert.equal(report.summary.skipped, 7);
  assert.equal(report.security.explicitWriteAuthorization, false);
});

test("写入验收覆盖建单、重复提交、冲突、查单和状态映射且报告脱敏", async () => {
  const tickets = new Map();
  const calls = [];
  const secret = "connector-acceptance-secret-must-not-leak";
  const fetchImpl = async (endpoint, init) => {
    const url = new URL(endpoint);
    calls.push({ method: init.method, authorization: init.headers.authorization });
    assert.equal(init.headers.authorization, `Bearer ${secret}`);
    if (init.method === "POST") {
      const key = init.headers["Idempotency-Key"];
      const existing = tickets.get(key);
      if (existing && existing.body !== init.body) return new Response(JSON.stringify({ error: "conflict" }), { status: 409, headers: { "content-type": "application/json" } });
      if (existing) return new Response(JSON.stringify(existing.response), { status: 200, headers: { "content-type": "application/json" } });
      const response = { data: { ticket_no: "CRM-TEST-0001", status: "OPEN", ticket_url: "https://crm-test.company.example/tickets/CRM-TEST-0001" } };
      tickets.set(key, { body: init.body, response });
      return new Response(JSON.stringify(response), { status: 201, headers: { "content-type": "application/json" } });
    }
    assert.match(url.pathname, /CRM-TEST-0001$/);
    return new Response(JSON.stringify({ data: { ticket_no: "CRM-TEST-0001", status: "WORKING", ticket_url: "https://crm-test.company.example/tickets/CRM-TEST-0001" } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const report = await runConnectorAcceptance({
    configuration,
    fixture,
    env: { CRM_CONNECTOR_TOKEN: secret },
    allowWrite: true,
    productionMode: true,
    fetchImpl,
  });
  assert.equal(report.outcome, "PASS");
  assert.equal(report.summary.total, 9);
  assert.equal(report.summary.passed, 9);
  assert.equal(report.summary.failed, 0);
  assert.equal(calls.length, 4);
  const serialized = JSON.stringify(report);
  for (const sensitive of [secret, "CRM-TEST-0001", fixture.validRequest.requester.employeeId, fixture.validRequest.idempotencyKey]) {
    assert.equal(serialized.includes(sensitive), false);
  }
  assert.match(connectorAcceptanceMarkdown(report), /结果：\*\*PASS\*\*/);
});
