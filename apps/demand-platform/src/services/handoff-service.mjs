import crypto from "node:crypto";
import { AppError, assert } from "../domain/errors.mjs";
import { withTransaction } from "../db.mjs";

const REASONS = new Set(["NO_MATCH", "KNOWLEDGE_CONFLICT", "TOOL_FAILURE", "USER_REQUEST", "OTHER"]);
const STATUSES = new Set(["OPEN", "ASSIGNED", "RESOLVED", "CLOSED"]);
const TRANSITIONS = new Map([
  ["OPEN", new Set(["ASSIGNED", "RESOLVED", "CLOSED"])],
  ["ASSIGNED", new Set(["RESOLVED", "CLOSED"])],
  ["RESOLVED", new Set(["ASSIGNED", "CLOSED"])],
  ["CLOSED", new Set([])],
]);

function text(value, name, min, max) {
  const normalized = String(value ?? "").trim();
  assert(normalized.length >= min && normalized.length <= max, "INVALID_HANDOFF", `${name}长度应为${min}至${max}个字符`, 422, { name });
  return normalized;
}

function mapRow(row) {
  return {
    handoffId: row.handoff_id,
    handoffNo: row.handoff_no,
    requester: { employeeId: row.requester_employee_id, departmentId: row.requester_department_id, name: row.requester_name },
    conversationId: row.conversation_id,
    reasonCode: row.reason_code,
    queueCode: row.queue_code,
    summary: row.summary,
    originalMessage: row.original_message,
    status: row.status,
    assignedTo: row.assigned_to,
    resolutionSummary: row.resolution_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class HandoffService {
  constructor({ db, audit, allowedQueues = ["ORG_SERVICE_DESK"] }) {
    this.db = db;
    this.audit = audit;
    this.allowedQueues = new Set(allowedQueues);
  }

  nextHandoffNo() {
    const result = this.db.prepare("UPDATE counters SET counter_value = counter_value + 1 WHERE counter_name = 'handoff' RETURNING counter_value").get();
    const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date()).replaceAll("-", "");
    return `HOF-${date}-${String(result.counter_value).padStart(6, "0")}`;
  }

  create(employee, input, { traceId = null } = {}) {
    assert(input?.employeeConfirmed === true, "HANDOFF_CONFIRMATION_REQUIRED", "转人工前需要员工明确确认", 409);
    const reasonCode = String(input.reasonCode ?? "NO_MATCH").toUpperCase();
    assert(REASONS.has(reasonCode), "INVALID_HANDOFF", "转人工原因无效", 422, { reasonCode });
    const queueCode = String(input.queueCode ?? "ORG_SERVICE_DESK").toUpperCase();
    assert(this.allowedQueues.has(queueCode), "HANDOFF_QUEUE_NOT_ALLOWED", "转人工队列不在允许范围", 422, { queueCode });
    const summary = text(input.summary, "summary", 4, 1000);
    const originalMessage = text(input.originalMessage, "originalMessage", 1, 4000);
    const idempotencyKey = text(input.idempotencyKey, "idempotencyKey", 12, 180);
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({
      employeeId: employee.employeeId,
      conversationId: input.conversationId ?? null,
      reasonCode,
      queueCode,
      summary,
      originalMessage,
    })).digest("hex");
    const existing = this.db.prepare("SELECT * FROM handoff_items WHERE idempotency_key = ?").get(idempotencyKey);
    if (existing) {
      assert(existing.requester_employee_id === employee.employeeId && existing.request_fingerprint === fingerprint, "IDEMPOTENCY_CONFLICT", "相同幂等键对应了不同转人工请求", 409);
      return { handoff: mapRow(existing), idempotentReplay: true };
    }
    const timestamp = new Date().toISOString();
    const handoffId = crypto.randomUUID();
    const handoffNo = withTransaction(this.db, () => {
      const next = this.nextHandoffNo();
      this.db.prepare(`
        INSERT INTO handoff_items
        (handoff_id, handoff_no, requester_employee_id, requester_department_id, requester_name, conversation_id,
         reason_code, queue_code, summary, original_message, status, idempotency_key, request_fingerprint, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)
      `).run(
        handoffId, next, employee.employeeId, employee.departmentId, employee.name, input.conversationId ?? null,
        reasonCode, queueCode, summary, originalMessage, idempotencyKey, fingerprint, timestamp, timestamp,
      );
      return next;
    });
    this.audit.record({ actorType: "EMPLOYEE", actorId: employee.employeeId, action: "CREATE_HANDOFF", details: { handoffNo, reasonCode, queueCode }, traceId });
    return { handoff: this.getOwned(employee, handoffNo), idempotentReplay: false };
  }

  getOwned(employee, handoffNo) {
    const row = this.db.prepare("SELECT * FROM handoff_items WHERE handoff_no = ? AND requester_employee_id = ?").get(handoffNo, employee.employeeId);
    if (!row) throw new AppError("HANDOFF_NOT_FOUND", "转人工事项不存在或无权查看", 404);
    return mapRow(row);
  }

  listOwned(employee) {
    return this.db.prepare("SELECT * FROM handoff_items WHERE requester_employee_id = ? ORDER BY updated_at DESC")
      .all(employee.employeeId).map(mapRow);
  }

  listAdmin({ status, limit = 100 } = {}) {
    const normalizedLimit = Math.max(1, Math.min(200, Number(limit) || 100));
    if (status !== undefined) {
      const normalized = String(status).toUpperCase();
      assert(STATUSES.has(normalized), "INVALID_HANDOFF_STATUS", "转人工状态无效", 422, { status });
      return this.db.prepare("SELECT * FROM handoff_items WHERE status = ? ORDER BY updated_at DESC LIMIT ?").all(normalized, normalizedLimit).map(mapRow);
    }
    return this.db.prepare("SELECT * FROM handoff_items ORDER BY updated_at DESC LIMIT ?").all(normalizedLimit).map(mapRow);
  }

  updateAdmin(handoffNo, input, actorId, { traceId = null } = {}) {
    const row = this.db.prepare("SELECT * FROM handoff_items WHERE handoff_no = ?").get(handoffNo);
    if (!row) throw new AppError("HANDOFF_NOT_FOUND", "转人工事项不存在", 404);
    const status = String(input.status ?? "").toUpperCase();
    assert(STATUSES.has(status), "INVALID_HANDOFF_STATUS", "转人工状态无效", 422, { status });
    assert(status === row.status || TRANSITIONS.get(row.status)?.has(status), "INVALID_HANDOFF_TRANSITION", `不允许从${row.status}变更为${status}`, 409);
    const assignedTo = input.assignedTo === undefined ? row.assigned_to : (input.assignedTo ? text(input.assignedTo, "assignedTo", 2, 100) : null);
    const resolutionSummary = input.resolutionSummary === undefined ? row.resolution_summary : (input.resolutionSummary ? text(input.resolutionSummary, "resolutionSummary", 4, 2000) : null);
    if (status === "ASSIGNED") assert(assignedTo, "HANDOFF_ASSIGNEE_REQUIRED", "进入已分派状态必须指定处理人", 422);
    if (["RESOLVED", "CLOSED"].includes(status)) assert(resolutionSummary, "HANDOFF_RESOLUTION_REQUIRED", "解决或关闭时必须填写处理结果", 422);
    this.db.prepare("UPDATE handoff_items SET status = ?, assigned_to = ?, resolution_summary = ?, updated_at = ? WHERE handoff_no = ?")
      .run(status, assignedTo, resolutionSummary, new Date().toISOString(), handoffNo);
    this.audit.record({ actorType: "OPERATOR", actorId, action: "UPDATE_HANDOFF", details: { handoffNo, from: row.status, to: status, assignedTo }, traceId });
    return { handoff: mapRow(this.db.prepare("SELECT * FROM handoff_items WHERE handoff_no = ?").get(handoffNo)) };
  }
}
