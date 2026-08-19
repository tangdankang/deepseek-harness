import fs from "node:fs";
import path from "node:path";
import { conformanceMarkdown, runDeapToolConformance } from "../src/conformance/deap-tool-conformance.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const allowWrite = process.argv.includes("--allow-write");
const baseUrl = option("--base-url", "http://127.0.0.1:8787");
const toolKeyEnv = option("--tool-key-env", "TOOL_API_KEY");
const identitySecretEnv = option("--identity-secret-env", "IDENTITY_HMAC_SECRET");
const fieldsPath = option("--fields-file", "");
const outputJson = option("--output-json", "");
const outputMarkdown = option("--output-markdown", "");
const parsed = new URL(baseUrl);
if (allowWrite && !["127.0.0.1", "localhost"].includes(parsed.hostname) && !process.argv.includes("--allow-remote-write")) {
  throw new Error("远程写入联调还必须显式提供--allow-remote-write");
}
if (allowWrite && !fieldsPath) throw new Error("写入联调必须提供--fields-file");

const sampleFields = fieldsPath ? JSON.parse(fs.readFileSync(path.resolve(fieldsPath), "utf8")) : undefined;
const report = await runDeapToolConformance({
  baseUrl,
  toolKey: process.env[toolKeyEnv],
  identitySecret: process.env[identitySecretEnv],
  employee: {
    employeeId: option("--employee-id", "E-DEAP-CONFORMANCE"),
    departmentId: option("--department-id", "D-ORG"),
    name: option("--employee-name", "DEAP联调员工"),
  },
  query: option("--query", "CRM"),
  allowWrite,
  serviceCode: option("--service-code", undefined),
  sampleFields,
});

function writeReport(target, content) {
  const resolved = path.resolve(target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, "utf8");
}
if (outputJson) writeReport(outputJson, `${JSON.stringify(report, null, 2)}\n`);
if (outputMarkdown) writeReport(outputMarkdown, conformanceMarkdown(report));
console.log(JSON.stringify(report, null, 2));
if (report.outcome !== "PASS") process.exitCode = 1;
