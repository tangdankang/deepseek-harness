import crypto from "node:crypto";
import { AppError, assert } from "../domain/errors.mjs";
import { CaseStatus, assertTransition } from "../domain/state-machine.mjs";
import { validateFields } from "../domain/schema-validation.mjs";
import { issueConfirmationToken, verifyConfirmationToken } from "../domain/confirmation-token.mjs";
import { withTransaction } from "../db.mjs";

const EDITABLE_STATUSES = new Set([CaseStatus.DRAFT, CaseStatus.WAITING_INFORMATION, CaseStatus.WAITING_CONFIRMATION]);
const STATUS_EVENT_KEYS = new Set(["eventId", "ticketNo", "rawStatus", "occurredAt", "sequence"]);
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function normalizeStatusEvent(event) {
  assert(event && typeof event === "object" && !Array.isArray(event), "INVALID_EVENT", "状态事件必须是JSON对象", 400);
  const unknown = Object.keys(event).filter((key) => !STATUS_EVENT_KEYS.has(key));
  assert(unknown.length === 0, "INVALID_EVENT", "状态事件包含未知字段", 400, { fields: unknown });
  assert(typeof event.eventId === "string" && EVENT_ID.test(event.eventId), "INVALID_EVENT", "eventId格式无效", 400);
  for (const key of ["ticketNo", "rawStatus"]) assert(typeof event[key] === "string" && event[key].trim() && event[key].length <= 128, "INVALID_EVENT", `${key}格式无效`, 400);
  assert(Number.isSafeInteger(event.sequence) && event.sequence >= 1, "INVALID_EVENT", "sequence必须为正整数", 400);
  assert(typeof event.occurredAt === "string" && UTC_INSTANT.test(event.occurredAt) && Number.isFinite(Date.parse(event.occurredAt)), "INVALID_EVENT", "occurredAt必须为UTC ISO时间", 400);
  return { eventId: event.eventId, ticketNo: event.ticketNo.trim(), rawStatus: event.rawStatus.trim(), occurredAt: event.occurredAt, sequence: event.sequence };
}

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function mapTicket(row) {
  return {
    externalTicketId: row.external_ticket_id,
    systemCode: row.system_code,
    ticketNo: row.ticket_no,
    rawStatus: row.raw_status,
    unifiedStatus: row.unified_status,
    ticketUrl: row.ticket_url,
    lastEventSequence: row.last_event_sequence === null || row.last_event_sequence === undefined ? null : Number(row.last_event_sequence),
    lastEventOccurredAt: row.last_event_occurred_at ?? null,
    lastEventId: row.last_event_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapIntegrationTask(row, { admin = false } = {}) {
  if (!row) return null;
  return {
    taskId: row.task_id,
    caseId: row.case_id,
    operation: row.operation,
    systemCode: row.system_code,
    draftVersion: Number(row.draft_version),
    status: row.status,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    nextAttemptAt: row.next_attempt_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    ...(admin ? { lockUntil: row.lock_until, lastErrorMessage: row.last_error_message, idempotencyKey: row.idempotency_key } : {}),
  };
}

export class DemandService {
  constructor({ db, catalog, connectors, audit, confirmationSecret, confirmationTtlSeconds = 600, integrationMaxAttempts = 5, integrationRetryBaseSeconds = 30, businessWebhookMaxAgeSeconds = 86400, now = () => Date.now() }) {
    this.db = db;
    this.catalog = catalog;
    this.connectors = connectors;
    this.audit = audit;
    this.confirmationSecret = confirmationSecret;
    this.confirmationTtlSeconds = confirmationTtlSeconds;
    this.integrationMaxAttempts = integrationMaxAttempts;
    this.integrationRetryBaseSeconds = integrationRetryBaseSeconds;
    this.businessWebhookMaxAgeSeconds = businessWebhookMaxAgeSeconds;
    this.now = now;
  }

  nextRequestNo() {
    const result = this.db.prepare("UPDATE counters SET counter_value = counter_value + 1 WHERE counter_name = 'request' RETURNING counter_value").get();
    const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date()).replaceAll("-", "");
    return `REQ-${date}-${String(result.counter_value).padStart(6, "0")}`;
  }

  createDraft(employee, { serviceCode, fields = {}, conversationId = null }) {
    const service = this.catalog.get(serviceCode, employee);
    const schema = this.catalog.getSchema(serviceCode, undefined, employee);
    const validation = validateFields(schema, fields);
    const status = validation.valid ? CaseStatus.DRAFT : CaseStatus.WAITING_INFORMATION;
    const timestamp = new Date().toISOString();
    const caseId = crypto.randomUUID();
    const created = withTransaction(this.db, () => {
      const globalRequestNo = this.nextRequestNo();
      this.db.prepare(`
        INSERT INTO demand_cases
        (case_id, global_request_no, requester_employee_id, requester_department_id, requester_name, conversation_id,
         service_code, title, description, fields_json, schema_version, version, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        caseId, globalRequestNo, employee.employeeId, employee.departmentId, employee.name, conversationId,
        serviceCode, service.serviceName, service.description, JSON.stringify(validation.normalizedFields), schema.version,
        status, timestamp, timestamp,
      );
      return globalRequestNo;
    });
    this.audit.record({ caseId, actorType: "EMPLOYEE", actorId: employee.employeeId, action: "CREATE_DRAFT", details: { serviceCode, status, fieldNames: Object.keys(fields) } });
    return { case: this.getOwned(employee, created), validation };
  }

  updateDraft(employee, globalRequestNo, { fields = {}, expectedVersion }) {
    const current = this.getOwned(employee, globalRequestNo);
    assert(EDITABLE_STATUSES.has(current.status), "CASE_NOT_EDITABLE", "当前状态不允许修改草稿", 409, { status: current.status });
    assert(Number.isInteger(expectedVersion), "EXPECTED_VERSION_REQUIRED", "必须提供当前草稿版本", 400);
    assert(current.version === expectedVersion, "VERSION_CONFLICT", "需求已被更新，请刷新后重试", 409, { expectedVersion, actualVersion: current.version });
    const schema = this.catalog.getSchema(current.serviceCode, current.schemaVersion, employee);
    const merged = { ...current.fields, ...fields };
    const validation = validateFields(schema, merged);
    const nextStatus = validation.valid ? CaseStatus.DRAFT : CaseStatus.WAITING_INFORMATION;
    assertTransition(current.status, nextStatus);
    const nextVersion = current.version + 1;
    this.db.prepare(`
      UPDATE demand_cases SET fields_json = ?, version = ?, status = ?, confirmation_version = NULL, updated_at = ?
      WHERE case_id = ?
    `).run(JSON.stringify(validation.normalizedFields), nextVersion, nextStatus, new Date().toISOString(), current.caseId);
    this.audit.record({ caseId: current.caseId, actorType: "EMPLOYEE", actorId: employee.employeeId, action: "UPDATE_DRAFT", details: { fromVersion: current.version, toVersion: nextVersion, status: nextStatus, fieldNames: Object.keys(fields) } });
    return { case: this.getOwned(employee, globalRequestNo), validation };
  }

  prepareConfirmation(employee, globalRequestNo) {
    const current = this.getOwned(employee, globalRequestNo);
    assert(EDITABLE_STATUSES.has(current.status), "CASE_NOT_CONFIRMABLE", "当前状态不能生成提交预览", 409, { status: current.status });
    const schema = this.catalog.getSchema(current.serviceCode, current.schemaVersion, employee);
    const validation = validateFields(schema, current.fields);
    assert(validation.valid, "DRAFT_INCOMPLETE", "需求信息尚未完整或校验未通过", 422, validation);
    assertTransition(current.status, CaseStatus.WAITING_CONFIRMATION);
    const timestamp = new Date().toISOString();
    this.db.prepare("UPDATE demand_cases SET status = ?, confirmation_version = ?, updated_at = ? WHERE case_id = ?")
      .run(CaseStatus.WAITING_CONFIRMATION, current.version, timestamp, current.caseId);
    const token = issueConfirmationToken({
      globalRequestNo,
      draftVersion: current.version,
      employeeId: employee.employeeId,
      ttlSeconds: this.confirmationTtlSeconds,
      secret: this.confirmationSecret,
    });
    this.audit.record({ caseId: current.caseId, actorType: "EMPLOYEE", actorId: employee.employeeId, action: "PREPARE_CONFIRMATION", details: { draftVersion: current.version } });
    const updated = this.getOwned(employee, globalRequestNo);
    return {
      case: updated,
      confirmationToken: token,
      expiresInSeconds: this.confirmationTtlSeconds,
      preview: this.buildPreview(updated),
    };
  }

  async submit(employee, globalRequestNo, { draftVersion, confirmationToken, idempotencyKey }) {
    const current = this.getOwned(employee, globalRequestNo);
    assert(typeof idempotencyKey === "string" && idempotencyKey.length >= 12 && idempotencyKey.length <= 180, "INVALID_IDEMPOTENCY_KEY", "幂等键长度应为12至180个字符", 400);
    verifyConfirmationToken(confirmationToken, {
      secret: this.confirmationSecret,
      globalRequestNo,
      draftVersion,
      employeeId: employee.employeeId,
    });
    assert(current.version === draftVersion && current.confirmationVersion === draftVersion, "VERSION_CONFLICT", "确认后的需求内容已经变化，请重新确认", 409);

    const existing = this.db.prepare("SELECT * FROM external_tickets WHERE idempotency_key = ?").get(idempotencyKey);
    if (existing) {
      assert(existing.case_id === current.caseId, "IDEMPOTENCY_CONFLICT", "幂等键已被其他需求使用", 409);
      const task = this.db.prepare("SELECT * FROM integration_tasks WHERE idempotency_key = ?").get(idempotencyKey);
      return { case: this.getOwned(employee, globalRequestNo), externalTickets: [mapTicket(existing)], integrationTask: mapIntegrationTask(task), idempotentReplay: true, queued: false };
    }

    const existingTask = this.db.prepare("SELECT * FROM integration_tasks WHERE idempotency_key = ?").get(idempotencyKey);
    if (existingTask) {
      assert(existingTask.case_id === current.caseId && Number(existingTask.draft_version) === draftVersion, "IDEMPOTENCY_CONFLICT", "幂等键已对应其他需求或版本", 409);
      const processed = await this.processSubmissionTask(existingTask.task_id, { throwOnFailure: false });
      return {
        case: this.getOwned(employee, globalRequestNo),
        externalTickets: this.listTickets(current.caseId),
        integrationTask: mapIntegrationTask(this.db.prepare("SELECT * FROM integration_tasks WHERE task_id = ?").get(existingTask.task_id)),
        idempotentReplay: true,
        queued: Boolean(processed.deferred || processed.failed),
      };
    }

    assert(current.status === CaseStatus.WAITING_CONFIRMATION || current.status === CaseStatus.SUBMIT_FAILED, "CASE_NOT_SUBMITTABLE", "当前状态不能提交", 409, { status: current.status });
    const service = this.catalog.get(current.serviceCode, employee);
    assertTransition(current.status, CaseStatus.SUBMITTING);
    const taskId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    withTransaction(this.db, () => {
      this.db.prepare("UPDATE demand_cases SET status = ?, updated_at = ? WHERE case_id = ?").run(CaseStatus.SUBMITTING, timestamp, current.caseId);
      this.db.prepare(`
        INSERT INTO integration_tasks
        (task_id, case_id, operation, system_code, draft_version, idempotency_key, status, attempt_count,
         max_attempts, next_attempt_at, created_at, updated_at)
        VALUES (?, ?, 'CREATE_TICKET', ?, ?, ?, 'PENDING', 0, ?, ?, ?, ?)
      `).run(taskId, current.caseId, service.targetSystem, draftVersion, idempotencyKey, this.integrationMaxAttempts, timestamp, timestamp, timestamp);
    });
    this.audit.record({ caseId: current.caseId, actorType: "EMPLOYEE", actorId: employee.employeeId, action: "SUBMIT_REQUEST", details: { draftVersion, idempotencyKey, taskId } });
    const processed = await this.processSubmissionTask(taskId, { force: true, throwOnFailure: false });
    if (processed.failed && !processed.retriable) throw processed.error;
    return {
      case: this.getOwned(employee, globalRequestNo),
      externalTickets: this.listTickets(current.caseId),
      integrationTask: processed.task,
      idempotentReplay: false,
      queued: Boolean(processed.retriable),
    };
  }

  async processSubmissionTask(taskId, { force = false, throwOnFailure = false } = {}) {
    const original = this.db.prepare("SELECT * FROM integration_tasks WHERE task_id = ?").get(taskId);
    if (!original) throw new AppError("INTEGRATION_TASK_NOT_FOUND", "集成任务不存在", 404, { taskId });
    if (original.status === "SUCCEEDED") return { task: mapIntegrationTask(original), succeeded: true };
    if (original.status === "DEAD") return { task: mapIntegrationTask(original), deferred: true, reason: "DEAD" };
    const now = new Date();
    const due = original.status === "PENDING"
      || (original.status === "RETRY_WAIT" && (force || new Date(original.next_attempt_at) <= now))
      || (original.status === "RUNNING" && original.lock_until && new Date(original.lock_until) <= now);
    if (!due) return { task: mapIntegrationTask(original), deferred: true, reason: original.status };

    const lockUntil = new Date(now.getTime() + 60000).toISOString();
    const attemptCount = Number(original.attempt_count) + 1;
    const claim = this.db.prepare(`
      UPDATE integration_tasks SET status = 'RUNNING', attempt_count = ?, lock_until = ?, updated_at = ?
      WHERE task_id = ? AND status = ? AND attempt_count = ?
    `).run(attemptCount, lockUntil, now.toISOString(), taskId, original.status, Number(original.attempt_count));
    if (Number(claim.changes) !== 1) return { task: mapIntegrationTask(this.db.prepare("SELECT * FROM integration_tasks WHERE task_id = ?").get(taskId)), deferred: true, reason: "CLAIMED_BY_OTHER_WORKER" };

    const caseRow = this.db.prepare("SELECT * FROM demand_cases WHERE case_id = ?").get(original.case_id);
    if (!caseRow) throw new AppError("CASE_NOT_FOUND", "集成任务关联的需求不存在", 500, { taskId });
    if (caseRow.status === CaseStatus.SUBMIT_FAILED) {
      assertTransition(caseRow.status, CaseStatus.SUBMITTING);
      this.db.prepare("UPDATE demand_cases SET status = ?, updated_at = ? WHERE case_id = ?").run(CaseStatus.SUBMITTING, now.toISOString(), caseRow.case_id);
      caseRow.status = CaseStatus.SUBMITTING;
    }
    const demandCase = this.mapCase(caseRow);
    const employee = demandCase.requester;
    try {
      const service = this.catalog.get(demandCase.serviceCode);
      assert(service.targetSystem === original.system_code, "INTEGRATION_ROUTING_MISMATCH", "任务目标系统与服务目录不一致", 500);
      const connector = this.connectors.get(original.system_code);
      const request = { case: demandCase, service, fields: demandCase.fields, requester: employee, idempotencyKey: original.idempotency_key };
      const validation = connector.validate(request);
      assert(validation.valid, "DOWNSTREAM_VALIDATION_ERROR", "下游系统校验未通过", 422, validation.errors);
      const result = await connector.createTicket(request);
      const completedAt = new Date().toISOString();
      let ticket = this.db.prepare("SELECT * FROM external_tickets WHERE idempotency_key = ?").get(original.idempotency_key);
      withTransaction(this.db, () => {
        if (!ticket) {
          const externalTicketId = crypto.randomUUID();
          this.db.prepare(`
            INSERT INTO external_tickets
            (external_ticket_id, case_id, system_code, ticket_no, raw_status, unified_status, idempotency_key, ticket_url, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(externalTicketId, caseRow.case_id, result.systemCode, result.ticketNo, result.rawStatus, result.unifiedStatus, original.idempotency_key, result.ticketUrl, completedAt, completedAt);
          ticket = this.db.prepare("SELECT * FROM external_tickets WHERE external_ticket_id = ?").get(externalTicketId);
        } else {
          assert(ticket.case_id === caseRow.case_id, "IDEMPOTENCY_CONFLICT", "已存在工单属于其他需求", 409);
        }
        const latestCase = this.db.prepare("SELECT status FROM demand_cases WHERE case_id = ?").get(caseRow.case_id);
        if (latestCase.status !== CaseStatus.SUBMITTED) {
          assertTransition(latestCase.status, CaseStatus.SUBMITTED);
          this.db.prepare("UPDATE demand_cases SET status = ?, updated_at = ? WHERE case_id = ?").run(CaseStatus.SUBMITTED, completedAt, caseRow.case_id);
        }
        this.db.prepare(`
          UPDATE integration_tasks SET status = 'SUCCEEDED', lock_until = NULL, last_error_code = NULL,
            last_error_message = NULL, updated_at = ?, completed_at = ? WHERE task_id = ?
        `).run(completedAt, completedAt, taskId);
      });
      this.audit.record({ caseId: caseRow.case_id, actorType: "SYSTEM", actorId: service.targetSystem, action: "CREATE_EXTERNAL_TICKET", details: { taskId, attemptCount, ticketNo: ticket.ticket_no, unifiedStatus: ticket.unified_status } });
      return { task: mapIntegrationTask(this.db.prepare("SELECT * FROM integration_tasks WHERE task_id = ?").get(taskId)), ticket: mapTicket(ticket), succeeded: true };
    } catch (error) {
      const errorCode = error.code ?? "INTERNAL_ERROR";
      const transient = Number(error.status ?? 500) >= 500 || ["DOWNSTREAM_UNAVAILABLE", "INTERNAL_ERROR"].includes(errorCode);
      const dead = !transient || attemptCount >= Number(original.max_attempts);
      const taskStatus = dead ? "DEAD" : "RETRY_WAIT";
      const backoffSeconds = Math.min(86400, this.integrationRetryBaseSeconds * (2 ** Math.max(0, attemptCount - 1)));
      const nextAttemptAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();
      const failedAt = new Date().toISOString();
      withTransaction(this.db, () => {
        this.db.prepare(`
          UPDATE integration_tasks SET status = ?, next_attempt_at = ?, lock_until = NULL, last_error_code = ?,
            last_error_message = ?, updated_at = ? WHERE task_id = ?
        `).run(taskStatus, nextAttemptAt, errorCode, String(error.message ?? "下游调用失败").slice(0, 500), failedAt, taskId);
        const latestCase = this.db.prepare("SELECT status FROM demand_cases WHERE case_id = ?").get(caseRow.case_id);
        if (dead && latestCase.status === CaseStatus.SUBMITTING) {
          assertTransition(latestCase.status, CaseStatus.SUBMIT_FAILED);
          this.db.prepare("UPDATE demand_cases SET status = ?, updated_at = ? WHERE case_id = ?").run(CaseStatus.SUBMIT_FAILED, failedAt, caseRow.case_id);
        }
      });
      this.audit.record({ caseId: caseRow.case_id, actorType: "SYSTEM", actorId: original.system_code, action: "PROCESS_INTEGRATION_TASK", outcome: "FAILURE", details: { taskId, attemptCount, taskStatus, code: errorCode, nextAttemptAt } });
      if (throwOnFailure) throw error;
      return { task: mapIntegrationTask(this.db.prepare("SELECT * FROM integration_tasks WHERE task_id = ?").get(taskId)), failed: true, retriable: !dead, errorCode, error };
    }
  }

  async processDueSubmissionTasks({ limit = 20 } = {}) {
    const normalizedLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const now = new Date().toISOString();
    const tasks = this.db.prepare(`
      SELECT task_id FROM integration_tasks
      WHERE status = 'PENDING'
         OR (status = 'RETRY_WAIT' AND next_attempt_at <= ?)
         OR (status = 'RUNNING' AND lock_until IS NOT NULL AND lock_until <= ?)
      ORDER BY next_attempt_at ASC LIMIT ?
    `).all(now, now, normalizedLimit);
    const results = [];
    for (const { task_id } of tasks) results.push(await this.processSubmissionTask(task_id, { throwOnFailure: false }));
    return {
      selected: tasks.length,
      succeeded: results.filter((result) => result.succeeded).length,
      failed: results.filter((result) => result.failed).length,
      deferred: results.filter((result) => result.deferred).length,
      results,
    };
  }

  listIntegrationTasks({ status } = {}) {
    if (status) return this.db.prepare("SELECT * FROM integration_tasks WHERE status = ? ORDER BY updated_at DESC").all(String(status).toUpperCase()).map((row) => mapIntegrationTask(row, { admin: true }));
    return this.db.prepare("SELECT * FROM integration_tasks ORDER BY updated_at DESC").all().map((row) => mapIntegrationTask(row, { admin: true }));
  }

  async retryIntegrationTask(taskId, actorId) {
    const task = this.db.prepare("SELECT * FROM integration_tasks WHERE task_id = ?").get(taskId);
    if (!task) throw new AppError("INTEGRATION_TASK_NOT_FOUND", "集成任务不存在", 404, { taskId });
    assert(["DEAD", "RETRY_WAIT"].includes(task.status), "INTEGRATION_TASK_NOT_RETRYABLE", "当前任务状态不能人工重试", 409, { status: task.status });
    const timestamp = new Date().toISOString();
    this.db.prepare(`
      UPDATE integration_tasks SET status = 'PENDING', next_attempt_at = ?, lock_until = NULL,
        max_attempts = MAX(max_attempts, attempt_count + 1), updated_at = ? WHERE task_id = ?
    `).run(timestamp, timestamp, taskId);
    this.audit.record({ caseId: task.case_id, actorType: "OPERATOR", actorId, action: "RETRY_INTEGRATION_TASK", details: { taskId, from: task.status } });
    return this.processSubmissionTask(taskId, { force: true, throwOnFailure: false });
  }

  async reconcileExternalTickets({ limit = 20, systemCode } = {}) {
    const normalizedLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const normalizedSystem = systemCode ? String(systemCode).toUpperCase() : null;
    if (normalizedSystem && !/^[A-Z][A-Z0-9_]{1,63}$/.test(normalizedSystem)) throw new AppError("INVALID_SYSTEM_CODE", "系统编码格式无效", 400);
    const terminal = [CaseStatus.CLOSED, CaseStatus.REJECTED, CaseStatus.CANCELLED];
    const sql = `
      SELECT t.* FROM external_tickets t
      JOIN demand_cases c ON c.case_id = t.case_id
      WHERE c.status NOT IN (?, ?, ?)
        ${normalizedSystem ? "AND t.system_code = ?" : ""}
      ORDER BY t.updated_at ASC LIMIT ?
    `;
    const parameters = normalizedSystem ? [...terminal, normalizedSystem, normalizedLimit] : [...terminal, normalizedLimit];
    const tickets = this.db.prepare(sql).all(...parameters);
    const results = [];
    for (const ticket of tickets) {
      try {
        const connector = this.connectors.get(ticket.system_code);
        if (!connector.capabilities().getTicket || typeof connector.getTicket !== "function") {
          results.push({ ticketNo: ticket.ticket_no, systemCode: ticket.system_code, status: "SKIPPED", code: "GET_TICKET_UNSUPPORTED" });
          continue;
        }
        const downstream = await connector.getTicket(ticket.ticket_no);
        assert(downstream.systemCode === ticket.system_code && downstream.ticketNo === ticket.ticket_no, "DOWNSTREAM_CONTRACT_ERROR", "查单响应与本地工单不一致", 422);
        const caseRow = this.db.prepare("SELECT * FROM demand_cases WHERE case_id = ?").get(ticket.case_id);
        if (!caseRow) throw new AppError("CASE_NOT_FOUND", "下游工单关联需求不存在", 500);
        assertTransition(caseRow.status, downstream.unifiedStatus);
        const changed = ticket.raw_status !== downstream.rawStatus
          || ticket.unified_status !== downstream.unifiedStatus
          || (downstream.ticketUrl && ticket.ticket_url !== downstream.ticketUrl);
        if (changed) {
          const timestamp = new Date().toISOString();
          withTransaction(this.db, () => {
            this.db.prepare(`
              UPDATE external_tickets SET raw_status = ?, unified_status = ?, ticket_url = ?, updated_at = ?
              WHERE external_ticket_id = ?
            `).run(downstream.rawStatus, downstream.unifiedStatus, downstream.ticketUrl ?? ticket.ticket_url, timestamp, ticket.external_ticket_id);
            if (caseRow.status !== downstream.unifiedStatus) {
              this.db.prepare("UPDATE demand_cases SET status = ?, updated_at = ? WHERE case_id = ?")
                .run(downstream.unifiedStatus, timestamp, ticket.case_id);
            }
          });
          this.audit.record({ caseId: ticket.case_id, actorType: "SYSTEM", actorId: ticket.system_code, action: "RECONCILE_EXTERNAL_TICKET", details: { ticketNo: ticket.ticket_no, from: ticket.unified_status, to: downstream.unifiedStatus, rawStatus: downstream.rawStatus } });
        }
        results.push({ ticketNo: ticket.ticket_no, systemCode: ticket.system_code, status: changed ? "UPDATED" : "UNCHANGED", unifiedStatus: downstream.unifiedStatus });
      } catch (error) {
        const code = error.code ?? "RECONCILIATION_FAILED";
        this.audit.record({ caseId: ticket.case_id, actorType: "SYSTEM", actorId: ticket.system_code, action: "RECONCILE_EXTERNAL_TICKET", outcome: "FAILURE", details: { ticketNo: ticket.ticket_no, code } });
        results.push({ ticketNo: ticket.ticket_no, systemCode: ticket.system_code, status: "FAILED", code });
      }
    }
    return {
      selected: tickets.length,
      updated: results.filter((result) => result.status === "UPDATED").length,
      unchanged: results.filter((result) => result.status === "UNCHANGED").length,
      skipped: results.filter((result) => result.status === "SKIPPED").length,
      failed: results.filter((result) => result.status === "FAILED").length,
      results,
    };
  }

  listOwned(employee) {
    return this.db.prepare("SELECT * FROM demand_cases WHERE requester_employee_id = ? ORDER BY updated_at DESC")
      .all(employee.employeeId).map((row) => this.mapCase(row));
  }

  listAdminCases({ status, serviceCode, limit = 100 } = {}) {
    const normalizedLimit = Math.max(1, Math.min(200, Number(limit) || 100));
    const clauses = [];
    const parameters = [];
    if (status) {
      const normalizedStatus = String(status).toUpperCase();
      if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(normalizedStatus)) throw new AppError("INVALID_CASE_STATUS", "需求状态格式无效", 400);
      clauses.push("status = ?");
      parameters.push(normalizedStatus);
    }
    if (serviceCode) {
      const normalizedServiceCode = String(serviceCode).toUpperCase();
      if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(normalizedServiceCode)) throw new AppError("INVALID_SERVICE_CODE", "服务编码格式无效", 400);
      clauses.push("service_code = ?");
      parameters.push(normalizedServiceCode);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM demand_cases ${where} ORDER BY updated_at DESC LIMIT ?`).all(...parameters, normalizedLimit).map((row) => {
      const mapped = this.mapCase(row);
      return {
        globalRequestNo: mapped.globalRequestNo,
        requester: mapped.requester,
        serviceCode: mapped.serviceCode,
        title: mapped.title,
        status: mapped.status,
        externalTickets: mapped.externalTickets,
        integrationTask: mapped.integrationTask,
        createdAt: mapped.createdAt,
        updatedAt: mapped.updatedAt,
      };
    });
  }

  getOwned(employee, globalRequestNo) {
    const row = this.db.prepare("SELECT * FROM demand_cases WHERE global_request_no = ? AND requester_employee_id = ?").get(globalRequestNo, employee.employeeId);
    if (!row) throw new AppError("CASE_NOT_FOUND", "需求不存在或无权查看", 404);
    return this.mapCase(row);
  }

  getByRequestNo(globalRequestNo) {
    const row = this.db.prepare("SELECT * FROM demand_cases WHERE global_request_no = ?").get(globalRequestNo);
    if (!row) throw new AppError("CASE_NOT_FOUND", "需求不存在", 404);
    return this.mapCase(row);
  }

  mapCase(row) {
    return {
      caseId: row.case_id,
      globalRequestNo: row.global_request_no,
      requester: { employeeId: row.requester_employee_id, departmentId: row.requester_department_id, name: row.requester_name },
      conversationId: row.conversation_id,
      serviceCode: row.service_code,
      title: row.title,
      description: row.description,
      fields: parseJson(row.fields_json),
      schemaVersion: Number(row.schema_version),
      version: Number(row.version),
      status: row.status,
      confirmationVersion: row.confirmation_version === null ? null : Number(row.confirmation_version),
      externalTickets: this.listTickets(row.case_id),
      integrationTask: mapIntegrationTask(this.db.prepare("SELECT * FROM integration_tasks WHERE case_id = ? ORDER BY created_at DESC LIMIT 1").get(row.case_id)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listTickets(caseId) {
    return this.db.prepare("SELECT * FROM external_tickets WHERE case_id = ? ORDER BY created_at").all(caseId).map(mapTicket);
  }

  buildPreview(demandCase) {
    const service = this.catalog.get(demandCase.serviceCode);
    const schema = this.catalog.getSchema(demandCase.serviceCode, demandCase.schemaVersion);
    return {
      globalRequestNo: demandCase.globalRequestNo,
      serviceName: service.serviceName,
      targetSystem: service.targetSystem,
      riskLevel: service.riskLevel,
      fields: schema.fields.map((definition) => ({ name: definition.name, label: definition.label, value: demandCase.fields[definition.name] ?? null })),
      confirmationNotice: "确认后将向下游系统提交工单；本平台不会直接修改CRM/OA/ERP业务主数据。",
    };
  }

  applyStatusEvent(systemCode, event, payloadHash) {
    const normalized = normalizeStatusEvent(event);
    const existingEvent = this.db.prepare("SELECT * FROM webhook_events WHERE source_system = ? AND event_id = ?").get(systemCode, normalized.eventId);
    if (existingEvent) {
      assert(existingEvent.payload_hash === payloadHash, "EVENT_ID_REUSE", "相同事件ID对应了不同内容", 409);
      const ticket = this.db.prepare("SELECT * FROM external_tickets WHERE system_code = ? AND ticket_no = ?").get(systemCode, normalized.ticketNo);
      return { duplicate: true, ticket: ticket ? mapTicket(ticket) : null };
    }
    const ageMs = this.now() - Date.parse(normalized.occurredAt);
    assert(ageMs >= -300_000, "STATUS_EVENT_IN_FUTURE", "状态事件时间位于允许窗口之后", 409);
    assert(ageMs <= this.businessWebhookMaxAgeSeconds * 1000, "STATUS_EVENT_EXPIRED", "状态事件超过接收时效", 409);
    const ticket = this.db.prepare("SELECT * FROM external_tickets WHERE system_code = ? AND ticket_no = ?").get(systemCode, normalized.ticketNo);
    if (!ticket) throw new AppError("EXTERNAL_TICKET_NOT_FOUND", "下游工单尚未登记", 404);
    if (ticket.last_event_sequence !== null && ticket.last_event_sequence !== undefined) {
      assert(normalized.sequence > Number(ticket.last_event_sequence), "STATUS_EVENT_OUT_OF_ORDER", "状态事件序号不高于该工单已处理序号", 409, { latestSequence: Number(ticket.last_event_sequence) });
    }
    const connector = this.connectors.get(systemCode);
    const nextStatus = connector.mapStatus(normalized.rawStatus);
    const currentCase = this.db.prepare("SELECT * FROM demand_cases WHERE case_id = ?").get(ticket.case_id);
    assertTransition(currentCase.status, nextStatus);
    const timestamp = new Date(this.now()).toISOString();
    withTransaction(this.db, () => {
      this.db.prepare("INSERT INTO webhook_events (source_system, event_id, payload_hash, received_at) VALUES (?, ?, ?, ?)")
        .run(systemCode, normalized.eventId, payloadHash, timestamp);
      this.db.prepare("UPDATE external_tickets SET raw_status = ?, unified_status = ?, last_event_sequence = ?, last_event_occurred_at = ?, last_event_id = ?, updated_at = ? WHERE external_ticket_id = ?")
        .run(normalized.rawStatus, nextStatus, normalized.sequence, normalized.occurredAt, normalized.eventId, timestamp, ticket.external_ticket_id);
      this.db.prepare("UPDATE demand_cases SET status = ?, updated_at = ? WHERE case_id = ?")
        .run(nextStatus, timestamp, ticket.case_id);
    });
    this.audit.record({ caseId: ticket.case_id, actorType: "SYSTEM", actorId: systemCode, action: "APPLY_STATUS_EVENT", details: { eventId: normalized.eventId, ticketNo: normalized.ticketNo, sequence: normalized.sequence, occurredAt: normalized.occurredAt, rawStatus: normalized.rawStatus, unifiedStatus: nextStatus } });
    return { duplicate: false, case: this.mapCase(this.db.prepare("SELECT * FROM demand_cases WHERE case_id = ?").get(ticket.case_id)), ticket: mapTicket(this.db.prepare("SELECT * FROM external_tickets WHERE external_ticket_id = ?").get(ticket.external_ticket_id)) };
  }
}
