import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.mjs";
import { AuditService } from "../src/services/audit-service.mjs";
import { createApplication } from "../src/server.mjs";

const SECRET = "audit-integrity-test-secret-long-enough";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function directAudit(db, action = "LEGACY_EVENT") {
  db.prepare("INSERT INTO audit_events (case_id, actor_type, actor_id, action, outcome, details_json, trace_id, created_at) VALUES (NULL, 'SYSTEM', 'LEGACY', ?, 'SUCCESS', '{}', NULL, ?)")
    .run(action, "2026-08-17T08:00:00.000Z");
}

test("审计事件与HMAC链在同一事务写入并可验证", () => {
  const db = openDatabase(":memory:", { seedDemo: false });
  const audit = new AuditService({ db, secret: SECRET, now: () => new Date("2026-08-17T08:00:00.000Z") });
  audit.record({ actorType: "EMPLOYEE", actorId: "E-AUDIT-1", action: "CREATE_DRAFT", details: { fieldNames: ["reason"], token: "must-redact" } });
  audit.record({ actorType: "SYSTEM", actorId: "CRM", action: "CREATE_EXTERNAL_TICKET", details: { ticketNo: "T-1" } });
  const report = audit.assertIntegrity();
  assert.equal(report.outcome, "PASS");
  assert.equal(report.eventCount, 2);
  assert.equal(report.chainCount, 2);
  assert.equal(report.liveCount, 2);
  assert.equal(report.legacyBackfillCount, 0);
  assert.match(report.headHash, /^[A-F0-9]{64}$/);
  assert.equal(report.safety.containsAuditPayload, false);
  assert.throws(() => db.prepare("DELETE FROM audit_chain_state WHERE state_id = 1").run(), /immutable/);
  assert.throws(() => db.prepare("UPDATE audit_chain_state SET key_version = 2 WHERE state_id = 1").run(), /immutable/);
  assert.throws(() => db.prepare("DELETE FROM audit_events WHERE audit_id = 1").run(), /FOREIGN KEY/);
  const persisted = JSON.stringify(db.prepare("SELECT * FROM audit_chain ORDER BY audit_id").all());
  assert.equal(persisted.includes("E-AUDIT-1"), false);
  assert.equal(persisted.includes("must-redact"), false);
  assert.equal(db.prepare("SELECT details_json FROM audit_events WHERE audit_id = 1").get().details_json.includes("must-redact"), false);
  db.close();
});

test("事件内容篡改、缺链和错误密钥均阻止完整性接管", () => {
  const db = openDatabase(":memory:", { seedDemo: false });
  const audit = new AuditService({ db, secret: SECRET });
  audit.record({ actorType: "SYSTEM", actorId: "TEST", action: "ORIGINAL_EVENT", details: { value: 1 } });
  db.prepare("UPDATE audit_events SET action = 'TAMPERED_EVENT' WHERE audit_id = 1").run();
  assert.equal(audit.verify().finding, "EVENT_HASH_MISMATCH");
  assert.throws(() => new AuditService({ db, secret: SECRET }), (error) => error.code === "AUDIT_CHAIN_TAMPERED");
  db.prepare("UPDATE audit_events SET action = 'ORIGINAL_EVENT' WHERE audit_id = 1").run();
  assert.equal(audit.assertIntegrity().outcome, "PASS");
  assert.throws(() => new AuditService({ db, secret: "different-audit-integrity-secret-long" }), (error) => error.code === "AUDIT_CHAIN_TAMPERED");
  db.prepare("DELETE FROM audit_chain WHERE audit_id = 1").run();
  assert.throws(() => new AuditService({ db, secret: SECRET }), (error) => error.code === "AUDIT_CHAIN_INCOMPLETE");
  db.close();
});

