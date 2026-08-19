import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "../src/db.mjs";
import { verifyDatabaseBackup } from "../src/ops/database-backup.mjs";
import { dataLifecycleMarkdown, hashLifecycleActor, runDataLifecycle } from "../src/ops/data-lifecycle.mjs";

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function writeNew(target, content) {
  const resolved = path.resolve(target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, { encoding: "utf8", flag: "wx" });
}

try {
  const databasePath = path.resolve(option("--database"));
  const policyPath = path.resolve(option("--policy", "config/data-lifecycle-policy.example.json"));
  const actorId = option("--actor-id");
  if (!option("--database") || !actorId) throw new Error("必须提供--database和--actor-id");
  const secretName = option("--actor-hash-secret-env", "LIFECYCLE_HASH_SECRET");
  const requestedByHash = hashLifecycleActor(actorId, process.env[secretName]);
  const execute = process.argv.includes("--execute");
  if (execute && !process.argv.includes("--allow-delete")) throw new Error("执行删除必须同时提供--execute和--allow-delete");
  let backupEvidence;
  if (execute) {
    const backupPath = option("--backup");
    if (!backupPath) throw new Error("执行删除必须提供--backup");
    backupEvidence = verifyDatabaseBackup({ backupPath: path.resolve(backupPath), manifestPath: option("--backup-manifest") ? path.resolve(option("--backup-manifest")) : undefined });
    if (backupEvidence.sourceDatabase && backupEvidence.sourceDatabase !== path.basename(databasePath)) throw new Error("备份清单的源数据库名称与执行目标不一致");
  }
  const db = openDatabase(databasePath, { seedDemo: false });
  let report;
  try {
    report = runDataLifecycle({
      db,
      policy: JSON.parse(fs.readFileSync(policyPath, "utf8")),
      mode: execute ? "EXECUTE" : "DRY_RUN",
      allowDelete: execute && process.argv.includes("--allow-delete"),
      approvedChangeRef: option("--approved-change-ref"),
      requestedByHash,
      backupEvidence,
    });
  } finally { db.close(); }
  const outputJson = option("--output-json");
  const outputMarkdown = option("--output-markdown");
  if (outputJson) writeNew(outputJson, `${JSON.stringify(report, null, 2)}\n`);
  if (outputMarkdown) writeNew(outputMarkdown, dataLifecycleMarkdown(report));
  console.log(JSON.stringify(report, null, 2));
  if (report.outcome !== "PASS") process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ error: { code: error.code ?? "DATA_LIFECYCLE_FAILED", message: error.message } }, null, 2));
  process.exitCode = 1;
}
