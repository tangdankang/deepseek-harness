import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createApplication } from "../src/server.mjs";
import { capacityTestMarkdown, runCapacityTest, validateCapacityReport } from "../src/performance/capacity-test.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function writeNew(target, content) {
  const resolved = path.resolve(target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, { encoding: "utf8", flag: "wx" });
}

const databasePath = path.resolve(option("--database", "work/local-capacity-v11.db"));
if (fs.existsSync(databasePath)) throw new Error("本地容量测试数据库已存在，拒绝覆盖");
const toolKey = crypto.randomBytes(32).toString("hex");
const identitySecret = crypto.randomBytes(32).toString("hex");
const app = createApplication({
  databasePath,
  toolApiKey: toolKey,
  identityHmacSecret: identitySecret,
  confirmationSecret: crypto.randomBytes(32).toString("hex"),
  webhookSecret: crypto.randomBytes(32).toString("hex"),
  analyticsHashSecret: crypto.randomBytes(32).toString("hex"),
});
let report;
try {
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", () => {
      app.server.off("error", reject);
      resolve();
    });
  });
  report = await runCapacityTest({
    baseUrl: `http://127.0.0.1:${app.server.address().port}`,
    toolKey,
    identitySecret,
    virtualEmployees: option("--virtual-employees", 3000),
    requests: option("--requests", undefined),
    concurrency: option("--concurrency", 100),
    warmupRequests: option("--warmup-requests", 300),
    departments: option("--departments", 30),
    targetRps: option("--target-rps", undefined),
    thresholds: {
      maxErrorRate: 0,
      maxP95Ms: Number(option("--max-p95-ms", 1000)),
      maxP99Ms: Number(option("--max-p99-ms", 2000)),
      minThroughputRps: Number(option("--min-throughput-rps", 50)),
      maxEventLoopP99Ms: Number(option("--max-event-loop-p99-ms", 250)),
      maxHeapGrowthMb: Number(option("--max-heap-growth-mb", 128)),
      maxRssGrowthMb: Number(option("--max-rss-growth-mb", 256)),
      maxRateLimitedRate: 0,
      maxScheduleLagP95Ms: Number(option("--max-schedule-lag-p95-ms", 250)),
    },
    topology: "LOCAL_COMBINED_PROCESS",
  });
  report.localEvidence = {
    technicalInvocationRows: Number(app.db.prepare("SELECT COUNT(*) AS count FROM tool_invocations").get().count),
    businessCaseRows: Number(app.db.prepare("SELECT COUNT(*) AS count FROM demand_cases").get().count),
    externalTicketRows: Number(app.db.prepare("SELECT COUNT(*) AS count FROM external_tickets").get().count),
  };
} finally {
  await app.close();
}

const validation = validateCapacityReport(report);
report.releaseValidation = validation;
const outputJson = option("--output-json", "");
const outputMarkdown = option("--output-markdown", "");
if (outputJson) writeNew(outputJson, `${JSON.stringify(report, null, 2)}\n`);
if (outputMarkdown) writeNew(outputMarkdown, `${capacityTestMarkdown(report)}\n## 本地数据证据\n\n- 技术调用审计：${report.localEvidence.technicalInvocationRows}\n- 业务需求：${report.localEvidence.businessCaseRows}\n- 下游工单：${report.localEvidence.externalTicketRows}\n- 3000人报告校验：${validation.valid ? "PASS" : "FAIL"}\n`);
console.log(JSON.stringify(report, null, 2));
if (report.outcome !== "PASS" || !validation.valid) process.exitCode = 1;
