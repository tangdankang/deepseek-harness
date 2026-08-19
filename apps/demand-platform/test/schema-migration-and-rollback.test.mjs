import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CURRENT_SCHEMA_VERSION, getDatabaseSchemaInfo, openDatabase } from "../src/db.mjs";
import { runRollbackDrill, formatRollbackDrillMarkdown } from "../src/ops/rollback-drill.mjs";

test("新数据库建立不可变迁移账本并报告兼容版本", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-demand-schema-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "database.db");
  const db = openDatabase(databasePath);
  const info = getDatabaseSchemaInfo(db);
  assert.equal(info.currentVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(info.compatible, true);
  assert.equal(info.migrations.length, CURRENT_SCHEMA_VERSION);
  assert.match(info.migrations[0].checksum, /^[A-F0-9]{64}$/);
  db.close();
});

test("无迁移账本的旧数据库可就地接管且保留原数据", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-demand-legacy-schema-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "legacy.db");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec("CREATE TABLE legacy_marker (value TEXT NOT NULL); INSERT INTO legacy_marker VALUES ('preserved')");
  legacy.close();
  const adopted = openDatabase(databasePath);
  assert.equal(adopted.prepare("SELECT value FROM legacy_marker").get().value, "preserved");
  assert.equal(getDatabaseSchemaInfo(adopted).currentVersion, CURRENT_SCHEMA_VERSION);
  adopted.close();
});

test("启动拒绝被篡改的迁移记录", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-demand-tampered-schema-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "tampered.db");
  openDatabase(databasePath).close();
  const raw = new DatabaseSync(databasePath);
  raw.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run("0".repeat(64));
  raw.close();
  assert.throws(() => openDatabase(databasePath), (error) => error.code === "DATABASE_MIGRATION_TAMPERED");
});

test("旧版应用启动拒绝未来Schema版本", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-demand-future-schema-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "future.db");
  const raw = new DatabaseSync(databasePath);
  raw.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
  raw.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?)").run(999, "future", "F".repeat(64), new Date().toISOString());
  raw.close();
  assert.throws(() => openDatabase(databasePath), (error) => error.code === "DATABASE_SCHEMA_TOO_NEW");
});

test("隔离回滚演练恢复数据并通过HTTP可用性探针", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-demand-rollback-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source.db");
  const drill = path.join(directory, "drill");
  const db = openDatabase(source);
  db.prepare("INSERT INTO audit_events (case_id, actor_type, actor_id, action, outcome, details_json, trace_id, created_at) VALUES (NULL, 'SYSTEM', 'TEST', 'ROLLBACK_FIXTURE', 'SUCCESS', '{}', NULL, ?)").run(new Date().toISOString());
  db.close();
  const report = await runRollbackDrill({ databasePath: source, drillDirectory: drill });
  assert.equal(report.result, "PASS");
  assert.equal(report.database.schema.currentVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(report.database.tableCounts.audit_events, 1);
  assert.equal(report.database.tableCountsMatch, true);
  assert.equal(report.database.foreignKeyViolations, 0);
  assert.deepEqual(report.probes.map((item) => item.status), [200, 200]);
  assert.equal(JSON.stringify(report).includes(path.resolve(directory)), false);
  assert.match(formatRollbackDrillMarkdown(report), /演练结果：\*\*PASS\*\*/);
  await assert.rejects(() => runRollbackDrill({ databasePath: source, drillDirectory: drill }), /拒绝覆盖/);
});
