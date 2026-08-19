import test from "node:test";
import assert from "node:assert/strict";
import { resolveRuntimeConfig } from "../src/config.mjs";
import { signIdentityContext, verifyIdentityContext } from "../src/domain/identity-signature.mjs";
import { createApplication } from "../src/server.mjs";

test("生产启动门禁拒绝默认/复用密钥和内存数据库", () => {
  assert.throws(() => resolveRuntimeConfig({ productionMode: true, databasePath: "prod.db" }, {}, "."), (error) => error.code === "INSECURE_PRODUCTION_CONFIGURATION");
  const common = "x".repeat(40);
  assert.throws(() => resolveRuntimeConfig({
    productionMode: true,
    confirmationSecret: common,
    webhookSecret: common,
    toolApiKey: "t".repeat(40),
    identityHmacSecret: "i".repeat(40),
    identityEventSecret: "v".repeat(40),
    databasePath: "prod.db",
  }, {}, "."), (error) => error.code === "INSECURE_PRODUCTION_CONFIGURATION");
  assert.throws(() => resolveRuntimeConfig({
    productionMode: true,
    confirmationSecret: "c".repeat(40),
    webhookSecret: "w".repeat(40),
    toolApiKey: "t".repeat(40),
    identityHmacSecret: "i".repeat(40),
    identityEventSecret: "v".repeat(40),
    databasePath: ":memory:",
  }, {}, "."), (error) => error.code === "INSECURE_PRODUCTION_CONFIGURATION");

  const accepted = resolveRuntimeConfig({
    productionMode: true,
    confirmationSecret: "c".repeat(40),
    webhookSecret: "w".repeat(40),
    toolApiKey: "t".repeat(40),
    adminApiKey: "a".repeat(40),
    metricsApiKey: "m".repeat(40),
    identityHmacSecret: "i".repeat(40),
    identityEventSecret: "v".repeat(40),
    operatorHmacSecret: "o".repeat(40),
    analyticsHashSecret: "h".repeat(40),
    auditChainSecret: "u".repeat(40),
    databasePath: "prod.db",
  }, {}, ".");
  assert.equal(accepted.productionMode, true);
  assert.equal(accepted.sessionCookieSecure, true);
  const missingMetrics = { ...accepted, metricsApiKey: "" };
  assert.throws(() => resolveRuntimeConfig(missingMetrics, {}, "."), (error) => error.code === "INSECURE_PRODUCTION_CONFIGURATION" && error.details?.name === "METRICS_API_KEY");
  assert.throws(() => resolveRuntimeConfig({ ...accepted, identityEventSecret: "" }, {}, "."), (error) => error.code === "INSECURE_PRODUCTION_CONFIGURATION" && error.details?.name === "IDENTITY_EVENT_SECRET");
  assert.throws(() => resolveRuntimeConfig({ ...accepted, metricsApiKey: accepted.adminApiKey }, {}, "."), (error) => error.code === "INSECURE_PRODUCTION_CONFIGURATION" && /不得复用/.test(error.message));
  assert.throws(() => resolveRuntimeConfig({ ...accepted, identityEventSecret: accepted.identityHmacSecret }, {}, "."), (error) => error.code === "INSECURE_PRODUCTION_CONFIGURATION" && /不得复用/.test(error.message));
  assert.throws(() => resolveRuntimeConfig({ sessionTtlSeconds: 299 }, {}, "."), (error) => error.code === "INVALID_CONFIGURATION");
  assert.throws(() => resolveRuntimeConfig({ sessionMaxPerEmployee: 21 }, {}, "."), (error) => error.code === "INVALID_CONFIGURATION");
  assert.throws(() => resolveRuntimeConfig({ operatorSessionTtlSeconds: 299 }, {}, "."), (error) => error.code === "INVALID_CONFIGURATION");
  assert.throws(() => resolveRuntimeConfig({ operatorSessionMaxPerOperator: 11 }, {}, "."), (error) => error.code === "INVALID_CONFIGURATION");
  assert.throws(() => resolveRuntimeConfig({ toolInvocationRetentionDays: 6 }, {}, "."), (error) => error.code === "INVALID_CONFIGURATION");
  assert.throws(() => resolveRuntimeConfig({ identityExchangeMode: "oidc" }, {}, "."), (error) => error.code === "INVALID_CONFIGURATION");
  assert.throws(() => resolveRuntimeConfig({ identityEventSource: "bad source" }, {}, "."), (error) => error.code === "INVALID_CONFIGURATION");
  assert.throws(() => resolveRuntimeConfig({ identityEventMaxAgeSeconds: 299 }, {}, "."), (error) => error.code === "INVALID_CONFIGURATION");
  assert.throws(() => resolveRuntimeConfig({ businessWebhookMaxAgeSeconds: 299 }, {}, "."), (error) => error.code === "INVALID_CONFIGURATION");
  assert.throws(() => resolveRuntimeConfig({ inboundWebhookSecretEnvs: "not-json" }, {}, "."), (error) => error.code === "INVALID_CONFIGURATION");
  assert.deepEqual(resolveRuntimeConfig({}, { INBOUND_WEBHOOK_SECRET_ENVS: '{"CRM":"CRM_WEBHOOK_SECRET"}' }, ".").inboundWebhookSecretEnvs, { CRM: "CRM_WEBHOOK_SECRET" });
  assert.throws(() => resolveRuntimeConfig({ identityExchangeMode: "ticket", identityExchangeSecret: "short" }, {}, "."), (error) => error.code === "INVALID_CONFIGURATION");
  const ticketEnabled = resolveRuntimeConfig({
    identityExchangeMode: "both",
    identityExchangeSecret: "e".repeat(40),
    identityExchangeIssuer: "corp-iam",
    identityExchangeAudience: "demand-platform",
    identityExchangeTtlSeconds: 60,
  }, {}, ".");
  assert.equal(ticketEnabled.identityExchangeMode, "both");
  assert.equal(ticketEnabled.identityExchangeTtlSeconds, 60);
  assert.throws(() => resolveRuntimeConfig({
    productionMode: true,
    confirmationSecret: "c".repeat(40),
    webhookSecret: "w".repeat(40),
    toolApiKey: "t".repeat(40),
    adminApiKey: "a".repeat(40),
    metricsApiKey: "m".repeat(40),
    identityHmacSecret: "i".repeat(40),
    identityEventSecret: "v".repeat(40),
    operatorHmacSecret: "o".repeat(40),
    analyticsHashSecret: "h".repeat(40),
    auditChainSecret: "u".repeat(40),
    databasePath: "prod.db",
    sessionCookieSecure: false,
  }, {}, "."), (error) => error.code === "INSECURE_PRODUCTION_CONFIGURATION");
  assert.throws(() => resolveRuntimeConfig({
    productionMode: true,
    confirmationSecret: "c".repeat(40),
    webhookSecret: "w".repeat(40),
    toolApiKey: "t".repeat(40),
    adminApiKey: "a".repeat(40),
    metricsApiKey: "m".repeat(40),
    identityHmacSecret: "i".repeat(40),
    identityEventSecret: "v".repeat(40),
    operatorHmacSecret: "o".repeat(40),
    analyticsHashSecret: "h".repeat(40),
    databasePath: "prod.db",
    operatorBootstrapEnabled: true,
  }, {}, "."), (error) => error.code === "INSECURE_PRODUCTION_CONFIGURATION");
  const productionWithTicket = resolveRuntimeConfig({
    productionMode: true,
    confirmationSecret: "c".repeat(40),
    webhookSecret: "w".repeat(40),
    toolApiKey: "t".repeat(40),
    adminApiKey: "a".repeat(40),
    metricsApiKey: "m".repeat(40),
    identityHmacSecret: "i".repeat(40),
    identityEventSecret: "v".repeat(40),
    operatorHmacSecret: "o".repeat(40),
    identityExchangeMode: "both",
    identityExchangeSecret: "e".repeat(40),
    analyticsHashSecret: "h".repeat(40),
    auditChainSecret: "u".repeat(40),
    databasePath: "prod.db",
  }, {}, ".");
  assert.equal(productionWithTicket.identityExchangeMode, "both");
  assert.throws(() => resolveRuntimeConfig({
    productionMode: true,
    confirmationSecret: "c".repeat(40),
    webhookSecret: "w".repeat(40),
    toolApiKey: "t".repeat(40),
    adminApiKey: "a".repeat(40),
    identityHmacSecret: "i".repeat(40),
    identityEventSecret: "v".repeat(40),
    operatorHmacSecret: "o".repeat(40),
    identityExchangeMode: "both",
    identityExchangeSecret: "i".repeat(40),
    analyticsHashSecret: "h".repeat(40),
    databasePath: "prod.db",
  }, {}, "."), (error) => error.code === "INSECURE_PRODUCTION_CONFIGURATION");
});

