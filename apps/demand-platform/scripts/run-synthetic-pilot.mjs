import fs from "node:fs";
import path from "node:path";
import { runSyntheticPilot, syntheticPilotMarkdown } from "../src/pilot/synthetic-pilot.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function write(target, content) {
  const resolved = path.resolve(target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, "utf8");
}

const allowWrite = process.argv.includes("--allow-write");
const baseUrl = option("--base-url", "http://127.0.0.1:8787");
const parsed = new URL(baseUrl);
if (allowWrite && !["127.0.0.1", "localhost"].includes(parsed.hostname) && !process.argv.includes("--allow-remote-write")) throw new Error("远程写入合成试点还必须显式提供--allow-remote-write");
const fieldsPath = option("--fields-file", "");
if (allowWrite && !fieldsPath) throw new Error("写入模式必须提供--fields-file");
const thresholdsPath = option("--thresholds-file", "");

const report = await runSyntheticPilot({
  baseUrl,
  toolKey: process.env[option("--tool-key-env", "TOOL_API_KEY")],
  identitySecret: process.env[option("--identity-secret-env", "IDENTITY_HMAC_SECRET")],
  employeeCount: option("--employees", 50),
  concurrency: option("--concurrency", 10),
  allowWrite,
  writeEmployeeCount: option("--write-employees", 20),
  serviceCode: option("--service-code", undefined),
  sampleFields: fieldsPath ? JSON.parse(fs.readFileSync(path.resolve(fieldsPath), "utf8")) : undefined,
  query: option("--query", "CRM"),
  departments: option("--departments", "D-PILOT-A,D-PILOT-B").split(",").map((item) => item.trim()).filter(Boolean),
  thresholds: thresholdsPath ? JSON.parse(fs.readFileSync(path.resolve(thresholdsPath), "utf8")) : {},
});

const outputJson = option("--output-json", "");
const outputMarkdown = option("--output-markdown", "");
if (outputJson) write(outputJson, `${JSON.stringify(report, null, 2)}\n`);
if (outputMarkdown) write(outputMarkdown, syntheticPilotMarkdown(report));
console.log(JSON.stringify(report, null, 2));
if (report.outcome !== "PASS") process.exitCode = 1;
