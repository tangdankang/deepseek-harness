import crypto from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HA_STORAGE = new Set(["POSTGRESQL", "MYSQL"]);

function targetClass(url) {
  const hostname = url.hostname.toLowerCase();
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname) ? "LOOPBACK" : "REMOTE";
}

function targetHash(url) {
  return crypto.createHash("sha256").update(url.origin).digest("hex").toUpperCase();
}

function safeHealth(body) {
  return {
    status: body?.status ?? null,
    readiness: body?.readiness ?? null,
    instanceId: typeof body?.instanceId === "string" && UUID.test(body.instanceId) ? body.instanceId : null,
    runtimeProfile: body?.runtimeProfile ?? null,
    deploymentModel: body?.deploymentModel ?? null,
    storageBackend: body?.storageBackend ?? null,
    runtimeCapabilities: {
      sharedSessionState: body?.runtimeCapabilities?.sharedSessionState === true,
      distributedRateLimit: body?.runtimeCapabilities?.distributedRateLimit === true,
      sharedIntegrationCoordination: body?.runtimeCapabilities?.sharedIntegrationCoordination === true,
    },
  };
}

async function boundedJson(response) {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > 65536) throw new Error("健康响应超过64KiB");
  const text = await response.text();
  if (Buffer.byteLength(text) > 65536) throw new Error("健康响应超过64KiB");
  return JSON.parse(text);
}

export async function runRuntimeTopologyAcceptance({ baseUrl, samples = 20, fetchImpl = globalThis.fetch, timeoutMs = 5000, now = () => Date.now() }) {
  let url;
  try { url = new URL(baseUrl); }
  catch { throw new Error("--base-url必须是有效HTTP(S)地址"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("--base-url只允许不含凭据、路径、查询和片段的HTTP(S)源地址");
  if (!Number.isInteger(samples) || samples < 2 || samples > 100) throw new Error("samples必须为2至100的整数");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30000) throw new Error("timeoutMs必须为500至30000毫秒");
  if (typeof fetchImpl !== "function") throw new Error("缺少fetch实现");
  const classification = targetClass(url);
  const observations = [];
  for (let index = 0; index < samples; index += 1) {
    try {
      const endpoint = new URL("/health/ready", url);
      endpoint.searchParams.set("topologyProbe", crypto.randomBytes(8).toString("hex"));
      const response = await fetchImpl(endpoint, { method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json", "cache-control": "no-cache" } });
      const body = safeHealth(await boundedJson(response));
      observations.push({ httpStatus: response.status, ...body });
    } catch (error) {
      observations.push({ httpStatus: null, error: String(error?.message ?? error).slice(0, 200) });
    }
  }
  const uniqueInstanceIds = [...new Set(observations.map((item) => item.instanceId).filter(Boolean))];
  const allHealthy = observations.every((item) => item.httpStatus === 200 && item.status === "ok" && item.readiness === "ready");
  const allHaProfile = observations.every((item) => item.runtimeProfile === "PRODUCTION_HIGH_AVAILABILITY" && item.deploymentModel === "HIGH_AVAILABILITY");
  const allHaStorage = observations.every((item) => HA_STORAGE.has(item.storageBackend));
  const allDistributed = observations.every((item) => item.runtimeCapabilities && Object.values(item.runtimeCapabilities).every(Boolean));
  const enoughInstances = uniqueInstanceIds.length >= 2;
  const checks = [
    { id: "REMOTE_TARGET", passed: classification === "REMOTE" },
    { id: "ALL_SAMPLES_READY", passed: allHealthy },
    { id: "HA_RUNTIME_PROFILE", passed: allHaProfile },
    { id: "HA_STORAGE_BACKEND", passed: allHaStorage },
    { id: "DISTRIBUTED_RUNTIME_CAPABILITIES", passed: allDistributed },
    { id: "MULTIPLE_INSTANCES_OBSERVED", passed: enoughInstances },
  ];
  const failed = checks.filter((item) => !item.passed);
  const outcome = classification !== "REMOTE" ? "NOT_READY" : failed.length ? "FAIL" : "PASS";
  return {
    reportType: "AI_DEMAND_PLATFORM_RUNTIME_TOPOLOGY_ACCEPTANCE",
    reportVersion: 1,
    outcome,
    executionMode: "READ_ONLY_REMOTE_HEALTH_SAMPLING",
    targetClass: classification,
    targetHash: targetHash(url),
    sampledAt: new Date(now()).toISOString(),
    samplesRequested: samples,
    samplesCompleted: observations.length,
    deploymentModel: allHaProfile ? "HIGH_AVAILABILITY" : null,
    runtimeProfile: observations.every((item) => item.runtimeProfile === observations[0]?.runtimeProfile) ? observations[0]?.runtimeProfile ?? null : "MIXED",
    storageBackends: [...new Set(observations.map((item) => item.storageBackend).filter(Boolean))].sort(),
    observedInstanceCount: uniqueInstanceIds.length,
    observedInstanceHashes: uniqueInstanceIds.map((id) => crypto.createHash("sha256").update(id).digest("hex").toUpperCase()).sort(),
    capabilities: {
      sharedSessionState: observations.length > 0 && observations.every((item) => item.runtimeCapabilities?.sharedSessionState === true),
      distributedRateLimit: observations.length > 0 && observations.every((item) => item.runtimeCapabilities?.distributedRateLimit === true),
      sharedIntegrationCoordination: observations.length > 0 && observations.every((item) => item.runtimeCapabilities?.sharedIntegrationCoordination === true),
    },
    checks,
    summary: { passed: checks.length - failed.length, failed: failed.length },
  };
}
