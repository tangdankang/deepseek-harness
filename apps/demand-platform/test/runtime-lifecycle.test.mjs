import test from "node:test";
import assert from "node:assert/strict";
import { createApplication } from "../src/server.mjs";
import { resolveRuntimeConfig } from "../src/config.mjs";

test("存活与就绪探针不需要员工身份，并返回数据库和任务状态", async () => {
  const app = createApplication({
    databasePath: ":memory:",
    confirmationSecret: "runtime-confirmation-secret-long-enough",
    webhookSecret: "runtime-webhook-secret-is-long-enough",
    requestTimeoutMs: 20000,
    headersTimeoutMs: 10000,
    keepAliveTimeoutMs: 2000,
    gracefulShutdownMs: 2000,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const live = await fetch(`${baseUrl}/health/live`).then((response) => response.json());
  const ready = await fetch(`${baseUrl}/health/ready`).then((response) => response.json());
  assert.equal(live.process, "alive");
  assert.equal(ready.readiness, "ready");
  assert.match(ready.instanceId, /^[0-9a-f-]{36}$/i);
  assert.equal(ready.runtimeProfile, "PILOT_SINGLE_NODE_SQLITE");
  assert.equal(ready.deploymentModel, "SINGLE_NODE_PILOT");
  assert.equal(ready.storageBackend, "SQLITE");
  assert.deepEqual(ready.runtimeCapabilities, { sharedSessionState: false, distributedRateLimit: false, sharedIntegrationCoordination: false });
  assert.equal(ready.database, "ok");
  assert.deepEqual(ready.integrationTasks, { pending: 0, dead: 0 });
  assert.equal(ready.rateLimiting.enabled, true);
  assert.equal(ready.rateLimiting.activeSubjects, 0);
  assert.equal(ready.rateLimiting.maxEntries, 50000);
  assert.equal(app.server.requestTimeout, 20000);
  assert.equal(app.server.headersTimeout, 10000);
  assert.equal(app.server.keepAliveTimeout, 2000);
  await app.close();
  assert.equal(app.server.listening, false);
  await app.close();
});

test("运行时超时配置拒绝越界值和头超时大于请求超时", () => {
  assert.throws(() => resolveRuntimeConfig({ requestTimeoutMs: 500 }, {}, "."), (error) => error.code === "INVALID_CONFIGURATION");
  assert.throws(() => resolveRuntimeConfig({ requestTimeoutMs: 5000, headersTimeoutMs: 6000 }, {}, "."), (error) => error.code === "INVALID_CONFIGURATION");
});
