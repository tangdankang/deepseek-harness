import fs from "node:fs";
import path from "node:path";
import { capacityTestMarkdown, runCapacityTest } from "../src/performance/capacity-test.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function writeNew(target, content) {
  const resolved = path.resolve(target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, { encoding: "utf8", flag: "wx" });
}

try {
  const baseUrl = option("--base-url", "http://127.0.0.1:8787");
  const parsed = new URL(baseUrl);
  const remote = !["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
  if (remote && (!process.argv.includes("--allow-remote-load") || !process.argv.includes("--confirm-approved-window"))) {
    throw new Error("远程容量测试必须同时提供--allow-remote-load和--confirm-approved-window");
  }
  if (remote && parsed.protocol !== "https:") throw new Error("远程容量测试仅允许HTTPS");
  const thresholdsFile = option("--thresholds-file", "");
  const report = await runCapacityTest({
    baseUrl,
    toolKey: process.env[option("--tool-key-env", "TOOL_API_KEY")],
    identitySecret: process.env[option("--identity-secret-env", "IDENTITY_HMAC_SECRET")],
    virtualEmployees: option("--virtual-employees", 3000),
    requests: option("--requests", undefined),
    concurrency: option("--concurrency", 100),
    warmupRequests: option("--warmup-requests", 300),
    departments: option("--departments", 30),
    requestTimeoutMs: option("--request-timeout-ms", 10000),
    targetRps: option("--target-rps", undefined),
    thresholds: thresholdsFile ? JSON.parse(fs.readFileSync(path.resolve(thresholdsFile), "utf8")) : {},
    topology: remote ? "REMOTE_TARGET" : "LOCAL_TARGET_SEPARATE_OR_SHARED_PROCESS",
  });
  const outputJson = option("--output-json", "");
  const outputMarkdown = option("--output-markdown", "");
  if (outputJson) writeNew(outputJson, `${JSON.stringify(report, null, 2)}\n`);
  if (outputMarkdown) writeNew(outputMarkdown, capacityTestMarkdown(report));
  console.log(JSON.stringify(report, null, 2));
  if (report.outcome !== "PASS") process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ error: { code: "CAPACITY_TEST_FAILED", message: error.message } }, null, 2));
  process.exitCode = 1;
}
