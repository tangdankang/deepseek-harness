import crypto from "node:crypto";
import { AppError, assert } from "../domain/errors.mjs";

const SUBJECT_TYPES = new Set(["CONVERSATION", "CASE", "HANDOFF"]);
const REASON_CODES = new Set(["ANSWER_HELPFUL", "ANSWER_INCORRECT", "MISSING_INFORMATION", "WRONG_SERVICE", "TOO_COMPLEX", "TOOL_FAILED", "OTHER"]);
const ALLOWED_INPUT_KEYS = new Set(["employeeConfirmed", "subjectType", "subjectId", "resolved", "rating", "reasonCodes", "idempotencyKey"]);

function mapRow(row) {
  return {
    feedbackId: row.feedback_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    resolved: Boolean(row.resolved),
    rating: row.rating === null ? null : Number(row.rating),
    reasonCodes: JSON.parse(row.reason_codes_json),
    createdAt: row.created_at,
  };
}

export class FeedbackService {
  constructor({ db, audit, hashSecret }) {
    this.db = db;
    this.audit = audit;
    this.hashSecret = hashSecret;
  }

  employeeHash(employeeId) {
    return crypto.createHmac("sha256", this.hashSecret).update(employeeId).digest("hex");
  }

  verifySubjectOwnership(employee, subjectType, subjectId, employeeHash) {
    if (subjectType === "CONVERSATION") {
      const owned = this.db.prepare("SELECT 1 FROM assistant_interactions WHERE employee_hash = ? AND conversation_id = ? LIMIT 1").get(employeeHash, subjectId);
      assert(owned, "FEEDBACK_SUBJECT_NOT_FOUND", "会话不存在或无权反馈", 404);
    } else if (subjectType === "CASE") {
      const owned = this.db.prepare("SELECT 1 FROM demand_cases WHERE global_request_no = ? AND requester_employee_id = ?").get(subjectId, employee.employeeId);
      assert(owned, "FEEDBACK_SUBJECT_NOT_FOUND", "需求不存在或无权反馈", 404);
    } else {
      const owned = this.db.prepare("SELECT 1 FROM handoff_items WHERE handoff_no = ? AND requester_employee_id = ?").get(subjectId, employee.employeeId);
      assert(owned, "FEEDBACK_SUBJECT_NOT_FOUND", "人工受理事项不存在或无权反馈", 404);
    }
  }

  record(employee, input, { traceId = null } = {}) {
    const unknownKeys = Object.keys(input ?? {}).filter((key) => !ALLOWED_INPUT_KEYS.has(key));
    assert(unknownKeys.length === 0, "INVALID_FEEDBACK", "反馈包含未定义字段", 422, { unknownKeys });
    assert(input?.employeeConfirmed === true, "FEEDBACK_CONFIRMATION_REQUIRED", "仅在员工明确提交反馈时记录", 409);
    const subjectType = String(input.subjectType ?? "").toUpperCase();
    assert(SUBJECT_TYPES.has(subjectType), "INVALID_FEEDBACK", "反馈对象类型无效", 422, { subjectType });
    const subjectId = String(input.subjectId ?? "").trim();
    assert(subjectId.length >= 4 && subjectId.length <= 120, "INVALID_FEEDBACK", "反馈对象编号无效", 422);
    assert(typeof input.resolved === "boolean", "INVALID_FEEDBACK", "resolved必须为布尔值", 422);
    const rating = input.rating === undefined || input.rating === null ? null : Number(input.rating);
    assert(rating === null || (Number.isInteger(rating) && rating >= 1 && rating <= 5), "INVALID_FEEDBACK", "rating必须为1至5的整数", 422);
    const reasonCodes = input.reasonCodes ?? [];
    assert(Array.isArray(reasonCodes) && reasonCodes.length <= 5 && reasonCodes.every((code) => REASON_CODES.has(String(code).toUpperCase())), "INVALID_FEEDBACK", "反馈原因编码无效", 422);
    const normalizedReasons = [...new Set(reasonCodes.map((code) => String(code).toUpperCase()))];
    const idempotencyKey = String(input.idempotencyKey ?? "").trim();
    assert(idempotencyKey.length >= 12 && idempotencyKey.length <= 180, "INVALID_IDEMPOTENCY_KEY", "反馈幂等键长度应为12至180个字符", 422);
    const employeeHash = this.employeeHash(employee.employeeId);
    this.verifySubjectOwnership(employee, subjectType, subjectId, employeeHash);
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ employeeHash, subjectType, subjectId, resolved: input.resolved, rating, reasonCodes: normalizedReasons })).digest("hex");

    const byKey = this.db.prepare("SELECT * FROM employee_feedback WHERE idempotency_key = ?").get(idempotencyKey);
    if (byKey) {
      assert(byKey.employee_hash === employeeHash && byKey.request_fingerprint === fingerprint, "IDEMPOTENCY_CONFLICT", "相同幂等键对应了不同反馈", 409);
      return { feedback: mapRow(byKey), idempotentReplay: true };
    }
    const existing = this.db.prepare("SELECT * FROM employee_feedback WHERE employee_hash = ? AND subject_type = ? AND subject_id = ?").get(employeeHash, subjectType, subjectId);
    if (existing) throw new AppError("FEEDBACK_ALREADY_RECORDED", "该事项已提交反馈", 409, { feedbackId: existing.feedback_id });

    const feedbackId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO employee_feedback
      (feedback_id, employee_hash, subject_type, subject_id, resolved, rating, reason_codes_json,
       idempotency_key, request_fingerprint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(feedbackId, employeeHash, subjectType, subjectId, input.resolved ? 1 : 0, rating, JSON.stringify(normalizedReasons), idempotencyKey, fingerprint, timestamp);
    this.audit.record({ actorType: "EMPLOYEE", actorId: employee.employeeId, action: "RECORD_FEEDBACK", details: { feedbackId, subjectType, subjectId, resolved: input.resolved, rating, reasonCodes: normalizedReasons }, traceId });
    return { feedback: mapRow(this.db.prepare("SELECT * FROM employee_feedback WHERE feedback_id = ?").get(feedbackId)), idempotentReplay: false };
  }
}
