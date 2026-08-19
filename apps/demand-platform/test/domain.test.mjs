import test from "node:test";
import assert from "node:assert/strict";
import { validateFields } from "../src/domain/schema-validation.mjs";
import { assertTransition } from "../src/domain/state-machine.mjs";
import { issueConfirmationToken, verifyConfirmationToken } from "../src/domain/confirmation-token.mjs";

test("动态字段校验返回缺失字段、格式错误并去除文本空格", () => {
  const schema = {
    fields: [
      { name: "name", label: "名称", type: "string", required: true, minLength: 3 },
      { name: "date", label: "日期", type: "date", required: true },
      { name: "type", label: "类型", type: "enum", required: true, options: [{ value: "A", label: "A" }] },
    ],
  };
  const result = validateFields(schema, { name: "  ab  ", date: "2026-02-30", extra: "x" });
  assert.equal(result.valid, false);
  assert.deepEqual(result.missingFields.map((item) => item.name), ["type"]);
  assert.ok(result.fieldErrors.some((item) => item.code === "MIN_LENGTH"));
  assert.ok(result.fieldErrors.some((item) => item.code === "DATE"));
  assert.ok(result.fieldErrors.some((item) => item.code === "UNKNOWN_FIELD"));
  assert.equal(result.normalizedFields.name, "ab");
});

test("状态机拒绝跳过确认直接从草稿进入已提交", () => {
  assert.throws(() => assertTransition("DRAFT", "SUBMITTED"), (error) => error.code === "INVALID_STATUS_TRANSITION");
  assert.doesNotThrow(() => assertTransition("WAITING_CONFIRMATION", "SUBMITTING"));
});

test("确认令牌绑定员工、需求和版本，并拒绝篡改及过期", () => {
  const secret = "test-confirmation-secret-at-least-long";
  const base = { globalRequestNo: "REQ-20260813-000001", draftVersion: 2, employeeId: "E1", ttlSeconds: 60, secret, now: 1_000_000 };
  const token = issueConfirmationToken(base);
  const payload = verifyConfirmationToken(token, { secret, globalRequestNo: base.globalRequestNo, draftVersion: 2, employeeId: "E1", now: 1_010_000 });
  assert.equal(payload.draftVersion, 2);
  assert.throws(() => verifyConfirmationToken(`${token}x`, { secret, globalRequestNo: base.globalRequestNo, draftVersion: 2, employeeId: "E1", now: 1_010_000 }), (error) => error.code === "INVALID_CONFIRMATION");
  assert.throws(() => verifyConfirmationToken(token, { secret, globalRequestNo: base.globalRequestNo, draftVersion: 2, employeeId: "E2", now: 1_010_000 }), (error) => error.code === "CONFIRMATION_MISMATCH");
  assert.throws(() => verifyConfirmationToken(token, { secret, globalRequestNo: base.globalRequestNo, draftVersion: 2, employeeId: "E1", now: 1_100_000 }), (error) => error.code === "CONFIRMATION_EXPIRED");
});
