import path from "node:path";
import { backupDatabase } from "../src/ops/database-backup.mjs";

function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!["--database", "--output"].includes(argv[i]) || !argv[i + 1]) throw new Error(`参数无效或缺值：${argv[i]}`);
    result[argv[i].slice(2)] = argv[++i];
  }
  return result;
}

try {
  const input = args(process.argv.slice(2));
  if (!input.database || !input.output) throw new Error("必须提供--database和--output");
  console.log(JSON.stringify(backupDatabase({ databasePath: path.resolve(input.database), outputPath: path.resolve(input.output) }), null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: { code: "DATABASE_BACKUP_FAILED", message: error.message } }, null, 2));
  process.exitCode = 1;
}
