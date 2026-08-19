import path from "node:path";
import { createApplication } from "../src/server.mjs";

function parseArgs(argv) {
  const result = { limit: 20, watch: false, intervalMs: 5000 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--watch") result.watch = true;
    else if (["--database", "--limit", "--interval-ms"].includes(argument)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument}缺少参数`);
      result[argument === "--database" ? "database" : argument === "--limit" ? "limit" : "intervalMs"] = value;
      index += 1;
    } else throw new Error(`未知参数：${argument}`);
  }
  return result;
}

let app;
try {
  const args = parseArgs(process.argv.slice(2));
  const databasePath = path.resolve(process.cwd(), args.database ?? process.env.DATABASE_PATH ?? "data/demand-platform.db");
  const intervalMs = Number(args.intervalMs);
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000) throw new Error("--interval-ms必须为1000至60000");
  app = createApplication({ databasePath });
  const runOnce = async () => {
    const result = await app.services.demands.processDueSubmissionTasks({ limit: Number(args.limit) });
    if (!args.watch || result.selected > 0 || result.failed > 0) console.log(JSON.stringify({ time: new Date().toISOString(), database: databasePath, ...result }, null, 2));
    if (!args.watch && result.failed > 0) process.exitCode = 2;
  };
  if (!args.watch) {
    await runOnce();
  } else {
    let stopping = false;
    let wake = null;
    const stop = (signal) => {
      if (stopping) return;
      stopping = true;
      console.log(JSON.stringify({ status: "stopping", signal }));
      wake?.();
    };
    process.once("SIGTERM", () => stop("SIGTERM"));
    process.once("SIGINT", () => stop("SIGINT"));
    console.log(JSON.stringify({ status: "watching", database: databasePath, intervalMs, limit: Number(args.limit) }));
    while (!stopping) {
      try { await runOnce(); }
      catch (error) {
        console.error(JSON.stringify({ error: { code: error.code ?? "INTEGRATION_WORKER_ITERATION_FAILED", message: error.message } }));
      }
      if (stopping) break;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        wake = () => { clearTimeout(timer); resolve(); };
      });
      wake = null;
    }
  }
} catch (error) {
  console.error(JSON.stringify({ error: { code: error.code ?? "INTEGRATION_WORKER_FAILED", message: error.message, details: error.details } }, null, 2));
  process.exitCode = 1;
} finally {
  await app?.close();
}
