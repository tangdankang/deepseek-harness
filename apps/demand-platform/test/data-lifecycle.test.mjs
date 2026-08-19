import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CURRENT_SCHEMA_VERSION, openDatabase } from "../src/db.mjs";
import { createDataRetentionHold, hashLifecycleActor, normalizeDataLifecyclePolicy, releaseDataRetentionHold, runDataLifecycle } from "../src/ops/data-lifecycle.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const policy = JSON.parse(fs.readFileSync(path.join(projectRoot, "config", "data-lifecycle-policy.example.json"), "utf8"));
const now = Date.parse("2026-08-13T12:00:00.000Z");
const old = "2025-01-01T00:00:00.000Z";
const recent = "2026-08-12T00:00:00.000Z";
const actorHash = hashLifecycleActor("DATA-STEWARD-001", "data-lifecycle-test-hash-secret-long-enough");

function fixtureDb() {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO auth_sessions (session_id_hash, employee_id, department_id, department_ids_json, employee_name, csrf_token, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)").run("old-auth", "E-OLD", "D-OLD", '[\"D-OLD\"]', "Old", "csrf", old, old);
  db.prepare("INSERT INTO auth_sessions (session_id_hash, employee_id, department_id, department_ids_json, employee_name, csrf_token, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)").run("new-auth", "E-NEW", "D-NEW", '[\"D-NEW\"]', "New", "csrf", recent, recent);
  db.prepare("INSERT INTO operator_sessions VALUES (?, ?, ?, ?, ?, ?, ?, NULL)").run("old-operator", "OP-OLD", "Old", "[]", "csrf", old, old);
  db.prepare("INSERT INTO identity_ticket_uses VALUES (?, ?, ?, ?, ?, ?)").run("old-ticket", "E-OLD", "issuer", "audience", old, old);
  db.prepare("INSERT INTO tool_invocations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("old-tool", "search_knowledge", "HASH", "D", "SUCCESS", 200, null, 1, "trace-old", old, old);
  db.prepare("INSERT INTO tool_invocations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)").run("incomplete-tool", "search_knowledge", "HASH", "D", "STARTED", null, null, null, "trace-incomplete", old);
  db.prepare("INSERT INTO assistant_interactions VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?)").run("old-interaction", "HASH", "D", "ANSWER", "MSG", 1, 0, "[]", old);
  db.prepare("INSERT INTO employee_feedback VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)").run("old-feedback", "HASH", "CASE", "REQ-OLD", 1, "[]", "feedback-key", "fingerprint", old);
  db.prepare("INSERT INTO webhook_events VALUES (?, ?, ?, ?)").run("CRM", "old-event", "HASH", old);
  db.prepare("INSERT INTO audit_events (case_id, actor_type, actor_id, action, outcome, details_json, trace_id, created_at) VALUES (NULL, 'SYSTEM', 'TEST', 'PROTECTED_AUDIT', 'SUCCESS', '{}', NULL, ?)").run(old);
  return db;
}

function backupEvidence() {
  return { valid: true, createdAt: new Date(now - 5 * 60000).toISOString(), sha256: "A".repeat(64), schema: { currentVersion: CURRENT_SCHEMA_VERSION } };
}

test("生命周期预演统计到期记录但不修改数据库和审计", () => {
  const db = fixtureDb();
  const before = Number(db.prepare("SELECT COUNT(*) AS count FROM tool_invocations").get().count);
  const report = runDataLifecycle({ db, policy, requestedByHash: actorHash, now });
  assert.equal(report.outcome, "PASS");
  assert.equal(report.mode, "DRY_RUN");
  assert.equal(report.summary.eligibleRows, 7);
  assert.equal(report.summary.plannedRows, 4);
  assert.equal(report.summary.deletedRows, 0);
  assert.equal(report.summary.disabledRules, 3);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM tool_invocations").get().count), before);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM data_lifecycle_runs").get().count), 0);
  assert.equal(report.protectedRecords.audit_events, 1);
  assert.equal(JSON.stringify(report).includes("DATA-STEWARD-001"), false);
  db.close();
});

test("表级保留冻结阻止删除，解除后近期备份和变更单允许受控清理", () => {
  const db = fixtureDb();
  const hold = createDataRetentionHold({ db, scope: "tool_invocations", reasonCode: "AUDIT", changeRef: "CHG-20260813-001", actorHash, now });
  assert.equal(hold.created, true);
  assert.equal(createDataRetentionHold({ db, scope: "tool_invocations", reasonCode: "AUDIT", changeRef: "CHG-20260813-001", actorHash, now }).idempotentReplay, true);
  const first = runDataLifecycle({ db, policy, mode: "EXECUTE", allowDelete: true, approvedChangeRef: "CHG-20260813-002", requestedByHash: actorHash, backupEvidence: backupEvidence(), now });
  assert.equal(first.outcome, "PASS");
  assert.equal(first.summary.deletedRows, 3);
  assert.equal(first.rules.find((item) => item.table === "tool_invocations").held, true);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM tool_invocations WHERE invocation_id = 'old-tool'").get().count), 1);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM assistant_interactions").get().count), 1);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count), 1);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM data_lifecycle_runs").get().count), 1);

  const released = releaseDataRetentionHold({ db, holdId: hold.holdId, changeRef: "CHG-20260813-003", actorHash, now: now + 1000 });
  assert.equal(released.released, true);
  assert.equal(releaseDataRetentionHold({ db, holdId: hold.holdId, changeRef: "CHG-20260813-003", actorHash, now: now + 2000 }).idempotentReplay, true);
  const second = runDataLifecycle({ db, policy, mode: "EXECUTE", allowDelete: true, approvedChangeRef: "CHG-20260813-004", requestedByHash: actorHash, backupEvidence: backupEvidence(), now });
  assert.equal(second.summary.deletedRows, 1);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM tool_invocations").get().count), 1);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM data_lifecycle_runs").get().count), 2);
  db.close();
});

test("生命周期执行拒绝缺少删除授权、近期备份和无效策略", () => {
  const db = fixtureDb();
  assert.throws(() => runDataLifecycle({ db, policy, mode: "EXECUTE", requestedByHash: actorHash, approvedChangeRef: "CHG-20260813-010", backupEvidence: backupEvidence(), now }), (error) => error.code === "DATA_DELETION_NOT_AUTHORIZED");
  assert.throws(() => runDataLifecycle({ db, policy, mode: "EXECUTE", allowDelete: true, requestedByHash: actorHash, approvedChangeRef: "CHG-20260813-010", backupEvidence: { ...backupEvidence(), createdAt: "2020-01-01T00:00:00.000Z" }, now }), (error) => error.code === "RECENT_BACKUP_REQUIRED");
  const invalid = structuredClone(policy);
  invalid.rules.audit_events = { enabled: true, retentionDays: 1 };
  assert.throws(() => normalizeDataLifecyclePolicy(invalid), (error) => error.code === "INVALID_DATA_LIFECYCLE_POLICY");
  assert.throws(() => createDataRetentionHold({ db, scope: "audit_events", reasonCode: "AUDIT", changeRef: "CHG-20260813-011", actorHash, now }), (error) => error.code === "INVALID_RETENTION_HOLD_SCOPE");
  db.close();
});
