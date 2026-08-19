import crypto from "node:crypto";
import { AppError } from "../domain/errors.mjs";

const INVOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const OPERATION_ID = /^[a-z][a-z0-9_]{2,79}$/;
const OUTCOMES = new Set(["RUNNING", "SUCCESS", "FAILURE"]);

function employeeDigest(secret, employeeId) {
  return crypto.createHmac("sha256", secret).update(String(employeeId)).digest("base64url");
}

function normalizeInvocationId(value) {
  if (value === undefined || value === null || String(value).trim() === "") return crypto.randomUUID();
  const normalized = String(value).trim();
  if (!INVOCATION_ID.test(normalized)) throw new AppError("INVALID_TOOL_INVOCATION_ID", "工具调用编号格式无效", 400);
  return normalized;
}

export class ToolInvocationService {
  constructor({ db, hashSecret, retentionDays = 90, now = () => Date.now() }) {
    this.db = db;
    this.hashSecret = hashSecret;
    this.retentionDays = retentionDays;
    this.now = now;
    this.nextCleanupAt = 0;
  }

  start({ requestedId, operationId, employee, traceId }) {
    this.cleanupIfDue();
    if (!OPERATION_ID.test(String(operationId))) throw new AppError("INVALID_TOOL_OPERATION", "工具操作编号无效", 404);
    const invocationId = normalizeInvocationId(requestedId);
    const createdAt = new Date(this.now()).toISOString();
    try {
      this.db.prepare(`
        INSERT INTO tool_invocations
        (invocation_id, operation_id, employee_hash, department_id, outcome, http_status, error_code, duration_ms, trace_id, created_at, completed_at)
        VALUES (?, ?, ?, ?, 'RUNNING', NULL, NULL, NULL, ?, ?, NULL)
      `).run(invocationId, operationId, employeeDigest(this.hashSecret, employee.employeeId), String(employee.departmentId).slice(0, 128), traceId, createdAt);
    } catch (error) {
      if (String(error?.code ?? "").startsWith("ERR_SQLITE_CONSTRAINT") || /UNIQUE constraint failed/i.test(String(error?.message))) {
        throw new AppError("TOOL_INVOCATION_REPLAY", "工具调用编号已使用，请勿重放请求", 409, { invocationId });
      }
      throw error;
    }
    return { invocationId, operationId, startedAtMs: this.now() };
  }

  cleanupIfDue() {
    const now = this.now();
    if (now < this.nextCleanupAt) return;
    const cutoff = new Date(now - this.retentionDays * 86400000).toISOString();
    this.db.prepare("DELETE FROM tool_invocations WHERE completed_at IS NOT NULL AND created_at < ?").run(cutoff);
    this.nextCleanupAt = now + 3600000;
  }

  finish(context, { outcome, httpStatus, errorCode = null }) {
    if (!OUTCOMES.has(outcome) || outcome === "RUNNING") throw new AppError("INVALID_TOOL_OUTCOME", "工具调用结果无效", 500);
    const completedAtMs = this.now();
    const durationMs = Math.max(0, completedAtMs - context.startedAtMs);
    this.db.prepare(`
      UPDATE tool_invocations
      SET outcome = ?, http_status = ?, error_code = ?, duration_ms = ?, completed_at = ?
      WHERE invocation_id = ? AND outcome = 'RUNNING'
    `).run(outcome, Number(httpStatus), errorCode, durationMs, new Date(completedAtMs).toISOString(), context.invocationId);
    return { ...context, outcome, httpStatus: Number(httpStatus), errorCode, durationMs };
  }

  listAdmin({ operationId, outcome, limit = 100 } = {}) {
    const normalizedLimit = Math.max(1, Math.min(200, Number(limit) || 100));
    const clauses = [];
    const parameters = [];
    if (operationId !== undefined && operationId !== null && operationId !== "") {
      if (!OPERATION_ID.test(String(operationId))) throw new AppError("INVALID_TOOL_INVOCATION_FILTER", "工具操作筛选条件无效", 400);
      clauses.push("operation_id = ?");
      parameters.push(String(operationId));
    }
    if (outcome !== undefined && outcome !== null && outcome !== "") {
      const normalizedOutcome = String(outcome).toUpperCase();
      if (!OUTCOMES.has(normalizedOutcome)) throw new AppError("INVALID_TOOL_INVOCATION_FILTER", "工具结果筛选条件无效", 400);
      clauses.push("outcome = ?");
      parameters.push(normalizedOutcome);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`
      SELECT invocation_id, operation_id, department_id, outcome, http_status, error_code, duration_ms, trace_id, created_at, completed_at
      FROM tool_invocations ${where}
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(...parameters, normalizedLimit).map((row) => ({
      invocationId: row.invocation_id,
      operationId: row.operation_id,
      departmentId: row.department_id,
      outcome: row.outcome,
      httpStatus: row.http_status === null ? null : Number(row.http_status),
      errorCode: row.error_code,
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      traceId: row.trace_id,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    }));
  }
}
