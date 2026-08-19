import path from "node:path";
import { verifyDatabaseBackup } from "../src/ops/database-backup.mjs";

try {
  const index = process.argv.indexOf("--backup");
  if (index < 0 || !process.argv[index + 1]) throw new Error("必须提供--backup");
  console.log(JSON.stringify(verifyDatabaseBackup({ backupPath: path.resolve(process.argv[index + 1]) }), null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: { code: "DATABASE_BACKUP_VERIFY_FAILED", message: error.message } }, null, 2));
  process.exitCode = 1;
}
