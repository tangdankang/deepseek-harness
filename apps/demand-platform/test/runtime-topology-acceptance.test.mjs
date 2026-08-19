import assert from "node:assert/strict";
import test from "node:test";
import { runRuntimeTopologyAcceptance } from "../src/conformance/runtime-topology-acceptance.mjs";

const IDS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function health(instanceId, overrides = {}) {
  return {
    status: "ok", readiness: "ready", instanceId,
    runtimeProfile: "PRODUCTION_HIGH_AVAILABILITY", deploymentModel: "HIGH_AVAILABILITY", storageBackend: "POSTGRESQL",
    runtimeCapabilities: { sharedSessionState: true, distributedRateLimit: true, sharedIntegrationCoordination: true },
    ...overrides,
  };
}

test("远程只读采样观察到多个高可用实例和分布式能力才PASS", async () => {
  let call = 0;
  const report = await runRuntimeTopologyAcceptance({
    baseUrl: "https://demand-platform.example.invalid/", samples: 4,
    fetchImpl: async () => response(health(IDS[call++ % 2])), now: () => Date.parse("2026-08-17T08:00:00.000Z"),
  });
  assert.equal(report.outcome, "PASS");
  assert.equal(report.targetClass, "REMOTE");
  assert.equal(report.observedInstanceCount, 2);
  assert.equal(report.observedInstanceHashes.length, 2);
  assert.ok(!JSON.stringify(report).includes(IDS[0]));
  assert.ok(!JSON.stringify(report).includes("demand-platform.example.invalid"));
});

test("远程单实例、SQLite或缺分布式能力不能冒充高可用", async () => {
  const report = await runRuntimeTopologyAcceptance({
    baseUrl: "https://demand-platform.example.invalid/", samples: 3,
    fetchImpl: async () => response(health(IDS[0], {
      runtimeProfile: "PILOT_SINGLE_NODE_SQLITE", deploymentModel: "SINGLE_NODE_PILOT", storageBackend: "SQLITE",
      runtimeCapabilities: { sharedSessionState: false, distributedRateLimit: false, sharedIntegrationCoordination: false },
    })),
  });
  assert.equal(report.outcome, "FAIL");
  assert.equal(report.summary.failed, 4);
});

test("回环地址即使伪造高可用健康响应也只能NOT_READY", async () => {
  let call = 0;
  const report = await runRuntimeTopologyAcceptance({ baseUrl: "http://127.0.0.1:8787/", samples: 2, fetchImpl: async () => response(health(IDS[call++])) });
  assert.equal(report.outcome, "NOT_READY");
  assert.equal(report.checks.find((item) => item.id === "REMOTE_TARGET").passed, false);
});

test("验收器限制目标格式、采样数和响应体积", async () => {
  await assert.rejects(() => runRuntimeTopologyAcceptance({ baseUrl: "https://user:pass@example.invalid/", samples: 2, fetchImpl: async () => response({}) }), /凭据/);
  await assert.rejects(() => runRuntimeTopologyAcceptance({ baseUrl: "https://example.invalid/path", samples: 2, fetchImpl: async () => response({}) }), /源地址/);
  await assert.rejects(() => runRuntimeTopologyAcceptance({ baseUrl: "https://example.invalid/", samples: 1, fetchImpl: async () => response({}) }), /2至100/);
  const oversized = await runRuntimeTopologyAcceptance({ baseUrl: "https://example.invalid/", samples: 2, fetchImpl: async () => new Response("x".repeat(65537)) });
  assert.equal(oversized.outcome, "FAIL");
  assert.equal(oversized.samplesCompleted, 2);
  assert.equal(oversized.checks.find((item) => item.id === "ALL_SAMPLES_READY").passed, false);
});
