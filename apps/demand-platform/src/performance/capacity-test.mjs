import crypto from "node:crypto";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { signIdentityContext } from "../domain/identity-signature.mjs";

const OPERATIONS = Object.freeze([
  Object.freeze({ id: "get_employee_context", path: "/api/v1/tools/get-employee-context", body: {} }),
  Object.freeze({ id: "search_service_catalog", path: "/api/v1/tools/search-service-catalog", body: { query: "capacity-check" } }),
  Object.freeze({ id: "search_knowledge", path: "/api/v1/tools/search-knowledge", body: { query: "capacity-check" } }),
]);

function integer(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name}必须为${minimum}至${maximum}的整数`);
  return parsed;
}

function finite(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name}必须为${minimum}至${maximum}的数字`);
  return parsed;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function round(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function bytesToMb(value) {
  return round(value / 1024 / 1024);
}

function loopback(url) {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
}

async function pooled(count, concurrency, operation) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (cursor < count) {
      const index = cursor++;
      await operation(index);
    }
  });
  await Promise.all(workers);
}

function latencySummary(values) {
  return {
    requests: values.length,
    p50Ms: round(percentile(values, 0.5)),
    p90Ms: round(percentile(values, 0.9)),
    p95Ms: round(percentile(values, 0.95)),
    p99Ms: round(percentile(values, 0.99)),
    maxMs: values.length ? round(Math.max(...values)) : null,
  };
}

function policy(input = {}) {
  return {
    maxErrorRate: finite(input.maxErrorRate ?? 0.001, "maxErrorRate", 0, 1),
    maxP95Ms: finite(input.maxP95Ms ?? 500, "maxP95Ms", 1, 120000),
    maxP99Ms: finite(input.maxP99Ms ?? 1000, "maxP99Ms", 1, 120000),
    minThroughputRps: finite(input.minThroughputRps ?? 50, "minThroughputRps", 0.01, 1000000),
    maxEventLoopP99Ms: finite(input.maxEventLoopP99Ms ?? 100, "maxEventLoopP99Ms", 1, 60000),
    maxHeapGrowthMb: finite(input.maxHeapGrowthMb ?? 128, "maxHeapGrowthMb", 0, 65536),
    maxRssGrowthMb: finite(input.maxRssGrowthMb ?? 256, "maxRssGrowthMb", 0, 65536),
    maxRateLimitedRate: finite(input.maxRateLimitedRate ?? 0.001, "maxRateLimitedRate", 0, 1),
    maxScheduleLagP95Ms: finite(input.maxScheduleLagP95Ms ?? 100, "maxScheduleLagP95Ms", 0, 60000),
  };
}

