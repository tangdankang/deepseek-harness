import test from "node:test";
import assert from "node:assert/strict";
import { MockConnector } from "../src/connectors/mock-connector.mjs";
import { verifyConnectorContract } from "../src/connectors/connector-contract.mjs";

for (const systemCode of ["CRM", "OA", "ERP", "TB"]) {
  test(`${systemCode}模拟连接器满足统一契约和幂等要求`, async () => {
    const connector = new MockConnector(systemCode);
    const validRequest = {
      case: { globalRequestNo: `REQ-20260813-${systemCode.padEnd(6, "0")}` },
      service: { targetSystem: systemCode },
      fields: { description: "连接器契约测试" },
      requester: { employeeId: "E-CONTRACT" },
      idempotencyKey: `contract-${systemCode}-000001`,
    };
    const report = await verifyConnectorContract(connector, {
      validRequest,
      invalidRequest: { ...validRequest, service: { targetSystem: "OTHER" } },
      conflictingRequest: { ...validRequest, fields: { description: "同一幂等键的不同内容" } },
    });
    assert.equal(report.systemCode, systemCode);
    assert.equal(report.idempotencyVerified, true);
    assert.equal(report.idempotencyConflictVerified, true);
  });
}
