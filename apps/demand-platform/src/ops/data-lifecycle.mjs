import crypto from "node:crypto";
import { CURRENT_SCHEMA_VERSION } from "../db.mjs";
import { AppError } from "../domain/errors.mjs";

const DAY_MS = 86400000;
const HASH = /^[A-F0-9]{64}$/;
const CHANGE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{5,127}$/;
const HOLD_REASONS = new Set(["LEGAL_HOLD", "INVESTIGATION", "AUDIT", "INCIDENT", "BUSINESS_REQUIREMENT"]);

const RULES = Object.freeze({
  auth_sessions: Object.freeze({ dateColumn: "expires_at", extraWhere: "", category: "SECURITY_SESSION" }),
  operator_sessions: Object.freeze({ dateColumn: "expires_at", extraWhere: "", category: "SECURITY_SESSION" }),
  identity_ticket_uses: Object.freeze({ dateColumn: "expires_at", extraWhere: "", category: "IDENTITY_REPLAY_GUARD" }),
  tool_invocations: Object.freeze({ dateColumn: "created_at", extraWhere: "completed_at IS NOT NULL AND ", category: "TECHNICAL_AUDIT" }),
  assistant_interactions: Object.freeze({ dateColumn: "created_at", extraWhere: "", category: "PSEUDONYMIZED_ANALYTICS" }),
  employee_feedback: Object.freeze({ dateColumn: "created_at", extraWhere: "", category: "PSEUDONYMIZED_FEEDBACK" }),
  webhook_events: Object.freeze({ dateColumn: "received_at", extraWhere: "", category: "IDEMPOTENCY_GUARD" }),
});

const PROTECTED_TABLES = Object.freeze([
  "demand_cases",
  "external_tickets",
  "integration_tasks",
  "handoff_items",
  "audit_events",
  "audit_chain",
  "audit_chain_state",
  "service_items",
  "service_schemas",
  "knowledge_items",
  "knowledge_revisions",
  "data_lifecycle_runs",
  "data_retention_holds",
  "schema_migrations",
]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(message, details) {
  throw new AppError("INVALID_DATA_LIFECYCLE_POLICY", message, 400, details);
}

function allowedKeys(value, allowed, location) {
  if (!plainObject(value)) invalid(`${location}必须是对象`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) invalid(`${location}包含未知字段`, { location, unknown });
}

function retention(value, location) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 3650) invalid(`${location}必须为1至3650天的整数`);
  return number;
}

export function normalizeDataLifecyclePolicy(input) {
  allowedKeys(input, new Set(["version", "maxBackupAgeMinutes", "rules"]), "policy");
  if (input.version !== 1) invalid("policy.version必须为1");
  const maxBackupAgeMinutes = Number(input.maxBackupAgeMinutes ?? 60);
  if (!Number.isInteger(maxBackupAgeMinutes) || maxBackupAgeMinutes < 5 || maxBackupAgeMinutes > 1440) invalid("maxBackupAgeMinutes必须为5至1440的整数");
  allowedKeys(input.rules, new Set(Object.keys(RULES)), "policy.rules");
  const rules = {};
  for (const table of Object.keys(RULES)) {
    const rule = input.rules[table];
    if (!rule) invalid(`缺少数据生命周期规则：${table}`);
    allowedKeys(rule, new Set(["enabled", "retentionDays"]), `policy.rules.${table}`);
    if (typeof rule.enabled !== "boolean") invalid(`policy.rules.${table}.enabled必须是布尔值`);
    rules[table] = { enabled: rule.enabled, retentionDays: retention(rule.retentionDays, `policy.rules.${table}.retentionDays`) };
  }
  return { version: 1, maxBackupAgeMinutes, rules };
}

