import assert from "node:assert/strict";
import test from "node:test";
import { createApplication } from "../src/server.mjs";
import { signWebhook } from "../src/domain/confirmation-token.mjs";
import { resolveInboundWebhookSecrets } from "../src/security/inbound-webhook-auth.mjs";

const crmSecret = "crm-inbound-webhook-secret-long-enough";
const oaSecret = "oa-inbound-webhook-secret-long-enough-different";

async function post(baseUrl, systemCode, document, secret) {
  const raw = JSON.stringify(document);
  const response = await fetch(`${baseUrl}/api/v1/webhooks/${systemCode}/status`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Webhook-Signature": signWebhook(raw, secret) },
    body: raw,
  });
  return { response, payload: await response.json() };
}

test("每个业务系统只接受自己的入站Webhook密钥", async (t) => {
  const app = createApplication({
    databasePath: ":memory:",
    confirmationSecret: "business-webhook-confirmation-secret-long-enough",
    webhookSecret: "business-webhook-development-fallback-long-enough",
    webhookSecrets: { CRM: crmSecret, OA: oaSecret },
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const document = { eventId: "EVT-KEY-001", ticketNo: "T-NOT-FOUND", rawStatus: "OPEN", occurredAt: new Date().toISOString(), sequence: 1 };

  const crmAccepted = await post(baseUrl, "CRM", document, crmSecret);
  assert.equal(crmAccepted.response.status, 404);
  assert.equal(crmAccepted.payload.error.code, "EXTERNAL_TICKET_NOT_FOUND");
  const crossSystem = await post(baseUrl, "OA", document, crmSecret);
  assert.equal(crossSystem.response.status, 401);
  assert.equal(crossSystem.payload.error.code, "INVALID_WEBHOOK_SIGNATURE");
  const oaAccepted = await post(baseUrl, "OA", document, oaSecret);
  assert.equal(oaAccepted.response.status, 404);
  assert.equal(oaAccepted.payload.error.code, "EXTERNAL_TICKET_NOT_FOUND");
  const unknown = await post(baseUrl, "UNKNOWN", document, crmSecret);
  assert.equal(unknown.response.status, 404);
  assert.equal(unknown.payload.error.code, "WEBHOOK_SYSTEM_NOT_CONFIGURED");
});

test("生产入站Webhook密钥必须齐全、按系统唯一且不与平台密钥复用", () => {
  const resolved = resolveInboundWebhookSecrets({
    systemCodes: ["CRM", "OA"],
    productionMode: true,
    injectedSecrets: { CRM: "c".repeat(40), OA: "o".repeat(40) },
    reservedSecrets: ["p".repeat(40)],
  });
  assert.deepEqual([...resolved.keys()], ["CRM", "OA"]);
  assert.throws(() => resolveInboundWebhookSecrets({ systemCodes: ["CRM", "OA"], productionMode: true, injectedSecrets: { CRM: "c".repeat(40) } }), (error) => error.code === "INSECURE_PRODUCTION_CONFIGURATION" && error.details?.systemCode === "OA");
  assert.throws(() => resolveInboundWebhookSecrets({ systemCodes: ["CRM", "OA"], productionMode: true, injectedSecrets: { CRM: "s".repeat(40), OA: "s".repeat(40) } }), (error) => error.code === "INSECURE_PRODUCTION_CONFIGURATION" && /不得复用/.test(error.message));
  assert.throws(() => resolveInboundWebhookSecrets({ systemCodes: ["CRM"], productionMode: true, injectedSecrets: { CRM: "p".repeat(40) }, reservedSecrets: ["p".repeat(40)] }), (error) => error.code === "INSECURE_PRODUCTION_CONFIGURATION" && /其他用途/.test(error.message));
});

test("密钥环境变量映射只保存变量名并从运行环境解析实际密钥", () => {
  const resolved = resolveInboundWebhookSecrets({
    systemCodes: ["CRM"],
    productionMode: true,
    secretEnvBySystem: { CRM: "CRM_WEBHOOK_SECRET" },
    env: { CRM_WEBHOOK_SECRET: "e".repeat(40) },
  });
  assert.equal(resolved.get("CRM"), "e".repeat(40));
  assert.throws(() => resolveInboundWebhookSecrets({ systemCodes: ["CRM"], productionMode: true, secretEnvBySystem: { CRM: "bad-name" }, env: {} }), (error) => error.code === "INVALID_WEBHOOK_CONFIGURATION");
});