test("生产环境强制开启平台限流并校验各范围阈值", () => {
  assert.throws(() => resolveRuntimeConfig({ rateLimitWindowSeconds: 0 }, {}, "."), (error) => error.code === "INVALID_CONFIGURATION");
  assert.throws(() => resolveRuntimeConfig({ toolRateLimit: 0 }, {}, "."), (error) => error.code === "INVALID_CONFIGURATION");
  assert.throws(() => resolveRuntimeConfig({ rateLimitMaxEntries: 999 }, {}, "."), (error) => error.code === "INVALID_CONFIGURATION");
  const production = {
    productionMode: true,
    databasePath: "production.db",
    connectorConfigPath: "connectors.json",
    confirmationSecret: "c".repeat(40),
    webhookSecret: "w".repeat(40),
    toolApiKey: "t".repeat(40),
    adminApiKey: "a".repeat(40),
    metricsApiKey: "m".repeat(40),
    identityHmacSecret: "i".repeat(40),
    identityEventSecret: "v".repeat(40),
    operatorHmacSecret: "o".repeat(40),
    analyticsHashSecret: "h".repeat(40),
    auditChainSecret: "u".repeat(40),
    sessionCookieSecure: true,
    operatorBootstrapEnabled: false,
    rateLimitEnabled: false,
  };
  assert.throws(() => resolveRuntimeConfig(production, {}, "."), (error) => error.code === "INSECURE_PRODUCTION_CONFIGURATION" && /限流/.test(error.message));
});