export function hashLifecycleActor(actorId, secret) {
  if (typeof actorId !== "string" || actorId.trim().length < 2 || actorId.length > 200) throw new AppError("INVALID_LIFECYCLE_ACTOR", "生命周期操作人标识格式无效", 400);
  if (typeof secret !== "string" || secret.length < 32) throw new AppError("INVALID_LIFECYCLE_HASH_SECRET", "生命周期操作人哈希密钥至少32位", 500);
  return crypto.createHmac("sha256", secret).update(actorId.trim()).digest("hex").toUpperCase();
}

function validateActorHash(value) {
  if (!HASH.test(value ?? "")) throw new AppError("INVALID_LIFECYCLE_ACTOR_HASH", "生命周期操作人哈希格式无效", 400);
}

function validateChangeRef(value) {
  if (!CHANGE_REF.test(value ?? "")) throw new AppError("INVALID_CHANGE_REFERENCE", "变更单号格式无效", 400);
}

function activeHolds(db) {
  return db.prepare("SELECT hold_id, scope, reason_code, change_ref, created_at FROM data_retention_holds WHERE active = 1 ORDER BY created_at, hold_id").all()
    .map((row) => ({ holdId: row.hold_id, scope: row.scope, reasonCode: row.reason_code, changeRef: row.change_ref, createdAt: row.created_at }));
}

function validateScope(scope) {
  if (scope !== "ALL" && !Object.hasOwn(RULES, scope)) throw new AppError("INVALID_RETENTION_HOLD_SCOPE", "保留冻结范围无效", 400, { allowed: ["ALL", ...Object.keys(RULES)] });
}

export function createDataRetentionHold({ db, scope, reasonCode, changeRef, actorHash, now = Date.now() }) {
  validateScope(scope);
  if (!HOLD_REASONS.has(reasonCode)) throw new AppError("INVALID_RETENTION_HOLD_REASON", "保留冻结原因无效", 400, { allowed: [...HOLD_REASONS] });
  validateChangeRef(changeRef);
  validateActorHash(actorHash);
  const duplicate = db.prepare("SELECT hold_id FROM data_retention_holds WHERE active = 1 AND scope = ? AND reason_code = ? AND change_ref = ?").get(scope, reasonCode, changeRef);
  if (duplicate) return { created: false, idempotentReplay: true, holdId: duplicate.hold_id, scope, reasonCode, changeRef };
  const holdId = crypto.randomUUID();
  db.prepare(`INSERT INTO data_retention_holds
    (hold_id, scope, reason_code, change_ref, created_by_hash, active, created_at, released_at, released_by_hash)
    VALUES (?, ?, ?, ?, ?, 1, ?, NULL, NULL)`)
    .run(holdId, scope, reasonCode, changeRef, actorHash, new Date(now).toISOString());
  return { created: true, idempotentReplay: false, holdId, scope, reasonCode, changeRef };
}

export function releaseDataRetentionHold({ db, holdId, changeRef, actorHash, now = Date.now() }) {
  if (typeof holdId !== "string" || !/^[0-9a-f-]{36}$/i.test(holdId)) throw new AppError("INVALID_RETENTION_HOLD_ID", "保留冻结编号无效", 400);
  validateChangeRef(changeRef);
  validateActorHash(actorHash);
  const hold = db.prepare("SELECT hold_id, scope, reason_code, active FROM data_retention_holds WHERE hold_id = ?").get(holdId);
  if (!hold) throw new AppError("RETENTION_HOLD_NOT_FOUND", "保留冻结不存在", 404);
  if (!hold.active) return { released: true, idempotentReplay: true, holdId, scope: hold.scope, reasonCode: hold.reason_code };
  db.prepare("UPDATE data_retention_holds SET active = 0, released_at = ?, released_by_hash = ? WHERE hold_id = ? AND active = 1")
    .run(new Date(now).toISOString(), actorHash, holdId);
  return { released: true, idempotentReplay: false, holdId, scope: hold.scope, reasonCode: hold.reason_code, changeRef };
}