test("旧审计只允许显式一次性锚定，后续事件进入LIVE链", () => {
  const db = openDatabase(":memory:", { seedDemo: false });
  directAudit(db);
  assert.throws(() => new AuditService({ db, secret: SECRET, allowLegacyBackfill: false }), (error) => error.code === "AUDIT_CHAIN_LEGACY_ANCHOR_REQUIRED");
  const audit = new AuditService({ db, secret: SECRET, allowLegacyBackfill: true });
  assert.equal(audit.startupReport.legacyRowsAnchoredThisStartup, 1);
  audit.record({ actorType: "SYSTEM", actorId: "TEST", action: "LIVE_EVENT" });
  const report = audit.assertIntegrity();
  assert.equal(report.legacyBackfillCount, 1);
  assert.equal(report.liveCount, 1);
  assert.deepEqual(db.prepare("SELECT chain_mode FROM audit_chain ORDER BY audit_id").all().map((row) => row.chain_mode), ["LEGACY_BACKFILL", "LIVE"]);
  db.close();
});

test("外层业务事务回滚时审计事件和链记录共同回滚", () => {
  const db = openDatabase(":memory:", { seedDemo: false });
  const audit = new AuditService({ db, secret: SECRET });
  db.exec("BEGIN IMMEDIATE");
  audit.record({ actorType: "SYSTEM", actorId: "TEST", action: "ROLLBACK_EVENT" });
  db.exec("ROLLBACK");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count), 0);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM audit_chain").get().count), 0);
  assert.equal(audit.assertIntegrity().outcome, "PASS");
  db.close();
});

test("运营完整性端点先校验再把本次验证写入审计链", async (t) => {
  const adminApiKey = "audit-integrity-admin-key-long-enough";
  const app = createApplication({ databasePath: ":memory:", adminApiKey, auditChainSecret: SECRET });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  app.services.audit.record({ actorType: "SYSTEM", actorId: "TEST", action: "BEFORE_VERIFY", details: { confidential: "not-in-report" } });
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/v1/admin/audit-integrity`, { headers: { "X-Admin-Key": adminApiKey, "X-Admin-Id": "AUDITOR-1" } });
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.outcome, "PASS");
  assert.equal(report.eventCount, 2);
  assert.equal(JSON.stringify(report).includes("AUDITOR-1"), false);
  assert.equal(JSON.stringify(report).includes("not-in-report"), false);
  assert.equal(app.db.prepare("SELECT action FROM audit_events ORDER BY audit_id DESC LIMIT 1").get().action, "VERIFY_AUDIT_CHAIN");
});

test("CLI默认拒绝旧记录锚定，双重授权和变更单后可执行且可重复只读校验", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-chain-cli-"));
  const database = path.join(root, "audit.db");
  const db = openDatabase(database, { seedDemo: false });
  directAudit(db);
  db.close();
  const env = { ...process.env, AUDIT_CHAIN_SECRET: SECRET, NODE_NO_WARNINGS: "1" };
  const denied = spawnSync(process.execPath, ["scripts/verify-audit-chain.mjs", "--database", database], { cwd: projectRoot, env, encoding: "utf8" });
  assert.equal(denied.status, 1);
  assert.equal(JSON.parse(denied.stderr).error.code, "AUDIT_CHAIN_LEGACY_ANCHOR_REQUIRED");
  const anchored = spawnSync(process.execPath, ["scripts/verify-audit-chain.mjs", "--database", database, "--allow-legacy-anchor", "--approved-change-ref", "CHG-2026-1001"], { cwd: projectRoot, env, encoding: "utf8" });
  assert.equal(anchored.status, 0, anchored.stderr);
  const report = JSON.parse(anchored.stdout);
  assert.equal(report.outcome, "PASS");
  assert.equal(report.legacyRowsAnchoredThisRun, 1);
  assert.equal(report.legacyBackfillCount, 1);
  assert.equal(report.liveCount, 1);
  const verified = spawnSync(process.execPath, ["scripts/verify-audit-chain.mjs", "--database", database], { cwd: projectRoot, env, encoding: "utf8" });
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).legacyRowsAnchoredThisRun, 0);
});
