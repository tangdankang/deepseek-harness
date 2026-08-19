import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AppError } from "./domain/errors.mjs";

const nowIso = () => new Date().toISOString();

export function openDatabase(databasePath = ":memory:", options = {}) {
  if (databasePath !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    migrate(db);
    if (options.seedDemo !== false) seed(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const BASELINE_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS service_items (
      service_code TEXT PRIMARY KEY,
      service_name TEXT NOT NULL,
      domain_code TEXT NOT NULL,
      owner_team TEXT NOT NULL,
      description TEXT NOT NULL,
      target_system TEXT NOT NULL,
      target_ticket_type TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      ai_policy_json TEXT NOT NULL,
      keywords_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS service_schemas (
      service_code TEXT NOT NULL,
      version INTEGER NOT NULL,
      schema_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (service_code, version),
      FOREIGN KEY (service_code) REFERENCES service_items(service_code)
    );
    CREATE TABLE IF NOT EXISTS knowledge_items (
      knowledge_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      patterns_json TEXT NOT NULL,
      answer TEXT NOT NULL,
      source_title TEXT NOT NULL,
      source_url TEXT NOT NULL,
      allowed_departments_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS counters (
      counter_name TEXT PRIMARY KEY,
      counter_value INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS demand_cases (
      case_id TEXT PRIMARY KEY,
      global_request_no TEXT NOT NULL UNIQUE,
      requester_employee_id TEXT NOT NULL,
      requester_department_id TEXT NOT NULL,
      requester_name TEXT NOT NULL,
      conversation_id TEXT,
      service_code TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      fields_json TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      confirmation_version INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (service_code) REFERENCES service_items(service_code)
    );
    CREATE TABLE IF NOT EXISTS external_tickets (
      external_ticket_id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      system_code TEXT NOT NULL,
      ticket_no TEXT NOT NULL,
      raw_status TEXT NOT NULL,
      unified_status TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      ticket_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (system_code, ticket_no),
      FOREIGN KEY (case_id) REFERENCES demand_cases(case_id)
    );
    CREATE TABLE IF NOT EXISTS integration_tasks (
      task_id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      system_code TEXT NOT NULL,
      draft_version INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL,
      next_attempt_at TEXT NOT NULL,
      lock_until TEXT,
      last_error_code TEXT,
      last_error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (case_id) REFERENCES demand_cases(case_id)
    );
    CREATE TABLE IF NOT EXISTS webhook_events (
      source_system TEXT NOT NULL,
      event_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      received_at TEXT NOT NULL,
      PRIMARY KEY (source_system, event_id)
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      details_json TEXT NOT NULL,
      trace_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS handoff_items (
      handoff_id TEXT PRIMARY KEY,
      handoff_no TEXT NOT NULL UNIQUE,
      requester_employee_id TEXT NOT NULL,
      requester_department_id TEXT NOT NULL,
      requester_name TEXT NOT NULL,
      conversation_id TEXT,
      reason_code TEXT NOT NULL,
      queue_code TEXT NOT NULL,
      summary TEXT NOT NULL,
      original_message TEXT NOT NULL,
      status TEXT NOT NULL,
      assigned_to TEXT,
      resolution_summary TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      request_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assistant_interactions (
      interaction_id TEXT PRIMARY KEY,
      employee_hash TEXT NOT NULL,
      department_id TEXT NOT NULL,
      conversation_id TEXT,
      response_type TEXT NOT NULL,
      message_hash TEXT NOT NULL,
      message_length INTEGER NOT NULL,
      citations_count INTEGER NOT NULL,
      suggested_services_json TEXT NOT NULL,
      trace_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS employee_feedback (
      feedback_id TEXT PRIMARY KEY,
      employee_hash TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      resolved INTEGER NOT NULL,
      rating INTEGER,
      reason_codes_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      request_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (employee_hash, subject_type, subject_id)
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      session_id_hash TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      department_id TEXT NOT NULL,
      employee_name TEXT NOT NULL,
      csrf_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS identity_ticket_uses (
      ticket_id_hash TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      issuer TEXT NOT NULL,
      audience TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operator_sessions (
      session_id_hash TEXT PRIMARY KEY,
      operator_id TEXT NOT NULL,
      operator_name TEXT NOT NULL,
      roles_json TEXT NOT NULL,
      csrf_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tool_invocations (
      invocation_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      employee_hash TEXT NOT NULL,
      department_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      http_status INTEGER,
      error_code TEXT,
      duration_ms INTEGER,
      trace_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cases_requester ON demand_cases(requester_employee_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cases_status ON demand_cases(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_integration_tasks_due ON integration_tasks(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_integration_tasks_case ON integration_tasks(case_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_case ON audit_events(case_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_handoffs_requester ON handoff_items(requester_employee_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_handoffs_status ON handoff_items(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_interactions_created ON assistant_interactions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_feedback_created ON employee_feedback(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_employee ON auth_sessions(employee_id, expires_at DESC);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_identity_ticket_uses_expiry ON identity_ticket_uses(expires_at);
    CREATE INDEX IF NOT EXISTS idx_operator_sessions_operator ON operator_sessions(operator_id, expires_at DESC);
    CREATE INDEX IF NOT EXISTS idx_operator_sessions_expiry ON operator_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_tool_invocations_created ON tool_invocations(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tool_invocations_operation ON tool_invocations(operation_id, outcome, created_at DESC);
    INSERT OR IGNORE INTO counters (counter_name, counter_value) VALUES ('request', 0);
    INSERT OR IGNORE INTO counters (counter_name, counter_value) VALUES ('handoff', 0);
  `;

const DATA_LIFECYCLE_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS data_lifecycle_runs (
      run_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      policy_hash TEXT NOT NULL,
      requested_by_hash TEXT NOT NULL,
      approved_change_ref TEXT NOT NULL,
      outcome TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS data_retention_holds (
      hold_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      change_ref TEXT NOT NULL,
      created_by_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      released_at TEXT,
      released_by_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_lifecycle_runs_created ON data_lifecycle_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_retention_holds_active ON data_retention_holds(active, scope, created_at DESC);
  `;

const AUDIT_CHAIN_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS audit_chain (
      audit_id INTEGER PRIMARY KEY,
      previous_hash TEXT NOT NULL,
      event_hash TEXT NOT NULL UNIQUE,
      key_version INTEGER NOT NULL,
      chain_mode TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      FOREIGN KEY (audit_id) REFERENCES audit_events(audit_id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS audit_chain_state (
      state_id INTEGER PRIMARY KEY CHECK (state_id = 1),
      initialized_at TEXT NOT NULL,
      initial_event_count INTEGER NOT NULL,
      key_version INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS trg_audit_chain_state_no_delete
      BEFORE DELETE ON audit_chain_state
      BEGIN SELECT RAISE(ABORT, 'audit_chain_state is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_audit_chain_state_no_update
      BEFORE UPDATE ON audit_chain_state
      BEGIN SELECT RAISE(ABORT, 'audit_chain_state is immutable'); END;
    CREATE INDEX IF NOT EXISTS idx_audit_chain_hash ON audit_chain(event_hash);
  `;

const KNOWLEDGE_GOVERNANCE_SCHEMA_SQL = `
    ALTER TABLE knowledge_items ADD COLUMN current_version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE knowledge_items ADD COLUMN owner_team TEXT NOT NULL DEFAULT 'LEGACY_UNASSIGNED';
    ALTER TABLE knowledge_items ADD COLUMN source_content_sha256 TEXT;
    ALTER TABLE knowledge_items ADD COLUMN reviewed_at TEXT;
    ALTER TABLE knowledge_items ADD COLUMN expires_at TEXT;
    CREATE TABLE IF NOT EXISTS knowledge_revisions (
      knowledge_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      definition_json TEXT NOT NULL,
      definition_sha256 TEXT NOT NULL,
      source_content_sha256 TEXT NOT NULL,
      change_ref TEXT NOT NULL,
      imported_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (knowledge_id, version),
      FOREIGN KEY (knowledge_id) REFERENCES knowledge_items(knowledge_id) ON DELETE RESTRICT
    );
    CREATE TRIGGER IF NOT EXISTS trg_knowledge_revisions_no_delete
      BEFORE DELETE ON knowledge_revisions
      BEGIN SELECT RAISE(ABORT, 'knowledge_revisions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_knowledge_revisions_no_update
      BEFORE UPDATE ON knowledge_revisions
      BEGIN SELECT RAISE(ABORT, 'knowledge_revisions are immutable'); END;
    CREATE INDEX IF NOT EXISTS idx_knowledge_enabled_expiry ON knowledge_items(enabled, expires_at);
  `;

const SERVICE_AUDIENCE_SCHEMA_SQL = `
    ALTER TABLE service_items ADD COLUMN audience_policy_json TEXT NOT NULL DEFAULT '{"visibility":"ALL_EMPLOYEES","departmentIds":[]}';
  `;

const SERVICE_REVISION_SCHEMA_SQL = `
    ALTER TABLE service_items ADD COLUMN current_revision INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS service_revisions (
      service_code TEXT NOT NULL,
      revision INTEGER NOT NULL,
      schema_version INTEGER NOT NULL,
      definition_json TEXT NOT NULL,
      definition_sha256 TEXT NOT NULL,
      change_ref TEXT NOT NULL,
      imported_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (service_code, revision),
      FOREIGN KEY (service_code) REFERENCES service_items(service_code) ON DELETE RESTRICT
    );
    CREATE TRIGGER IF NOT EXISTS trg_service_revisions_no_delete
      BEFORE DELETE ON service_revisions
      BEGIN SELECT RAISE(ABORT, 'service_revisions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_service_revisions_no_update
      BEFORE UPDATE ON service_revisions
      BEGIN SELECT RAISE(ABORT, 'service_revisions are immutable'); END;
    CREATE INDEX IF NOT EXISTS idx_service_revisions_created ON service_revisions(created_at DESC);
  `;

const ORGANIZATION_DIRECTORY_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS organization_snapshots (
      version INTEGER PRIMARY KEY,
      source_system TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      department_count INTEGER NOT NULL,
      definition_json TEXT NOT NULL,
      definition_sha256 TEXT NOT NULL UNIQUE,
      change_ref TEXT NOT NULL,
      imported_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS trg_organization_snapshots_no_delete
      BEFORE DELETE ON organization_snapshots
      BEGIN SELECT RAISE(ABORT, 'organization_snapshots are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_organization_snapshots_no_update
      BEFORE UPDATE ON organization_snapshots
      BEGIN SELECT RAISE(ABORT, 'organization_snapshots are immutable'); END;
    CREATE INDEX IF NOT EXISTS idx_organization_snapshots_expiry ON organization_snapshots(expires_at DESC);
  `;

const MULTI_DEPARTMENT_IDENTITY_SCHEMA_SQL = `
    ALTER TABLE auth_sessions ADD COLUMN department_ids_json TEXT NOT NULL DEFAULT '[]';
  `;

const IDENTITY_LIFECYCLE_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS identity_lifecycle_events (
      source_system TEXT NOT NULL,
      event_id TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      received_at TEXT NOT NULL,
      PRIMARY KEY (source_system, event_id),
      UNIQUE (source_system, employee_id, sequence)
    );
    CREATE TABLE IF NOT EXISTS employee_identity_states (
      employee_id TEXT PRIMARY KEY,
      access_status TEXT NOT NULL CHECK (access_status IN ('ACTIVE', 'BLOCKED')),
      status_reason_code TEXT,
      latest_sequence INTEGER NOT NULL,
      latest_event_id TEXT NOT NULL,
      latest_event_type TEXT NOT NULL,
      latest_event_occurred_at TEXT NOT NULL,
      source_system TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS trg_identity_lifecycle_events_no_delete
      BEFORE DELETE ON identity_lifecycle_events
      BEGIN SELECT RAISE(ABORT, 'identity_lifecycle_events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_identity_lifecycle_events_no_update
      BEFORE UPDATE ON identity_lifecycle_events
      BEGIN SELECT RAISE(ABORT, 'identity_lifecycle_events are immutable'); END;
    CREATE INDEX IF NOT EXISTS idx_identity_events_employee ON identity_lifecycle_events(employee_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_identity_states_status ON employee_identity_states(access_status, updated_at DESC);
  `;

const ORDERED_BUSINESS_WEBHOOK_SCHEMA_SQL = `
    ALTER TABLE external_tickets ADD COLUMN last_event_sequence INTEGER;
    ALTER TABLE external_tickets ADD COLUMN last_event_occurred_at TEXT;
    ALTER TABLE external_tickets ADD COLUMN last_event_id TEXT;
  `;

export const CURRENT_SCHEMA_VERSION = 10;
export const MINIMUM_COMPATIBLE_SCHEMA_VERSION = 1;

const MIGRATIONS = Object.freeze([
  Object.freeze({ version: 1, name: "baseline-v0.9", sql: BASELINE_SCHEMA_SQL }),
  Object.freeze({ version: 2, name: "data-lifecycle-governance-v1.2", sql: DATA_LIFECYCLE_SCHEMA_SQL }),
  Object.freeze({ version: 3, name: "tamper-evident-audit-chain-v1.5", sql: AUDIT_CHAIN_SCHEMA_SQL }),
  Object.freeze({ version: 4, name: "governed-knowledge-publication-v1.6", sql: KNOWLEDGE_GOVERNANCE_SCHEMA_SQL }),
  Object.freeze({ version: 5, name: "service-audience-authorization-v1.11", sql: SERVICE_AUDIENCE_SCHEMA_SQL }),
  Object.freeze({ version: 6, name: "immutable-service-catalog-revisions-v1.12", sql: SERVICE_REVISION_SCHEMA_SQL }),
  Object.freeze({ version: 7, name: "governed-organization-directory-v1.13", sql: ORGANIZATION_DIRECTORY_SCHEMA_SQL }),
  Object.freeze({ version: 8, name: "trusted-multi-department-identity-v1.16", sql: MULTI_DEPARTMENT_IDENTITY_SCHEMA_SQL }),
  Object.freeze({ version: 9, name: "identity-lifecycle-events-v1.17", sql: IDENTITY_LIFECYCLE_SCHEMA_SQL }),
  Object.freeze({ version: 10, name: "ordered-per-system-business-webhooks-v1.18", sql: ORDERED_BUSINESS_WEBHOOK_SCHEMA_SQL }),
]);

function checksum(sql) {
  return crypto.createHash("sha256").update(sql).digest("hex").toUpperCase();
}

function migrationRows(db) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  return exists ? db.prepare("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version").all() : [];
}

export function getDatabaseSchemaInfo(db) {
  const rows = migrationRows(db);
  const currentVersion = rows.length ? Number(rows.at(-1).version) : 0;
  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    throw new AppError("DATABASE_SCHEMA_TOO_NEW", `数据库Schema版本${currentVersion}高于应用支持的${CURRENT_SCHEMA_VERSION}，拒绝启动以防止回滚版本破坏数据`, 500, { databaseVersion: currentVersion, supportedVersion: CURRENT_SCHEMA_VERSION });
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const expected = MIGRATIONS[index];
    if (!expected || Number(row.version) !== expected.version) throw new AppError("DATABASE_MIGRATION_GAP", "数据库迁移版本不连续或包含未知版本", 500);
    if (row.name !== expected.name || row.checksum !== checksum(expected.sql)) throw new AppError("DATABASE_MIGRATION_TAMPERED", `数据库迁移${row.version}名称或校验和不匹配`, 500, { version: Number(row.version) });
  }
  return {
    currentVersion,
    supportedVersion: CURRENT_SCHEMA_VERSION,
    minimumCompatibleVersion: MINIMUM_COMPATIBLE_SCHEMA_VERSION,
    compatible: currentVersion >= MINIMUM_COMPATIBLE_SCHEMA_VERSION && currentVersion <= CURRENT_SCHEMA_VERSION,
    migrations: rows.map((row) => ({ version: Number(row.version), name: row.name, checksum: row.checksum, appliedAt: row.applied_at })),
  };
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const existing = getDatabaseSchemaInfo(db);
  for (const migration of MIGRATIONS.filter((item) => item.version > existing.currentVersion)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)")
        .run(migration.version, migration.name, checksum(migration.sql), nowIso());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const applied = getDatabaseSchemaInfo(db);
  if (!applied.compatible || applied.currentVersion !== CURRENT_SCHEMA_VERSION) throw new AppError("DATABASE_SCHEMA_INCOMPATIBLE", "数据库Schema迁移未达到当前应用要求", 500, applied);
}

function seed(db) {
  const count = db.prepare("SELECT COUNT(*) AS count FROM service_items").get().count;
  if (count > 0) return;
  const timestamp = nowIso();
  const insertService = db.prepare(`
    INSERT INTO service_items
    (service_code, service_name, domain_code, owner_team, description, target_system, target_ticket_type, risk_level, ai_policy_json, audience_policy_json, keywords_json, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  const insertSchema = db.prepare("INSERT INTO service_schemas (service_code, version, schema_json, created_at) VALUES (?, 1, ?, ?)");

  const services = [
    {
      serviceCode: "CRM_ACCOUNT_CHANGE",
      serviceName: "CRM客户归属调整",
      domainCode: "ORG_CRM",
      ownerTeam: "CRM运营组（待确认）",
      description: "收集客户归属调整信息，并提交至原CRM/OA业务流程。",
      targetSystem: "CRM",
      targetTicketType: "ACCOUNT_CHANGE",
      riskLevel: "MEDIUM",
      aiPolicy: { answer: true, collect: true, submit: true, directBusinessMutation: false },
      audiencePolicy: { visibility: "ALL_EMPLOYEES", departmentIds: [], includeDescendants: false, includeEmployeeIds: [], excludeEmployeeIds: [] },
      keywords: ["CRM", "客户", "归属", "销售", "负责人", "转移"],
      schema: {
        version: 1,
        fields: [
          { name: "customerCode", label: "客户编号", type: "string", required: true, minLength: 3, maxLength: 50, help: "请输入CRM中的客户唯一编号" },
          { name: "currentOwnerEmployeeId", label: "原负责人编号", type: "string", required: true, minLength: 2, maxLength: 50 },
          { name: "newOwnerEmployeeId", label: "新负责人编号", type: "string", required: true, minLength: 2, maxLength: 50 },
          { name: "reason", label: "调整原因", type: "textarea", required: true, minLength: 4, maxLength: 500 },
          { name: "effectiveDate", label: "期望生效日期", type: "date", required: true },
        ],
      },
    },
    {
      serviceCode: "SYSTEM_ACCESS_HELP",
      serviceName: "业务系统账号/权限咨询",
      domainCode: "ORG_ACCESS",
      ownerTeam: "权限服务组（待确认）",
      description: "提供账号登录、权限申请方式和常见故障指引；实际授权仍走原审批。",
      targetSystem: "OA",
      targetTicketType: "ACCESS_HELP",
      riskLevel: "LOW",
      aiPolicy: { answer: true, collect: true, submit: true, grantPermission: false },
      audiencePolicy: { visibility: "ALL_EMPLOYEES", departmentIds: [], includeDescendants: false, includeEmployeeIds: [], excludeEmployeeIds: [] },
      keywords: ["账号", "权限", "登录", "无法登录", "申请权限", "OA"],
      schema: {
        version: 1,
        fields: [
          { name: "systemName", label: "系统名称", type: "string", required: true, minLength: 2, maxLength: 80 },
          { name: "issueType", label: "问题类型", type: "enum", required: true, options: [
            { value: "LOGIN_FAILED", label: "无法登录" },
            { value: "REQUEST_ACCESS", label: "申请权限" },
            { value: "ACCESS_INCORRECT", label: "权限不正确" },
            { value: "OTHER", label: "其他" }
          ] },
          { name: "description", label: "问题描述", type: "textarea", required: true, minLength: 4, maxLength: 800 },
        ],
      },
    },
    {
      serviceCode: "ERP_MASTER_DATA_ISSUE",
      serviceName: "ERP主数据问题报修",
      domainCode: "ORG_ERP",
      ownerTeam: "ERP支持组（待确认）",
      description: "收集ERP主数据异常或使用问题，提交至原ERP/ITSM处理流程。",
      targetSystem: "ERP",
      targetTicketType: "MASTER_DATA_ISSUE",
      riskLevel: "MEDIUM",
      aiPolicy: { answer: true, collect: true, submit: true, directBusinessMutation: false },
      audiencePolicy: { visibility: "ALL_EMPLOYEES", departmentIds: [], includeDescendants: false, includeEmployeeIds: [], excludeEmployeeIds: [] },
      keywords: ["ERP", "物料", "主数据", "供应商", "报错", "异常"],
      schema: {
        version: 1,
        fields: [
          { name: "objectType", label: "对象类型", type: "enum", required: true, options: [
            { value: "MATERIAL", label: "物料" },
            { value: "SUPPLIER", label: "供应商" },
            { value: "CUSTOMER", label: "客户" },
            { value: "OTHER", label: "其他" }
          ] },
          { name: "objectCode", label: "对象编号", type: "string", required: true, minLength: 2, maxLength: 80 },
          { name: "description", label: "异常描述", type: "textarea", required: true, minLength: 6, maxLength: 1000 },
          { name: "impactLevel", label: "影响程度", type: "enum", required: true, options: [
            { value: "SINGLE_USER", label: "单人受影响" },
            { value: "TEAM", label: "团队受影响" },
            { value: "BUSINESS_BLOCKED", label: "业务阻断" }
          ] },
        ],
      },
    },
  ];

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const service of services) {
      insertService.run(
        service.serviceCode, service.serviceName, service.domainCode, service.ownerTeam, service.description,
        service.targetSystem, service.targetTicketType, service.riskLevel, JSON.stringify(service.aiPolicy),
        JSON.stringify(service.audiencePolicy), JSON.stringify(service.keywords), timestamp, timestamp,
      );
      insertSchema.run(service.serviceCode, JSON.stringify(service.schema), timestamp);
    }
    const insertKnowledge = db.prepare(`
      INSERT INTO knowledge_items
      (knowledge_id, title, patterns_json, answer, source_title, source_url, allowed_departments_json, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    `);
    insertKnowledge.run(
      "KB-DEMO-001",
      "账号权限办理说明（演示）",
      JSON.stringify(["怎么申请权限", "申请系统权限", "为什么登录不了", "账号登录失败"]),
      "账号或权限问题需要先确认具体系统和问题类型。AI可以帮助检查常见原因并整理申请信息，但不会直接授予权限；正式授权仍须进入原审批流程。",
      "账号权限办理说明（演示知识，待替换）",
      "https://intranet.example.invalid/access-guide",
      JSON.stringify(["*"]),
      timestamp,
    );
    insertKnowledge.run(
      "KB-DEMO-002",
      "CRM客户归属调整说明（演示）",
      JSON.stringify(["客户归属怎么改", "客户负责人怎么调整", "CRM客户转移"]),
      "客户归属调整需要提供客户编号、原负责人、新负责人、调整原因和期望生效日期。AI会生成预览，只有员工确认后才会提交原业务流程。",
      "CRM客户归属调整说明（演示知识，待替换）",
      "https://intranet.example.invalid/crm-account-change",
      JSON.stringify(["*"]),
      timestamp,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function withTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
