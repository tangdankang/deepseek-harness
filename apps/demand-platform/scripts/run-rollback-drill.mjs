import fs from "node:fs";
import path from "node:path";
import { runRollbackDrill, formatRollbackDrillMarkdown } from "../src/ops/rollback-drill.mjs";

function parseArgs(argv) {
  const allowed = new Set(["--database", "--drill-directory", "--output-json", "--output-markdown"]);
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!allowed.has(key) || !argv[index + 1]) throw new Error(`参数无效或缺值：${key}`);
    result[key.slice(2)] = argv[++index];
  }
  return result;
}

function writeNew(file, content) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
}

try {
  const input = parseArgs(process.argv.slice(2));
  if (!input.database || !input["drill-directory"]) throw new Error("必须提供--database和--drill-directory");
  const report = await runRollbackDrill({
    databasePath: path.resolve(input.database),
    drillDirectory: path.resolve(input["drill-directory"]),
  });
  if (input["output-json"]) writeNew(input["output-json"], `${JSON.stringify(report, null, 2)}\n`);
  if (input["output-markdown"]) writeNew(input["output-markdown"], formatRollbackDrillMarkdown(report));
  console.log(JSON.stringify(report, null, 2));
  if (report.result !== "PASS") process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ error: { code: "DATABASE_ROLLBACK_DRILL_FAILED", message: error.message } }, null, 2));
  process.exitCode = 1;
}
