import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CURRENT_SCHEMA_VERSION, openDatabase } from "../src/db.mjs";
import { backupDatabase, verifyDatabaseBackup, restoreDatabaseBackup } from "../src/ops/database-backup.mjs";

test("SQLite试点数据库可在线备份、校验并恢复到不存在的新目标", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-demand-backup-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source.db");
  const backup = path.join(directory, "backup", "snapshot.db");
  const restored = path.join(directory, "restore", "restored.db");
  const db = openDatabase(source);
  db.prepare("INSERT INTO audit_events (case_id, actor_type, actor_id, action, outcome, details_json, trace_id, created_at) VALUES (NULL, 'SYSTEM', 'TEST', 'BACKUP_FIXTURE', 'SUCCESS', '{}', NULL, ?)").run(new Date().toISOString());
  db.close();

  const created = backupDatabase({ databasePath: source, outputPath: backup });
  assert.equal(fs.existsSync(created.backupPath), true);
  assert.equal(fs.existsSync(created.manifestPath), true);
  assert.equal(created.metadata.tableCounts.audit_events, 1);
  assert.equal(created.metadata.format, "ai-demand-platform-sqlite-backup-v2");
  assert.equal(created.metadata.schema.currentVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(created.metadata.schema.compatible, true);
  const verified = verifyDatabaseBackup({ backupPath: backup });
  assert.equal(verified.valid, true);
  assert.equal(verified.legacyManifest, false);
  assert.equal(verified.schema.currentVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(verified.sha256.length, 64);

  const result = restoreDatabaseBackup({ backupPath: backup, targetPath: restored });
  assert.equal(result.restored, true);
  const restoredDb = new DatabaseSync(restored, { readOnly: true });
  assert.equal(restoredDb.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 1);
  restoredDb.close();
  assert.throws(() => restoreDatabaseBackup({ backupPath: backup, targetPath: restored }), /拒绝覆盖/);
});

test("备份校验拒绝被篡改的文件", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-demand-backup-tamper-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source.db");
  const backup = path.join(directory, "snapshot.db");
  openDatabase(source).close();
  backupDatabase({ databasePath: source, outputPath: backup });
  fs.appendFileSync(backup, Buffer.from([0]));
  assert.throws(() => verifyDatabaseBackup({ backupPath: backup }), /SHA-256/);
});

test("备份校验拒绝被篡改的Schema清单", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-demand-backup-schema-tamper-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source.db");
  const backup = path.join(directory, "snapshot.db");
  openDatabase(source).close();
  const created = backupDatabase({ databasePath: source, outputPath: backup });
  const manifest = JSON.parse(fs.readFileSync(created.manifestPath, "utf8"));
  manifest.schema.currentVersion = 999;
  fs.writeFileSync(created.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(() => verifyDatabaseBackup({ backupPath: backup }), /Schema/);
});

test("仍可校验和恢复v1旧清单", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-demand-backup-v1-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source.db");
  const backup = path.join(directory, "snapshot.db");
  const restored = path.join(directory, "restored.db");
  openDatabase(source).close();
  const created = backupDatabase({ databasePath: source, outputPath: backup });
  const manifest = JSON.parse(fs.readFileSync(created.manifestPath, "utf8"));
  manifest.format = "ai-demand-platform-sqlite-backup-v1";
  delete manifest.schema;
  fs.writeFileSync(created.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const verified = verifyDatabaseBackup({ backupPath: backup });
  assert.equal(verified.valid, true);
  assert.equal(verified.legacyManifest, true);
  assert.equal(verified.schema, null);
  const result = restoreDatabaseBackup({ backupPath: backup, targetPath: restored });
  assert.equal(result.restored, true);
  assert.equal(result.legacyManifest, true);
});

test("应用升级后仍接受v2清单中旧版应用能力元数据", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-demand-backup-old-app-metadata-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source.db");
  const backup = path.join(directory, "snapshot.db");
  openDatabase(source).close();
  const created = backupDatabase({ databasePath: source, outputPath: backup });
  const manifest = JSON.parse(fs.readFileSync(created.manifestPath, "utf8"));
  manifest.schema.supportedVersion = 1;
  manifest.schema.minimumCompatibleVersion = 1;
  manifest.schema.compatible = false;
  fs.writeFileSync(created.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const verified = verifyDatabaseBackup({ backupPath: backup });
  assert.equal(verified.valid, true);
  assert.equal(verified.schema.currentVersion, CURRENT_SCHEMA_VERSION);
});
