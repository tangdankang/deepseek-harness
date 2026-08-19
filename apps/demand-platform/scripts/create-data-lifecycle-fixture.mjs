import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "../src/db.mjs";

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const target = path.resolve(option("--output"));
if (!option("--output")) throw new Error("必须提供--output");
if (fs.existsSync(target)) throw new Error("夹具数据库已存在，拒绝覆盖");
const old = "2025-01-01T00:00:00.000Z";
const recent = new Date(Date.now() - 86400000).toISOString();
const db = openDatabase(target, { seedDemo: false });
try {
  db.prepare("INSERT INTO auth_sessions (session_id_hash, employee_id, department_id, department_ids_json, employee_name, csrf_token, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)").run("fixture-old-auth", "FIXTURE-OLD", "FIXTURE-DEPT", '[\"FIXTURE-DEPT\"]', "Fixture", "csrf", old, old);
  db.prepare("INSERT INTO auth_sessions (session_id_hash, employee_id, department_id, department_ids_json, employee_name, csrf_token, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)").run("fixture-recent-auth", "FIXTURE-RECENT", "FIXTURE-DEPT", '[\"FIXTURE-DEPT\"]', "Fixture", "csrf", recent, recent);
  db.prepare("INSERT INTO operator_sessions VALUES (?, ?, ?, ?, ?, ?, ?, NULL)").run("fixture-old-operator", "FIXTURE-OP", "Fixture", "[]", "csrf", old, old);
  db.prepare("INSERT INTO identity_ticket_uses VALUES (?, ?, ?, ?, ?, ?)").run("fixture-old-ticket", "FIXTURE-OLD", "issuer", "audience", old, old);
  db.prepare("INSERT INTO tool_invocations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("fixture-old-tool", "search_knowledge", "HASH", "FIXTURE-DEPT", "SUCCESS", 200, null, 1, "fixture-trace", old, old);
  db.prepare("INSERT INTO tool_invocations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)").run("fixture-incomplete-tool", "search_knowledge", "HASH", "FIXTURE-DEPT", "STARTED", null, null, null, "fixture-incomplete", old);
  db.prepare("INSERT INTO assistant_interactions VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?)").run("fixture-old-interaction", "HASH", "FIXTURE-DEPT", "ANSWER", "MSG", 1, 0, "[]", old);
  db.prepare("INSERT INTO employee_feedback VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)").run("fixture-old-feedback", "HASH", "CASE", "FIXTURE-SUBJECT", 1, "[]", "fixture-feedback-key", "fixture-fingerprint", old);
  db.prepare("INSERT INTO webhook_events VALUES (?, ?, ?, ?)").run("CRM", "fixture-old-event", "HASH", old);
  db.prepare("INSERT INTO audit_events (case_id, actor_type, actor_id, action, outcome, details_json, trace_id, created_at) VALUES (NULL, 'SYSTEM', 'FIXTURE', 'PROTECTED_AUDIT', 'SUCCESS', '{}', NULL, ?)").run(old);
} finally { db.close(); }
console.log(JSON.stringify({ created: true, database: path.basename(target), containsRealData: false }, null, 2));
