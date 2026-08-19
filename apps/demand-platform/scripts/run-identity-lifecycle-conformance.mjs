import fs from "node:fs";
import path from "node:path";
import { identityLifecycleConformanceMarkdown, runIdentityLifecycleConformance } from "../src/conformance/identity-lifecycle-conformance.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const baseUrl = option("--base-url", "http://127.0.0.1:8787");
const parsed = new URL(baseUrl);
const remote = !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname.toLowerCase());
if (!process.argv.includes("--allow-write") || !process.argv.includes("--confirm-test-employee")) throw new Error("联调会改变测试员工访问状态，必须同时提供--allow-write和--confirm-test-employee");
if (remote && (!process.argv.includes("--allow-remote-write") || parsed.protocol !== "https:")) throw new Error("远程联调必须使用HTTPS并提供--allow-remote-write");
const startingSequence = Number(option("--starting-sequence", ""));
if (!Number.isSafeInteger(startingSequence) || startingSequence < 1) throw new Error("必须提供有效--starting-sequence，并确保高于该测试员工已处理序号");
const employeeId = option("--test-employee-id", remote ? "" : "E-IDENTITY-CONFORMANCE");
if (!employeeId) throw new Error("远程联调必须显式提供--test-employee-id");

const report = await runIdentityLifecycleConformance({
  baseUrl,
  eventSecret: process.env[option("--event-secret-env", "IDENTITY_EVENT_SECRET")],
  identitySecret: process.env[option("--identity-secret-env", "IDENTITY_HMAC_SECRET")],
  toolKey: process.env[option("--tool-key-env", "TOOL_API_KEY")],
  sourceSystem: option("--source-system", process.env.IDENTITY_EVENT_SOURCE ?? "company-identity-gateway"),
  startingSequence,
  employee: { employeeId, departmentId: option("--department-id", "D-ORG"), name: option("--employee-name", "身份联调测试员工") },
  testEmployeeConfirmed: true,
});

function write(target, content) {
  if (!target) return;
  const resolved = path.resolve(target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, "utf8");
}
write(option("--output-json", ""), `${JSON.stringify(report, null, 2)}\n`);
write(option("--output-markdown", ""), identityLifecycleConformanceMarkdown(report));
console.log(JSON.stringify(report, null, 2));
if (report.outcome !== "PASS") process.exitCode = 1;
