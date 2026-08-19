import fs from "node:fs";
import path from "node:path";
import { parseEvalJsonl, runAgentEvals } from "../src/evals/agent-eval-runner.mjs";

function parseArgs(argv) {
  const args = { validateOnly: false, strict: false, includePreconditions: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--validate-only", "--strict", "--include-preconditions"].includes(argument)) {
      args[argument === "--validate-only" ? "validateOnly" : argument === "--include-preconditions" ? "includePreconditions" : "strict"] = true;
    } else if (["--file", "--endpoint", "--employee-id", "--department-id"].includes(argument)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument}缺少参数`);
      const key = { "--file": "file", "--endpoint": "endpoint", "--employee-id": "employeeId", "--department-id": "departmentId" }[argument];
      args[key] = value;
      index += 1;
    } else throw new Error(`未知参数：${argument}`);
  }
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) throw new Error("必须提供--file");
  const file = path.resolve(process.cwd(), args.file);
  const cases = parseEvalJsonl(fs.readFileSync(file, "utf8"));
  if (args.validateOnly) {
    const bySeverity = cases.reduce((counts, item) => ({ ...counts, [item.severity]: (counts[item.severity] ?? 0) + 1 }), {});
    const byCategory = cases.reduce((counts, item) => ({ ...counts, [item.category]: (counts[item.category] ?? 0) + 1 }), {});
    console.log(JSON.stringify({ valid: true, cases: cases.length, bySeverity, byCategory }, null, 2));
  } else {
    if (!args.endpoint) throw new Error("执行评测时必须提供--endpoint");
    const report = await runAgentEvals(cases, {
      endpoint: args.endpoint,
      includePreconditions: args.includePreconditions,
      headers: {
        "X-Employee-Id": args.employeeId ?? "E-EVAL",
        "X-Department-Id": args.departmentId ?? "D-ORG",
        "X-Employee-Name": encodeURIComponent("评测员工"),
      },
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.summary.FAIL > 0 || report.summary.ERROR > 0 || (args.strict && (report.summary.PARTIAL > 0 || report.summary.SKIP > 0))) process.exitCode = 1;
  }
} catch (error) {
  console.error(JSON.stringify({ error: { code: error.code ?? "EVAL_RUN_FAILED", message: error.message, details: error.details } }, null, 2));
  process.exitCode = 1;
}
