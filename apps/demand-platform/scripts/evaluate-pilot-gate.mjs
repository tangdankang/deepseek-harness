import fs from "node:fs";
import path from "node:path";
import { evaluatePilotGate, formatPilotGateReport } from "../src/reports/pilot-gate.mjs";
import { validateSyntheticPilotReport } from "../src/pilot/synthetic-pilot.mjs";

function args(argv) {
  const result = { days: 7, format: "markdown" };
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (!["--endpoint", "--evidence", "--policy", "--synthetic-report", "--days", "--format"].includes(name)) throw new Error(`未知参数：${name}`);
    if (!argv[i + 1]) throw new Error(`${name}缺少参数`);
    result[name.slice(2)] = argv[++i];
  }
  return result;
}

try {
  const options = args(process.argv.slice(2));
  if (!options.endpoint || !options.evidence) throw new Error("必须提供--endpoint和--evidence");
  if (!process.env.ADMIN_API_KEY) throw new Error("请通过环境变量ADMIN_API_KEY提供管理接口密钥");
  const evidence = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), options.evidence), "utf8"));
  if (options["synthetic-report"]) {
    const synthetic = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), options["synthetic-report"]), "utf8"));
    const validation = validateSyntheticPilotReport(synthetic);
    evidence.syntheticPilotPassed = validation.valid;
    if (!validation.valid) throw new Error(`合成试点报告不满足门禁：${validation.findings.join("；")}`);
  }
  const policy = options.policy ? JSON.parse(fs.readFileSync(path.resolve(process.cwd(), options.policy), "utf8")) : {};
  const url = new URL("/api/v1/admin/metrics", options.endpoint);
  url.searchParams.set("days", String(options.days));
  const response = await fetch(url, { headers: { "X-Admin-Key": process.env.ADMIN_API_KEY, "X-Admin-Id": "PILOT_GATE_CLI" } });
  const metrics = await response.json();
  if (!response.ok) throw new Error(metrics.error?.message ?? `指标接口返回${response.status}`);
  const result = evaluatePilotGate(metrics, evidence, policy);
  console.log(options.format === "json" ? JSON.stringify(result, null, 2) : formatPilotGateReport(result));
  if (result.decision !== "GO") process.exitCode = result.decision === "NO_GO" ? 2 : 3;
} catch (error) {
  console.error(JSON.stringify({ error: { code: "PILOT_GATE_FAILED", message: error.message } }, null, 2));
  process.exitCode = 1;
}
