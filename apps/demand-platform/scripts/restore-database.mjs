import path from "node:path";
import { restoreDatabaseBackup } from "../src/ops/database-backup.mjs";

function value(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

try {
  const backup = value("--backup");
  const target = value("--target");
  if (!backup || !target) throw new Error("必须提供--backup和--target");
  console.log(JSON.stringify(restoreDatabaseBackup({ backupPath: path.resolve(backup), targetPath: path.resolve(target) }), null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: { code: "DATABASE_RESTORE_FAILED", message: error.message } }, null, 2));
  process.exitCode = 1;
}