export async function runCapacityTest({
  baseUrl,
  toolKey,
  identitySecret,
  virtualEmployees = 3000,
  requests,
  concurrency = 100,
  warmupRequests = 300,
  departments = 30,
  requestTimeoutMs = 10000,
  targetRps,
  thresholds = {},
  fetchImpl = globalThis.fetch,
  topology,
} = {}) {
  const target = new URL(baseUrl);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.search || target.hash) throw new Error("baseUrl格式无效");
  if (!toolKey || !identitySecret) throw new Error("toolKey和identitySecret均为必填项");
  const employeeCount = integer(virtualEmployees, "virtualEmployees", 2, 10000);
  const requestCount = integer(requests ?? employeeCount * OPERATIONS.length, "requests", employeeCount, 1000000);
  const workerCount = integer(concurrency, "concurrency", 1, 500);
  const warmupCount = integer(warmupRequests, "warmupRequests", 0, 100000);
  const departmentCount = integer(departments, "departments", 2, 1000);
  const timeoutMs = integer(requestTimeoutMs, "requestTimeoutMs", 1000, 120000);
  const arrivalRate = targetRps === undefined || targetRps === null || targetRps === "" ? null : finite(targetRps, "targetRps", 1, 10000);
  const gate = policy(thresholds);
  const base = target.href.replace(/\/$/, "");
  const runId = crypto.randomUUID();
  const targetClass = loopback(target) ? "LOOPBACK" : target.protocol === "https:" ? "REMOTE_HTTPS" : "REMOTE_INSECURE";
  const executionTopology = topology ?? (targetClass === "LOOPBACK" ? "LOCAL_TARGET_SEPARATE_OR_SHARED_PROCESS" : "REMOTE_TARGET");
  let sequence = 0;

  const invoke = async (index, measured, scheduleLagMs = 0) => {
    const employeeIndex = index % employeeCount;
    const operation = OPERATIONS[index % OPERATIONS.length];
    const employeeId = `CAP-${runId.slice(0, 8)}-${String(employeeIndex + 1).padStart(5, "0")}`;
    const departmentId = `CAP-DEPT-${String((employeeIndex % departmentCount) + 1).padStart(3, "0")}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const invocationId = `capacity:${runId}:${++sequence}`;
    const started = performance.now();
    let status = 0;
    let errorCode = null;
    try {
      const response = await fetchImpl(`${base}${operation.path}`, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "content-type": "application/json",
          "x-tool-key": toolKey,
          "x-tool-invocation-id": invocationId,
          "x-employee-id": employeeId,
          "x-department-id": departmentId,
          "x-employee-name": encodeURIComponent("容量测试身份"),
          "x-identity-timestamp": String(timestamp),
          "x-identity-signature": signIdentityContext({ employeeId, departmentId, timestamp, secret: identitySecret }),
        },
        body: JSON.stringify(operation.body),
      });
      status = response.status;
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        errorCode = typeof payload?.error?.code === "string" ? payload.error.code : "HTTP_ERROR";
      } else await response.arrayBuffer();
    } catch (error) {
      errorCode = ["AbortError", "TimeoutError"].includes(error?.name) ? "REQUEST_TIMEOUT" : "NETWORK_ERROR";
    }
    if (!measured) return;
    return { operationId: operation.id, durationMs: performance.now() - started, scheduleLagMs, status, errorCode };
  };

  if (warmupCount > 0) await pooled(warmupCount, workerCount, (index) => invoke(index, false));

  const baselineMemory = process.memoryUsage();
  let peakMemory = { ...baselineMemory };
  const sampleMemory = () => {
    const current = process.memoryUsage();
    for (const key of ["rss", "heapUsed", "external", "arrayBuffers"]) peakMemory[key] = Math.max(peakMemory[key] ?? 0, current[key] ?? 0);
  };
  const sampler = setInterval(sampleMemory, 25);
  sampler.unref?.();
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  const cpuBefore = process.cpuUsage();
  const results = new Array(requestCount);
  const startedAt = new Date();
  const started = performance.now();
  try {
    await pooled(requestCount, workerCount, async (index) => {
      let scheduleLagMs = 0;
      if (arrivalRate !== null) {
        const plannedAt = started + (index * 1000 / arrivalRate);
        const waitMs = plannedAt - performance.now();
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
        scheduleLagMs = Math.max(0, performance.now() - plannedAt);
      }
      results[index] = await invoke(index + warmupCount, true, scheduleLagMs);
    });
  } finally {
    sampleMemory();
    clearInterval(sampler);
    eventLoop.disable();
  }
  const durationMs = performance.now() - started;
  const completedAt = new Date();
  const cpu = process.cpuUsage(cpuBefore);
  const endingMemory = process.memoryUsage();
  const durations = results.map((item) => item.durationMs);
  const scheduleLags = results.map((item) => item.scheduleLagMs);
  const failures = results.filter((item) => item.status < 200 || item.status >= 300);
  const rateLimited = results.filter((item) => item.status === 429);
  const statusCounts = Object.fromEntries([...new Set(results.map((item) => String(item.status)))].sort().map((status) => [status, results.filter((item) => String(item.status) === status).length]));
  const latencyByOperation = Object.fromEntries(OPERATIONS.map((operation) => [operation.id, latencySummary(results.filter((item) => item.operationId === operation.id).map((item) => item.durationMs))]));
  const totalLatency = latencySummary(durations);
  const throughputRps = requestCount / (durationMs / 1000);
  const errorRate = failures.length / requestCount;
  const rateLimitedRate = rateLimited.length / requestCount;
  const heapGrowthMb = bytesToMb(Math.max(0, endingMemory.heapUsed - baselineMemory.heapUsed));
  const rssGrowthMb = bytesToMb(Math.max(0, endingMemory.rss - baselineMemory.rss));
  const eventLoopP99Ms = round(eventLoop.percentile(99) / 1e6);
  const scheduleLagP95Ms = round(percentile(scheduleLags, 0.95));
  const assertions = [
    { id: "ERROR_RATE", actual: round(errorRate, 6), target: gate.maxErrorRate, passed: errorRate <= gate.maxErrorRate },
    { id: "P95_LATENCY_MS", actual: totalLatency.p95Ms, target: gate.maxP95Ms, passed: totalLatency.p95Ms <= gate.maxP95Ms },
    { id: "P99_LATENCY_MS", actual: totalLatency.p99Ms, target: gate.maxP99Ms, passed: totalLatency.p99Ms <= gate.maxP99Ms },
    { id: "THROUGHPUT_RPS", actual: round(throughputRps), target: gate.minThroughputRps, passed: throughputRps >= gate.minThroughputRps },
    { id: "EVENT_LOOP_P99_MS", actual: eventLoopP99Ms, target: gate.maxEventLoopP99Ms, passed: eventLoopP99Ms <= gate.maxEventLoopP99Ms },
    { id: "HEAP_GROWTH_MB", actual: heapGrowthMb, target: gate.maxHeapGrowthMb, passed: heapGrowthMb <= gate.maxHeapGrowthMb },
    { id: "RSS_GROWTH_MB", actual: rssGrowthMb, target: gate.maxRssGrowthMb, passed: rssGrowthMb <= gate.maxRssGrowthMb },
    { id: "RATE_LIMITED_RATE", actual: round(rateLimitedRate, 6), target: gate.maxRateLimitedRate, passed: rateLimitedRate <= gate.maxRateLimitedRate },
    { id: "SCHEDULE_LAG_P95_MS", actual: scheduleLagP95Ms, target: gate.maxScheduleLagP95Ms, passed: scheduleLagP95Ms <= gate.maxScheduleLagP95Ms },
  ];
  const errorCodes = Object.fromEntries([...new Set(failures.map((item) => item.errorCode ?? "UNKNOWN"))].sort().map((code) => [code, failures.filter((item) => (item.errorCode ?? "UNKNOWN") === code).length]));

  return {
    schemaVersion: 1,
    reportType: "AI_DEMAND_PLATFORM_CAPACITY_TEST",
    runId,
    outcome: assertions.every((item) => item.passed) ? "PASS" : "FAIL",
    target: "REDACTED_TARGET",
    targetClass,
    executionTopology,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    profile: { virtualEmployees: employeeCount, departments: departmentCount, requests: requestCount, warmupRequests: warmupCount, concurrency: workerCount, requestTimeoutMs: timeoutMs, operations: OPERATIONS.length, arrivalModel: arrivalRate === null ? "CLOSED_LOOP_MAX_THROUGHPUT" : "OPEN_LOOP_SCHEDULED_RATE", targetRps: arrivalRate },
    summary: { durationMs: round(durationMs), throughputRps: round(throughputRps), scheduleLagP50Ms: round(percentile(scheduleLags, 0.5)), scheduleLagP95Ms, scheduleLagP99Ms: round(percentile(scheduleLags, 0.99)), scheduleLagMaxMs: round(Math.max(...scheduleLags)), completedRequests: requestCount, successfulRequests: requestCount - failures.length, failedRequests: failures.length, errorRate: round(errorRate, 6), rateLimitedRequests: rateLimited.length, rateLimitedRate: round(rateLimitedRate, 6), statusCounts, ...totalLatency },
    latencyByOperation,
    runtime: {
      measurementScope: "LOAD_GENERATOR_PROCESS",
      eventLoopP50Ms: round(eventLoop.percentile(50) / 1e6),
      eventLoopP95Ms: round(eventLoop.percentile(95) / 1e6),
      eventLoopP99Ms,
      eventLoopMaxMs: round(eventLoop.max / 1e6),
      cpuUserMs: round(cpu.user / 1000),
      cpuSystemMs: round(cpu.system / 1000),
      baselineHeapUsedMb: bytesToMb(baselineMemory.heapUsed),
      endingHeapUsedMb: bytesToMb(endingMemory.heapUsed),
      peakHeapUsedMb: bytesToMb(peakMemory.heapUsed),
      heapGrowthMb,
      baselineRssMb: bytesToMb(baselineMemory.rss),
      endingRssMb: bytesToMb(endingMemory.rss),
      peakRssMb: bytesToMb(peakMemory.rss),
      rssGrowthMb,
    },
    assertions,
    failures: { errorCodes },
    safety: { businessWritesGenerated: false, technicalInvocationAuditGenerated: true, reportContainsEmployeeIds: false, reportContainsCredentials: false, reportContainsTargetUrl: false },
    evidenceBoundary: targetClass === "LOOPBACK"
      ? "本地容量基准仅证明当前机器和本地拓扑下的相对性能，不证明生产容量、高可用或网络性能。"
      : "远程报告仍需服务端CPU/内存/数据库/网关监控、容量环境等价性和运维签字才能形成生产证据。",
  };
}

export function capacityTestMarkdown(report) {
  const assertionRows = report.assertions.map((item) => `| ${item.id} | ${item.actual} | ${item.target} | ${item.passed ? "PASS" : "FAIL"} |`).join("\n");
  const operationRows = Object.entries(report.latencyByOperation).map(([name, item]) => `| ${name} | ${item.requests} | ${item.p50Ms} | ${item.p95Ms} | ${item.p99Ms} | ${item.maxMs} |`).join("\n");
  return `# AI统一需求平台容量与稳定性测试报告

- 结果：**${report.outcome}**
- 目标类型：${report.targetClass}
- 执行拓扑：${report.executionTopology}
- 虚拟员工：${report.profile.virtualEmployees}
- 部门：${report.profile.departments}
- 测量请求：${report.profile.requests}
- 预热请求：${report.profile.warmupRequests}
- 并发：${report.profile.concurrency}
- 到达模型：${report.profile.arrivalModel}${report.profile.targetRps ? `，目标 ${report.profile.targetRps} req/s` : ""}
- 吞吐：${report.summary.throughputRps} req/s
- 成功请求：${report.summary.successfulRequests}/${report.summary.completedRequests}
- P95/P99：${report.summary.p95Ms}/${report.summary.p99Ms} ms
- 调度滞后P95：${report.summary.scheduleLagP95Ms} ms

## 容量门禁

| 指标 | 实际值 | 门槛 | 结果 |
|---|---:|---:|---|
${assertionRows}

## 操作延迟

| 操作 | 请求 | P50(ms) | P95(ms) | P99(ms) | Max(ms) |
|---|---:|---:|---:|---:|---:|
${operationRows}

## 运行时观测

- 事件循环P99：${report.runtime.eventLoopP99Ms} ms
- Heap增长：${report.runtime.heapGrowthMb} MB，峰值：${report.runtime.peakHeapUsedMb} MB
- RSS增长：${report.runtime.rssGrowthMb} MB，峰值：${report.runtime.peakRssMb} MB
- CPU用户/系统：${report.runtime.cpuUserMs}/${report.runtime.cpuSystemMs} ms
- 观测范围：${report.runtime.measurementScope}

## 数据与证据边界

- 该场景不创建需求或下游工单，但会生成技术调用审计。
- 报告不包含目标URL、凭据或虚拟员工标识。
- ${report.evidenceBoundary}
`;
}

export function validateCapacityReport(report, { minVirtualEmployees = 3000, minRequests = 9000, minConcurrency = 50 } = {}) {
  const findings = [];
  if (report?.schemaVersion !== 1 || report?.reportType !== "AI_DEMAND_PLATFORM_CAPACITY_TEST") findings.push("报告格式无效");
  if (report?.outcome !== "PASS") findings.push("容量门禁未通过");
  if (Number(report?.profile?.virtualEmployees ?? 0) < minVirtualEmployees) findings.push(`虚拟员工少于${minVirtualEmployees}`);
  if (Number(report?.profile?.requests ?? 0) < minRequests) findings.push(`请求数少于${minRequests}`);
  if (Number(report?.profile?.concurrency ?? 0) < minConcurrency) findings.push(`并发少于${minConcurrency}`);
  if (Number(report?.summary?.completedRequests ?? 0) !== Number(report?.profile?.requests ?? -1)) findings.push("测量请求未全部完成");
  if (!Array.isArray(report?.assertions) || report.assertions.length !== 9 || report.assertions.some((item) => item.passed !== true)) findings.push("容量断言不完整或失败");
  if (report?.safety?.businessWritesGenerated !== false || report?.safety?.reportContainsEmployeeIds !== false || report?.safety?.reportContainsCredentials !== false) findings.push("报告安全边界无效");
  return { valid: findings.length === 0, findings, scope: { minVirtualEmployees, minRequests, minConcurrency } };
}