test("当前版本明确拒绝把SQLite运行时声明为生产高可用", () => {
  const pilot = resolveRuntimeConfig({ runtimeProfile: "PILOT_SINGLE_NODE_SQLITE" }, {}, ".");
  assert.equal(pilot.runtimeProfile, "PILOT_SINGLE_NODE_SQLITE");
  assert.throws(() => resolveRuntimeConfig({ runtimeProfile: "PRODUCTION_HIGH_AVAILABILITY" }, {}, "."), (error) => error.code === "UNSUPPORTED_HIGH_AVAILABILITY_RUNTIME");
  assert.throws(() => resolveRuntimeConfig({ runtimeProfile: "unknown" }, {}, "."), (error) => error.code === "INVALID_CONFIGURATION");
});

test("员工身份签名绑定员工、部门和时间窗口", () => {
  const secret = "identity-test-secret-that-is-long-enough";
  const timestamp = 1_700_000_000;
  const signature = signIdentityContext({ employeeId: "E1", departmentId: "D1", timestamp, secret });
  assert.equal(verifyIdentityContext({ employeeId: "E1", departmentId: "D1", timestamp, signature, secret, now: (timestamp + 10) * 1000 }), true);
  assert.throws(() => verifyIdentityContext({ employeeId: "E2", departmentId: "D1", timestamp, signature, secret, now: (timestamp + 10) * 1000 }), (error) => error.code === "INVALID_IDENTITY_SIGNATURE");
  assert.throws(() => verifyIdentityContext({ employeeId: "E1", departmentId: "D1", timestamp, signature, secret, now: (timestamp + 301) * 1000 }), (error) => error.code === "IDENTITY_SIGNATURE_EXPIRED");
});

test("配置身份签名后，接口拒绝伪造请求头", async (t) => {
  const identityHmacSecret = "identity-app-test-secret-that-is-long-enough";
  const app = createApplication({
    databasePath: ":memory:",
    confirmationSecret: "confirmation-app-test-secret-long-enough",
    webhookSecret: "webhook-app-test-secret-that-is-long-enough",
    identityHmacSecret,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.db.close();
  });
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const unsigned = await fetch(`${baseUrl}/api/v1/services`, { headers: { "X-Employee-Id": "E1", "X-Department-Id": "D1" } });
  assert.equal(unsigned.status, 401);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signIdentityContext({ employeeId: "E1", departmentId: "D1", timestamp, secret: identityHmacSecret });
  const signed = await fetch(`${baseUrl}/api/v1/services`, { headers: {
    "X-Employee-Id": "E1",
    "X-Department-Id": "D1",
    "X-Identity-Timestamp": String(timestamp),
    "X-Identity-Signature": signature,
  } });
  assert.equal(signed.status, 200);
});
