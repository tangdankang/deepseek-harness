import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getDatabaseSchemaInfo } from "../db.mjs";

const BACKUP_FORMAT_V1 = "ai-demand-platform-sqlite-backup-v1";
const BACKUP_FORMAT_V2 = "ai-demand-platform-sqlite-backup-v2";

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").toUpperCase();
}

function integrity(db) {
  const rows = db.prepare("PRAGMA integrity_check").all();
  return rows.map((row) => Object.values(row)[0]);
}

function foreignKeyViolations(db) {
  return db.prepare("PRAGMA foreign_key_check").all();
}

function tableCounts(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name, Number(db.prepare(`SELECT COUNT(*) AS count FROM "${name.replaceAll('"', '""')}"`).get().count)]));
}

function publicSchemaInfo(schema) {
  if (!schema) return null;
  return {
    currentVersion: schema.currentVersion,
    supportedVersion: schema.supportedVersion,
    minimumCompatibleVersion: schema.minimumCompatibleVersion,
    compatible: schema.compatible,
    migrations: schema.migrations,
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function immutableSchemaEvidence(schema) {
  if (!schema) return null;
  return {
    currentVersion: schema.currentVersion,
    migrations: schema.migrations?.map((item) => ({ version: item.version, name: item.name, checksum: item.checksum, appliedAt: item.appliedAt })),
  };
}

export function backupDatabase({ databasePath, outputPath, manifestPath = `${outputPath}.manifest.json` }) {
  const source = path.resolve(databasePath);
  const target = path.resolve(outputPath);
  const manifest = path.resolve(manifestPath);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error("源数据库不存在或不是文件");
  if (source === target) throw new Error("备份文件不能覆盖源数据库");
  if (fs.existsSync(target) || fs.existsSync(manifest)) throw new Error("备份或清单已存在，拒绝覆盖");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  const db = new DatabaseSync(source);
  let counts;
  let checkpoint;
  let schema;
  try {
    const checks = integrity(db);
    if (checks.length !== 1 || checks[0] !== "ok") throw new Error(`源数据库完整性检查失败：${checks.join(",")}`);
    const violations = foreignKeyViolations(db);
    if (violations.length > 0) throw new Error(`源数据库外键检查失败：${violations.length}项`);
    schema = publicSchemaInfo(getDatabaseSchemaInfo(db));
    if (!schema.compatible) throw new Error("源数据库Schema与当前应用不兼容");
    checkpoint = db.prepare("PRAGMA wal_checkpoint(FULL)").get();
    counts = tableCounts(db);
    const escaped = target.replaceAll("'", "''");
    db.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    db.close();
  }
  const metadata = {
    format: BACKUP_FORMAT_V2,
    sourceDatabase: path.basename(source),
    backupFile: path.basename(target),
    createdAt: new Date().toISOString(),
    bytes: fs.statSync(target).size,
    sha256: sha256(target),
    schema,
    tableCounts: counts,
    checkpoint: { busy: Number(checkpoint.busy), log: Number(checkpoint.log), checkpointed: Number(checkpoint.checkpointed) },
  };
  fs.writeFileSync(manifest, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return { backupPath: target, manifestPath: manifest, metadata };
}

export function verifyDatabaseBackup({ backupPath, manifestPath = `${backupPath}.manifest.json` }) {
  const backup = path.resolve(backupPath);
  const manifest = path.resolve(manifestPath);
  if (!fs.existsSync(backup) || !fs.existsSync(manifest)) throw new Error("备份文件或清单不存在");
  const metadata = JSON.parse(fs.readFileSync(manifest, "utf8"));
  if (![BACKUP_FORMAT_V1, BACKUP_FORMAT_V2].includes(metadata.format)) throw new Error("备份清单格式不受支持");
  const actualHash = sha256(backup);
  if (actualHash !== metadata.sha256) throw new Error("备份SHA-256与清单不一致");
  if (fs.statSync(backup).size !== metadata.bytes) throw new Error("备份大小与清单不一致");
  const db = new DatabaseSync(backup, { readOnly: true });
  try {
    const checks = integrity(db);
    if (checks.length !== 1 || checks[0] !== "ok") throw new Error(`备份完整性检查失败：${checks.join(",")}`);
    const violations = foreignKeyViolations(db);
    if (violations.length > 0) throw new Error(`备份外键检查失败：${violations.length}项`);
    const counts = tableCounts(db);
    if (!sameJson(counts, metadata.tableCounts)) throw new Error("备份表计数与清单不一致");
    const schema = metadata.format === BACKUP_FORMAT_V2 ? publicSchemaInfo(getDatabaseSchemaInfo(db)) : null;
    if (metadata.format === BACKUP_FORMAT_V2 && !sameJson(immutableSchemaEvidence(schema), immutableSchemaEvidence(metadata.schema))) throw new Error("备份Schema信息与清单不一致");
    return {
      valid: true,
      format: metadata.format,
      legacyManifest: metadata.format === BACKUP_FORMAT_V1,
      backupPath: backup,
      manifestPath: manifest,
      sha256: actualHash,
      bytes: metadata.bytes,
      createdAt: metadata.createdAt ?? null,
      sourceDatabase: metadata.sourceDatabase ?? null,
      schema,
      tableCounts: counts,
    };
  } finally {
    db.close();
  }
}

export function restoreDatabaseBackup({ backupPath, manifestPath = `${backupPath}.manifest.json`, targetPath }) {
  const verified = verifyDatabaseBackup({ backupPath, manifestPath });
  const target = path.resolve(targetPath);
  if (fs.existsSync(target) || fs.existsSync(`${target}-wal`) || fs.existsSync(`${target}-shm`)) throw new Error("恢复目标或其WAL文件已存在，拒绝覆盖");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(verified.backupPath, target, fs.constants.COPYFILE_EXCL);
  let restoredSchema = verified.schema;
  try {
    const restored = new DatabaseSync(target);
    try {
      const checks = integrity(restored);
      if (checks.length !== 1 || checks[0] !== "ok") throw new Error("恢复后数据库完整性检查失败");
      const violations = foreignKeyViolations(restored);
      if (violations.length > 0) throw new Error(`恢复后数据库外键检查失败：${violations.length}项`);
      const counts = tableCounts(restored);
      if (!sameJson(counts, verified.tableCounts)) throw new Error("恢复后表计数不一致");
      if (!verified.legacyManifest) restoredSchema = publicSchemaInfo(getDatabaseSchemaInfo(restored));
    } finally {
      restored.close();
    }
  } catch (error) {
    fs.rmSync(target, { force: true });
    throw error;
  }
  return {
    restored: true,
    targetPath: target,
    sourceSha256: verified.sha256,
    schema: restoredSchema,
    legacyManifest: verified.legacyManifest,
    tableCounts: verified.tableCounts,
  };
}