function backupGate(backupEvidence, normalizedPolicy, now) {
  if (!backupEvidence?.valid || !backupEvidence.createdAt || !backupEvidence.sha256) throw new AppError("RECENT_BACKUP_REQUIRED", "执行清理前必须提供有效近期备份", 409);
  const created = new Date(backupEvidence.createdAt).getTime();
  const ageMinutes = (now - created) / 60000;
  if (!Number.isFinite(created) || ageMinutes < -5 || ageMinutes > normalizedPolicy.maxBackupAgeMinutes) {
    throw new AppError("RECENT_BACKUP_REQUIRED", "备份已过期或时间无效", 409, { maxBackupAgeMinutes: normalizedPolicy.maxBackupAgeMinutes });
  }
  if (Number(backupEvidence.schema?.currentVersion ?? -1) !== CURRENT_SCHEMA_VERSION) throw new AppError("BACKUP_SCHEMA_MISMATCH", "备份Schema版本与当前应用不一致", 409);
  return { createdAt: backupEvidence.createdAt, ageMinutes: Number(ageMinutes.toFixed(2)), sha256: backupEvidence.sha256 };
}

function countProtected(db) {
  const counts = {};
  for (const table of PROTECTED_TABLES) counts[table] = Number(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count);
  return counts;
}

function planRules(db, normalizedPolicy, holds, now) {
  const allHeld = holds.some((hold) => hold.scope === "ALL");
  return Object.entries(RULES).map(([table, definition]) => {
    const configured = normalizedPolicy.rules[table];
    const cutoff = new Date(now - configured.retentionDays * DAY_MS).toISOString();
    const where = `${definition.extraWhere}"${definition.dateColumn}" < ?`;
    const eligibleRows = Number(db.prepare(`SELECT COUNT(*) AS count FROM "${table}" WHERE ${where}`).get(cutoff).count);
    const held = allHeld || holds.some((hold) => hold.scope === table);
    return {
      table,
      category: definition.category,
      enabled: configured.enabled,
      retentionDays: configured.retentionDays,
      cutoff,
      eligibleRows,
      held,
      plannedRows: configured.enabled && !held ? eligibleRows : 0,
      deletedRows: 0,
    };
  });
}

function policyHash(policy) {
  return crypto.createHash("sha256").update(JSON.stringify(policy)).digest("hex").toUpperCase();
}

