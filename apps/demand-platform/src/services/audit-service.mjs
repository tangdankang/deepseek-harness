import crypto from "node:crypto";
import { AppError } from "../domain/errors.mjs";

const GENESIS_HASH = "0".repeat(64);
const HASH = /^[A-F0-9]{64}$/;
const CHAIN_MODES = new Set(["LIVE", "LEGACY_BACKFILL"]);

function canonical(row, previousHash, keyVersion, chainMode) {
  return JSON.stringify([
    1,
    Number(row.audit_id),
    row.case_id ?? null,
    row.actor_type,
    row.actor_id,
    row.action,
    row.outcome,
    row.details_json,
    row.trace_id ?? null,
    row.created_at,
    previousHash,
    Number(keyVersion),
    chainMode,
  ]);
}

function eventHash(secret, row, previousHash, keyVersion, chainMode) {
  return crypto.createHmac("sha256", secret).update(canonical(row, previousHash, keyVersion, chainMode)).digest("hex").toUpperCase();
}

function transaction(db, operation) {
  const owns = !db.isTransaction;
  if (owns) db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    if (owns) db.exec("COMMIT");
    return result;
  } catch (error) {
    if (owns && db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export class AuditService {
  constructor({ db, secret, keyVersion = 1, now = () => new Date(), allowLegacyBackfill = true }) {
    if (!db) throw new AppError("INVALID_AUDIT_CONFIGURATION", "审计数据库不能为空", 500);
    if (typeof secret !== "string" || secret.length < 32) throw new AppError("INVALID_AUDIT_CONFIGURATION", "审计链密钥至少32位", 500);
    if (!Number.isInteger(keyVersion) || keyVersion < 1 || keyVersion > 9999) throw new AppError("INVALID_AUDIT_CONFIGURATION", "审计链密钥版本无效", 500);
    this.db = db;
    this.secret = secret;
    this.keyVersion = keyVersion;
    this.now = now;
    this.allowLegacyBackfill = allowLegacyBackfill;
    this.insert = db.prepare(`
      INSERT INTO audit_events (case_id, actor_type, actor_id, action, outcome, details_json, trace_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertChain = db.prepare(`
      INSERT INTO audit_chain (audit_id, previous_hash, event_hash, key_version, chain_mode, linked_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.startupReport = this.initialize();
  }

  initialize() {
    return transaction(this.db, () => {
      const eventCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count);
      const chainCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM audit_chain").get().count);
      const state = this.db.prepare("SELECT state_id, initialized_at, initial_event_count, key_version FROM audit_chain_state WHERE state_id = 1").get();
      let backfilled = 0;
      if (!state && chainCount > 0) throw new AppError("AUDIT_CHAIN_STATE_MISSING", "审计链存在但不可变初始化状态缺失，拒绝启动", 500, { eventCount, chainCount });
      if (!state && chainCount === 0 && eventCount > 0) {
        if (!this.allowLegacyBackfill) throw new AppError("AUDIT_CHAIN_LEGACY_ANCHOR_REQUIRED", "存在未锚定旧审计记录；必须通过批准的一次性升级窗口显式允许锚定", 500, { eventCount });
        let previousHash = GENESIS_HASH;
        const rows = this.db.prepare("SELECT * FROM audit_events ORDER BY audit_id").all();
        for (const row of rows) {
          const hash = eventHash(this.secret, row, previousHash, this.keyVersion, "LEGACY_BACKFILL");
          this.insertChain.run(Number(row.audit_id), previousHash, hash, this.keyVersion, "LEGACY_BACKFILL", this.isoNow());
          previousHash = hash;
          backfilled += 1;
        }
      } else if (state && chainCount !== eventCount) {
        throw new AppError("AUDIT_CHAIN_INCOMPLETE", "审计事件与完整性链数量不一致，拒绝启动", 500, { eventCount, chainCount });
      }
      if (!state) this.db.prepare("INSERT INTO audit_chain_state (state_id, initialized_at, initial_event_count, key_version) VALUES (1, ?, ?, ?)").run(this.isoNow(), eventCount, this.keyVersion);
      else if (Number(state.key_version) !== this.keyVersion) throw new AppError("AUDIT_CHAIN_KEY_VERSION_MISMATCH", "审计链初始化密钥版本与应用配置不一致", 500, { databaseKeyVersion: Number(state.key_version), configuredKeyVersion: this.keyVersion });
      const report = this.verify();
      if (report.outcome !== "PASS") throw new AppError("AUDIT_CHAIN_TAMPERED", "审计完整性校验失败，拒绝启动", 500, { finding: report.finding, auditId: report.auditId });
      return { ...report, legacyRowsAnchoredThisStartup: backfilled };
    });
  }

  isoNow() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new AppError("INVALID_AUDIT_CLOCK", "审计时间无效", 500);
    return date.toISOString();
  }

  link(row, chainMode) {
    if (!CHAIN_MODES.has(chainMode)) throw new AppError("INVALID_AUDIT_CHAIN_MODE", "审计链模式无效", 500);
    const previous = this.db.prepare("SELECT audit_id, event_hash FROM audit_chain ORDER BY audit_id DESC LIMIT 1").get();
    const previousHash = previous?.event_hash ?? GENESIS_HASH;
    if (!HASH.test(previousHash)) throw new AppError("AUDIT_CHAIN_TAMPERED", "审计链头格式无效", 500);
    const hash = eventHash(this.secret, row, previousHash, this.keyVersion, chainMode);
    this.insertChain.run(Number(row.audit_id), previousHash, hash, this.keyVersion, chainMode, this.isoNow());
    return hash;
  }

  record({ caseId = null, actorType, actorId, action, outcome = "SUCCESS", details = {}, traceId = null }) {
    return transaction(this.db, () => {
      const createdAt = this.isoNow();
      const detailsJson = JSON.stringify(redact(details));
      const inserted = this.insert.run(caseId, actorType, actorId, action, outcome, detailsJson, traceId, createdAt);
      const auditId = Number(inserted.lastInsertRowid);
      const row = this.db.prepare("SELECT * FROM audit_events WHERE audit_id = ?").get(auditId);
      const hash = this.link(row, "LIVE");
      return { auditId, eventHash: hash, createdAt };
    });
  }

  verify() {
    const eventCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count);
    const chainCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM audit_chain").get().count);
    if (eventCount !== chainCount) return integrityFailure("CHAIN_COUNT_MISMATCH", null, eventCount, chainCount);
    const rows = this.db.prepare(`
      SELECT e.*, c.previous_hash, c.event_hash, c.key_version, c.chain_mode, c.linked_at
      FROM audit_events e JOIN audit_chain c ON c.audit_id = e.audit_id
      ORDER BY e.audit_id
    `).all();
    let previousHash = GENESIS_HASH;
    let legacyBackfillCount = 0;
    let liveCount = 0;
    for (const row of rows) {
      const auditId = Number(row.audit_id);
      if (!CHAIN_MODES.has(row.chain_mode)) return integrityFailure("INVALID_CHAIN_MODE", auditId, eventCount, chainCount);
      if (Number(row.key_version) !== this.keyVersion) return integrityFailure("UNSUPPORTED_KEY_VERSION", auditId, eventCount, chainCount);
      if (row.previous_hash !== previousHash) return integrityFailure("PREVIOUS_HASH_MISMATCH", auditId, eventCount, chainCount);
      const expected = eventHash(this.secret, row, previousHash, Number(row.key_version), row.chain_mode);
      if (!HASH.test(row.event_hash) || row.event_hash !== expected) return integrityFailure("EVENT_HASH_MISMATCH", auditId, eventCount, chainCount);
      previousHash = row.event_hash;
      if (row.chain_mode === "LEGACY_BACKFILL") legacyBackfillCount += 1;
      else liveCount += 1;
    }
    return {
      reportType: "AI_DEMAND_PLATFORM_AUDIT_INTEGRITY",
      reportVersion: 1,
      outcome: "PASS",
      finding: null,
      auditId: null,
      eventCount,
      chainCount,
      legacyBackfillCount,
      liveCount,
      keyVersion: this.keyVersion,
      headHash: rows.length > 0 ? previousHash : null,
      verifiedAt: this.isoNow(),
      safety: { containsAuditPayload: false, containsActorIds: false, containsSecret: false },
    };
  }

  assertIntegrity() {
    const report = this.verify();
    if (report.outcome !== "PASS") throw new AppError("AUDIT_CHAIN_TAMPERED", "审计完整性校验失败", 500, { finding: report.finding, auditId: report.auditId });
    return report;
  }

  listForCase(caseId) {
    return this.db.prepare("SELECT * FROM audit_events WHERE case_id = ? ORDER BY audit_id ASC").all(caseId).map(mapRow);
  }

  listAdmin({ action, outcome, actorType, limit = 100 } = {}) {
    const normalizedLimit = Math.max(1, Math.min(200, Number(limit) || 100));
    const clauses = [];
    const parameters = [];
    for (const [column, value, pattern] of [
      ["action", action, /^[A-Z][A-Z0-9_]{1,99}$/],
      ["outcome", outcome, /^(SUCCESS|FAILURE)$/],
      ["actor_type", actorType, /^(EMPLOYEE|OPERATOR|ADMIN|SYSTEM)$/],
    ]) {
      if (value === undefined || value === null || value === "") continue;
      const normalized = String(value).toUpperCase();
      if (!pattern.test(normalized)) throw new AppError("INVALID_AUDIT_FILTER", "审计筛选条件无效", 400, { field: column });
      clauses.push(`${column} = ?`);
      parameters.push(normalized);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM audit_events ${where} ORDER BY audit_id DESC LIMIT ?`).all(...parameters, normalizedLimit).map(mapRow);
  }
}

function integrityFailure(finding, auditId, eventCount, chainCount) {
  return {
    reportType: "AI_DEMAND_PLATFORM_AUDIT_INTEGRITY",
    reportVersion: 1,
    outcome: "FAIL",
    finding,
    auditId,
    eventCount,
    chainCount,
    legacyBackfillCount: null,
    liveCount: null,
    keyVersion: null,
    headHash: null,
    verifiedAt: new Date().toISOString(),
    safety: { containsAuditPayload: false, containsActorIds: false, containsSecret: false },
  };
}

function mapRow(row) {
  return {
    auditId: Number(row.audit_id),
    caseId: row.case_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    outcome: row.outcome,
    details: JSON.parse(row.details_json),
    traceId: row.trace_id,
    createdAt: row.created_at,
  };
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (/token|secret|password|api.?key|authorization/i.test(key)) result[key] = "[REDACTED]";
    else result[key] = redact(child);
  }
  return result;
}

export function auditIntegrityMarkdown(report) {
  return `# AI统一需求平台审计完整性报告

- 结果：**${report.outcome}**
- 审计事件：${report.eventCount}
- 链记录：${report.chainCount}
- 升级锚定记录：${report.legacyBackfillCount ?? "不可用"}
- 原生链记录：${report.liveCount ?? "不可用"}
- 密钥版本：${report.keyVersion ?? "不可用"}
- 链头：${report.headHash ?? "无"}
- 校验时间：${report.verifiedAt}
- 异常：${report.finding ?? "无"}
- 异常审计编号：${report.auditId ?? "无"}

报告不包含审计正文、操作者身份或审计链密钥。
`;
}
