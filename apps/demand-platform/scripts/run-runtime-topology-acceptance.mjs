import fs from "node:fs";
import path from "node:path";
import { runRuntimeTopologyAcceptance } from "../src/conformance/runtime-topology-acceptance.mjs";

function args(argv) {
  const result = { samples: 20, timeoutMs: 5000 };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (["--base-url", "--samples", "--timeout-ms", "--output-json"].includes(name)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${name}缺少参数`);
      result[name === "--base-url" ? "baseUrl" : name === "--output-json" ? "outputJson" : name === "--timeout-ms" ? "timeoutMs" : "samples"] = ["--samples", "--timeout-ms"].includes(name) ? Number(value) : value;
      index += 1;
    } else if (["--help", "-h"].includes(name)) result.help = true;
    else throw new Error(`未知参数：${name}`);
  }
  return result;
}

try {
  const options = args(process.argv.slice(2));
  if (options.help) console.log("用法：node scripts/run-runtime-topology-acceptance.mjs --base-url <https://host> [--samples 20] [--timeout-ms 5000] [--output-json report.json]");
  else {
    if (!options.baseUrl) throw new Error("必须提供--base-url");
    const report = await runRuntimeTopologyAcceptance(options);
    if (options.outputJson) {
      const output = path.resolve(options.outputJson);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    }
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.outcome === "PASS" ? 0 : report.outcome === "NOT_READY" ? 3 : 2;
  }
} catch (error) {
  console.error(JSON.stringify({ error: { code: "RUNTIME_TOPOLOGY_ACCEPTANCE_FAILED", message: error.message } }, null, 2));
  process.exitCode = 1;
}
