import { AppError } from "../domain/errors.mjs";
import { withTransaction } from "../db.mjs";

const EVENT_TYPES = new Set([
  "ACCESS_SUSPENDED",
  "EMPLOYMENT_TERMINATED",
  "ACCESS_RESTORED",
  "MEMBERSHIP_CHANGED",
  "IDENTITY_PROFILE_CHANGED",
]);
const BLOCKING_EVENTS = new Set(["ACCESS_SUSPENDED", "EMPLOYMENT_TERMINATED"]);
const ALLOWED_KEYS = new Set(["schemaVersion", "eventId", "sourceSystem", "employeeId", "sequence", "eventType", "occurredAt", "reasonCode"]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/;
const REASON = /^[A-Z][A-Z0-9_]{1,63}$/;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function invalid(message, details) {
  throw new AppError("INVALID_IDENTITY_EVENT", message, 400, details);
}

function normalizedEvent(input, expectedSource) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("身份事件必须是JSON对象");
  const unknown = Object.keys(input).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknown.length) invalid("身份事件包含未知字段", { fields: unknown });
  if (input.schemaVersion !== 1) invalid("身份事件schemaVersion必须为1", { path: "schemaVersion" });
  for (const key of ["eventId", "sourceSystem", "employeeId"]) {
    if (typeof input[key] !== "string" || !IDENTIFIER.test(input[key])) invalid(`${key}格式无效`, { path: key });
  }
  if (input.sourceSystem !== expectedSource) throw new AppError("IDENTITY_EVENT_SOURCE_MISMATCH", "身份事件来源不受信任", 401);
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) invalid("sequence必须为正整数", { path: "sequence" });
  if (typeof input.eventType !== "string" || !EVENT_TYPES.has(input.eventType)) invalid("eventType不受支持", { path: "eventType" });
  if (typeof input.reasonCode !== "string" || !REASON.test(input.reasonCode)) invalid("reasonCode格式无效", { path: "reasonCode" });
  if (typeof input.occurredAt !== "string" || !UTC_INSTANT.test(input.occurredAt) || !Number.isFinite(Date.parse(input.occurredAt))) {
    invalid("occurredAt必须为UTC ISO时间", { path: "occurredAt" });
  }
  return { ...input };
}

export class IdentityLifecycleService {
  constructor({ db, sessions, audit, expectedSource, maxAgeSeconds = 86400, now = () => Date.now() }) {
    this.db = db;
    this.sessions = sessions;
    this.audit = audit;
    this.expectedSource = expectedSource;
    this.maxAgeSeconds = maxAgeSeconds;
    this.now = now;
  }

  assertEmployeeAllowed(employeeId) {
    const normalized = String(employeeId ?? "").trim();
    const state = this.db.prepare("SELECT * FROM employee_identity_states WHERE employee_id = ?").get(normalized);
    if (state?.access_status === "BLOCKED") {
      throw new AppError("EMPLOYEE_ACCESS_BLOCKED", "员工身份已被公司身份系统停用", 403, {
        status: state.access_status,
        reasonCode: state.status_reason_code,
        sourceSystem: state.source_system,
        effectiveAt: state.latest_event_occurred_at,
      });
    }
    return state ? this.mapState(state) : { employeeId: normalized, accessStatus: "ACTIVE", managed: false };
  }

