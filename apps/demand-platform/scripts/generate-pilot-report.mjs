import { formatPilotReport } from "../src/reports/pilot-report.mjs";

function parseArgs(argv) {
  const result = { days: 7, format: "markdown" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--endpoint", "--days", "--format"].includes(argument)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument}缺少参数`);
      result[{ "--endpoint": "endpoint", "--days": "days", "--format": "format" }[argument]] = value;
      index += 1;
    } else throw new Error(`未知参数：${argument}`);
  }
  return result;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (!args.endpoint || !/^https?:\/\//.test(args.endpoint)) throw new Error("必须提供有效--endpoint");
  if (!process.env.ADMIN_API_KEY) throw new Error("请通过环境变量ADMIN_API_KEY提供管理接口密钥");
  if (!['markdown', 'json'].includes(args.format)) throw new Error("--format仅支持markdown或json");
  const url = new URL("/api/v1/admin/metrics", args.endpoint);
  url.searchParams.set("days", String(args.days));
  const response = await fetch(url, { headers: { "X-Admin-Key": process.env.ADMIN_API_KEY, "X-Admin-Id": "PILOT_REPORT_CLI" } });
  const metrics = await response.json();
  if (!response.ok) throw new Error(metrics.error?.message ?? `指标接口返回${response.status}`);
  console.log(args.format === "json" ? JSON.stringify(metrics, null, 2) : formatPilotReport(metrics));
} catch (error) {
  console.error(JSON.stringify({ error: { code: "PILOT_REPORT_FAILED", message: error.message } }, null, 2));
  process.exitCode = 1;
}