export function runDataLifecycle({ db, policy, mode = "DRY_RUN", allowDelete = false, approvedChangeRef = "", requestedByHash, backupEvidence, now = Date.now() }) {
  const normalizedPolicy = normalizeDataLifecyclePolicy(policy);
  validateActorHash(requestedByHash);
  if (!new Set(["DRY_RUN", "EXECUTE"]).has(mode)) throw new AppError("INVALID_LIFECYCLE_MODE", "生命周期模式必须为DRY_RUN或EXECUTE", 400);
  const hash = policyHash(normalizedPolicy);
  let backup = null;
  if (mode === "EXECUTE") {
    if (!allowDelete) throw new AppError("DATA_DELETION_NOT_AUTHORIZED", "执行数据清理必须显式允许删除", 403);
    validateChangeRef(approvedChangeRef);
    backup = backupGate(backupEvidence, normalizedPolicy, now);
  }
  const holds = activeHolds(db);
  let rules = planRules(db, normalizedPolicy, holds, now);
  const protectedRecords = countProtected(db);
  if (mode === "EXECUTE") {
    const runId = crypto.randomUUID();
    db.exec("BEGIN IMMEDIATE");
    try {
      const lockedHolds = activeHolds(db);
      rules = planRules(db, normalizedPolicy, lockedHolds, now);
      for (const item of rules) {
        if (!item.enabled || item.held) continue;
        const definition = RULES[item.table];
        const where = `${definition.extraWhere}"${definition.dateColumn}" < ?`;
        item.deletedRows = Number(db.prepare(`DELETE FROM "${item.table}" WHERE ${where}`).run(item.cutoff).changes);
        if (item.deletedRows !== item.plannedRows) throw new AppError("LIFECYCLE_PLAN_CHANGED", "生命周期候选数在执行期间发生变化", 409, { table: item.table });
      }
      const completedAt = new Date(now).toISOString();
      const summary = { rules: rules.map(({ table, eligibleRows, held, deletedRows }) => ({ table, eligibleRows, held, deletedRows })), protectedRecords };
      db.prepare(`INSERT INTO data_lifecycle_runs
        (run_id, mode, policy_hash, requested_by_hash, approved_change_ref, outcome, summary_json, created_at, completed_at)
        VALUES (?, 'EXECUTE', ?, ?, ?, 'SUCCESS', ?, ?, ?)`)
        .run(runId, hash, requestedByHash, approvedChangeRef, JSON.stringify(summary), completedAt, completedAt);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const integrity = db.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]);
  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
  return {
    reportType: "AI_DEMAND_PLATFORM_DATA_LIFECYCLE",
    reportVersion: "1.0",
    outcome: integrity.length === 1 && integrity[0] === "ok" && foreignKeyViolations === 0 ? "PASS" : "FAIL",
    mode,
    policyHash: hash,
    approvedChangeRef: mode === "EXECUTE" ? approvedChangeRef : null,
    evaluatedAt: new Date(now).toISOString(),
    backup,
    activeHolds: holds.map(({ scope, reasonCode, changeRef, createdAt }) => ({ scope, reasonCode, changeRef, createdAt })),
    rules,
    protectedRecords,
    integrity,
    foreignKeyViolations,
    summary: {
      eligibleRows: rules.reduce((total, item) => total + item.eligibleRows, 0),
      plannedRows: rules.reduce((total, item) => total + item.plannedRows, 0),
      deletedRows: rules.reduce((total, item) => total + item.deletedRows, 0),
      heldRules: rules.filter((item) => item.held).length,
      disabledRules: rules.filter((item) => !item.enabled).length,
    },
    safety: { businessTablesDeleted: false, auditEventsDeleted: false, rawActorStoredInReport: false, absolutePathsStoredInReport: false },
  };
}

export function dataLifecycleMarkdown(report) {
  const rows = report.rules.map((item) => `| ${item.table} | ${item.enabled ? "启用" : "禁用"} | ${item.retentionDays} | ${item.eligibleRows} | ${item.held ? "是" : "否"} | ${item.plannedRows} | ${item.deletedRows} |`).join("\n");
  const protectedRows = Object.entries(report.protectedRecords).map(([table, count]) => `| ${table} | ${count} |`).join("\n");
  return `# AI统一需求平台数据生命周期报告

- 结果：**${report.outcome}**
- 模式：${report.mode}
- 策略SHA-256：${report.policyHash}
- 变更单：${report.approvedChangeRef ?? "不适用（预演）"}
- 候选/计划/实际删除：${report.summary.eligibleRows}/${report.summary.plannedRows}/${report.summary.deletedRows}
- 生效冻结规则：${report.summary.heldRules}
- 禁用规则：${report.summary.disabledRules}
- 完整性：${report.integrity.join(", ")}
- 外键违规：${report.foreignKeyViolations}

| 表 | 策略 | 保留天数 | 到期候选 | 冻结 | 计划删除 | 实际删除 |
|---|---|---:|---:|---|---:|---:|
${rows}

## 受保护数据（本工具不会删除）

| 表 | 记录数 |
|---|---:|
${protectedRows}

## 安全边界

- 预演不删除任何记录；执行需要双重授权、近期已校验备份和变更单。
- 需求、工单、人工转接、审计、服务目录、知识和治理记录不在自动删除白名单。
- 全局或表级保留冻结会使对应规则跳过。
- 报告不包含原始操作人、记录正文、密钥或文件绝对路径。
`;
}