  applyEvent(input, payloadHash, { traceId = null } = {}) {
    const event = normalizedEvent(input, this.expectedSource);
    if (!/^[a-f0-9]{64}$/i.test(payloadHash ?? "")) throw new AppError("INVALID_IDENTITY_EVENT_HASH", "身份事件摘要无效", 500);
    const duplicate = this.db.prepare("SELECT * FROM identity_lifecycle_events WHERE source_system = ? AND event_id = ?").get(event.sourceSystem, event.eventId);
    if (duplicate) {
      if (duplicate.payload_hash !== payloadHash) throw new AppError("IDENTITY_EVENT_ID_REUSE", "相同身份事件ID对应不同内容", 409);
      return { duplicate: true, applied: false, revokedSessions: 0, state: this.getState(event.employeeId) };
    }
    const occurredMs = Date.parse(event.occurredAt);
    const ageMs = this.now() - occurredMs;
    if (ageMs < -300_000) throw new AppError("IDENTITY_EVENT_IN_FUTURE", "身份事件时间位于允许窗口之后", 409);
    if (ageMs > this.maxAgeSeconds * 1000) throw new AppError("IDENTITY_EVENT_EXPIRED", "身份事件超过接收时效", 409);
    const current = this.db.prepare("SELECT * FROM employee_identity_states WHERE employee_id = ?").get(event.employeeId);
    if (current && event.sequence <= Number(current.latest_sequence)) {
      throw new AppError("IDENTITY_EVENT_OUT_OF_ORDER", "身份事件序号不高于已处理序号", 409, { latestSequence: Number(current.latest_sequence) });
    }

    return withTransaction(this.db, () => {
      const receivedAt = new Date(this.now()).toISOString();
      const accessStatus = BLOCKING_EVENTS.has(event.eventType)
        ? "BLOCKED"
        : event.eventType === "ACCESS_RESTORED" ? "ACTIVE" : current?.access_status ?? "ACTIVE";
      const reasonCode = BLOCKING_EVENTS.has(event.eventType)
        ? event.reasonCode
        : event.eventType === "ACCESS_RESTORED" ? null : current?.status_reason_code ?? null;
      this.db.prepare(`
        INSERT INTO identity_lifecycle_events
        (source_system, event_id, employee_id, sequence, event_type, occurred_at, reason_code, payload_hash, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(event.sourceSystem, event.eventId, event.employeeId, event.sequence, event.eventType, event.occurredAt, event.reasonCode, payloadHash, receivedAt);
      this.db.prepare(`
        INSERT INTO employee_identity_states
        (employee_id, access_status, status_reason_code, latest_sequence, latest_event_id, latest_event_type,
         latest_event_occurred_at, source_system, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(employee_id) DO UPDATE SET
          access_status = excluded.access_status,
          status_reason_code = excluded.status_reason_code,
          latest_sequence = excluded.latest_sequence,
          latest_event_id = excluded.latest_event_id,
          latest_event_type = excluded.latest_event_type,
          latest_event_occurred_at = excluded.latest_event_occurred_at,
          source_system = excluded.source_system,
          updated_at = excluded.updated_at
      `).run(event.employeeId, accessStatus, reasonCode, event.sequence, event.eventId, event.eventType, event.occurredAt, event.sourceSystem, receivedAt);
      const revoked = this.sessions.revokeEmployee(event.employeeId);
      this.audit.record({
        actorType: "SYSTEM",
        actorId: event.sourceSystem,
        action: "APPLY_IDENTITY_LIFECYCLE_EVENT",
        details: { employeeId: event.employeeId, eventId: event.eventId, eventType: event.eventType, sequence: event.sequence, reasonCode: event.reasonCode, accessStatus, revokedSessions: revoked.revokedSessions },
        traceId,
      });
      return { duplicate: false, applied: true, revokedSessions: revoked.revokedSessions, state: this.getState(event.employeeId) };
    });
  }

  getState(employeeId) {
    const row = this.db.prepare("SELECT * FROM employee_identity_states WHERE employee_id = ?").get(String(employeeId ?? "").trim());
    return row ? this.mapState(row) : null;
  }

  listStates({ employeeId, accessStatus, limit = 100 } = {}) {
    const normalizedLimit = Math.max(1, Math.min(200, Number(limit) || 100));
    const clauses = [];
    const values = [];
    if (employeeId !== undefined && employeeId !== null && employeeId !== "") {
      const normalized = String(employeeId).trim();
      if (!IDENTIFIER.test(normalized)) throw new AppError("INVALID_EMPLOYEE_ID", "员工编号无效", 400);
      clauses.push("employee_id = ?");
      values.push(normalized);
    }
    if (accessStatus !== undefined && accessStatus !== null && accessStatus !== "") {
      const normalized = String(accessStatus).toUpperCase();
      if (!new Set(["ACTIVE", "BLOCKED"]).has(normalized)) throw new AppError("INVALID_IDENTITY_ACCESS_STATUS", "身份访问状态筛选无效", 400);
      clauses.push("access_status = ?");
      values.push(normalized);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM employee_identity_states ${where} ORDER BY updated_at DESC, employee_id LIMIT ?`)
      .all(...values, normalizedLimit).map((row) => this.mapState(row));
  }

  mapState(row) {
    return {
      employeeId: row.employee_id,
      accessStatus: row.access_status,
      reasonCode: row.status_reason_code,
      latestSequence: Number(row.latest_sequence),
      latestEventId: row.latest_event_id,
      latestEventType: row.latest_event_type,
      effectiveAt: row.latest_event_occurred_at,
      sourceSystem: row.source_system,
      updatedAt: row.updated_at,
      managed: true,
    };
  }
}
