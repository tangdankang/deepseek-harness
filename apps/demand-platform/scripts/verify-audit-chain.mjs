import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "../src/db.mjs";
import { AuditService, auditIntegrityMarkdown } from "../src/services/audit-service.mjs";

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
  const database = option("--database");
  if (!database) throw new Error("必须提供--database");
  const secretName = option("--secret-env", "AUDIT_CHAIN_SECRET");
  const secret = process.env[secretName];
  if (!secret) throw new Error(`必须通过环境变量${secretName}提供审计链密钥`);
  const keyVersion = Number(option("--key-version", process.env.AUDIT_CHAIN_KEY_VERSION ?? 1));
  const allowLegacyBackfill = process.argv.includes("--allow-legacy-anchor");
  const changeRef = option("--approved-change-ref");
  if (allowLegacyBackfill && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{5,127}$/.test(changeRef)) throw new Error("旧记录锚定必须提供有效--approved-change-ref");
  const db = openDatabase(path.resolve(database), { seedDemo: false });
  let report;
  try {
    const audit = new AuditService({ db, secret, keyVersion, allowLegacyBackfill });
    const anchored = audit.startupReport.legacyRowsAnchoredThisStartup;
    if (anchored > 0) audit.record({ actorType: "SYSTEM", actorId: "AUDIT_MIGRATION_CLI", action: "ANCHOR_LEGACY_AUDIT_CHAIN", details: { anchored, changeRef } });
    report = { ...audit.assertIntegrity(), legacyRowsAnchoredThisRun: anchored, approvedChangeRef: anchored > 0 ? changeRef : null };
  } finally {
    db.close();
  }
  if (option("--output-json")) writeNew(option("--output-json"), `${JSON.stringify(report, null, 2)}\n`);
  if (option("--output-markdown")) writeNew(option("--output-markdown"), auditIntegrityMarkdown(report));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: { code: error.code ?? "AUDIT_CHAIN_VERIFICATION_FAILED", message: error.message, details: error.details } }, null, 2));
  process.exitCode = 1;
}
