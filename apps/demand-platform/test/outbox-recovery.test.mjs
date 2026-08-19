import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createApplication } from "../src/server.mjs";
import { BaseConnector } from "../src/connectors/base-connector.mjs";
import { AppError } from "../src/domain/errors.mjs";

const employee = { employeeId: "E-OUTBOX", departmentId: "D-ORG", name: "恢复测试员工" };
const completeFields = {
  customerCode: "C000123",
  currentOwnerEmployeeId: "E10009",
  newOwnerEmployeeId: "E20002",
  reason: "区域职责发生调整",
  effectiveDate: "2026-08-20",
};

function prepare(app) {
  const draft = app.services.demands.createDraft(employee, { serviceCode: "CRM_ACCOUNT_CHANGE", fields: completeFields });
  const confirmation = app.services.demands.prepareConfirmation(employee, draft.case.globalRequestNo);
  return { draft, confirmation };
}

class TimeoutAfterCreateConnector extends BaseConnector {
  constructor(store, failAfterCreate) {
    super("CRM");
    this.store = store;
    this.failAfterCreate = failAfterCreate;
  }

  validate(request) {
    return { valid: request.service.targetSystem === "CRM", errors: [] };
  }

  createTicket(request) {
    let result = this.store.get(request.idempotencyKey);
    if (!result) {
      const suffix = crypto.createHash("sha256").update(request.idempotencyKey).digest("hex").slice(0, 12).toUpperCase();
      result = { systemCode: "CRM", ticketNo: `CRM-${suffix}`, rawStatus: "OPEN", unifiedStatus: "SUBMITTED", ticketUrl: `https://crm.example.invalid/${suffix}` };
      this.store.set(request.idempotencyKey, result);
    }
    if (this.failAfterCreate) throw new AppError("DOWNSTREAM_TIMEOUT_UNKNOWN_RESULT", "下游已接收但响应超时", 503);
    return result;
  }
}

class ToggleValidationConnector extends BaseConnector {
  constructor() {
    super("CRM");
    this.accept = false;
  }

  validate() {
    return this.accept ? { valid: true, errors: [] } : { valid: false, errors: [{ code: "BUSINESS_RULE", message: "模拟业务规则拒绝" }] };
  }

  createTicket(request) {
    return { systemCode: "CRM", ticketNo: `CRM-${request.case.globalRequestNo}`, rawStatus: "OPEN", unifiedStatus: "SUBMITTED", ticketUrl: null };
  }
}

test("下游已建单但响应超时后，Outbox可跨进程恢复且不重复建单", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-demand-outbox-"));
  const databasePath = path.join(directory, "recovery.db");
  const downstream = new Map();
  let app1;
  let app2;
  t.after(() => {
    app1?.db.close();
    app2?.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  app1 = createApplication({
    databasePath,
    confirmationSecret: "outbox-confirmation-secret-long-enough",
    webhookSecret: "outbox-webhook-secret-is-long-enough",
    integrationRetryBaseSeconds: 0,
    connectors: [new TimeoutAfterCreateConnector(downstream, true)],
  });
  const { confirmation } = prepare(app1);
  const requestNo = confirmation.case.globalRequestNo;
  const body = {
    draftVersion: confirmation.case.version,
    confirmationToken: confirmation.confirmationToken,
    idempotencyKey: `${requestNo}-v${confirmation.case.version}-submit`,
  };
  const accepted = await app1.services.demands.submit(employee, requestNo, body);
  assert.equal(accepted.queued, true);
  assert.equal(accepted.externalTickets.length, 0);
  assert.equal(downstream.size, 1);
  const failedCase = app1.services.demands.getOwned(employee, requestNo);
  assert.equal(failedCase.status, "SUBMITTING");
  assert.equal(failedCase.integrationTask.lastErrorCode, "DOWNSTREAM_TIMEOUT_UNKNOWN_RESULT");
  assert.equal(failedCase.integrationTask.lastErrorMessage, undefined);
  assert.equal(app1.services.demands.listIntegrationTasks()[0].status, "RETRY_WAIT");
  assert.match(app1.services.demands.listIntegrationTasks()[0].lastErrorMessage, /响应超时/);
  app1.db.close();
  app1 = null;

  app2 = createApplication({
    databasePath,
    confirmationSecret: "outbox-confirmation-secret-long-enough",
    webhookSecret: "outbox-webhook-secret-is-long-enough",
    integrationRetryBaseSeconds: 0,
    connectors: [new TimeoutAfterCreateConnector(downstream, false)],
  });
  const result = await app2.services.demands.processDueSubmissionTasks({ limit: 10 });
  assert.equal(result.succeeded, 1);
  assert.equal(downstream.size, 1);
  const recovered = app2.services.demands.getOwned(employee, requestNo);
  assert.equal(recovered.status, "SUBMITTED");
  assert.equal(recovered.externalTickets.length, 1);
  assert.equal(recovered.integrationTask.status, "SUCCEEDED");
  assert.equal(recovered.integrationTask.attemptCount, 2);
  assert.equal((await app2.services.demands.processDueSubmissionTasks({ limit: 10 })).selected, 0);
});

test("非瞬时业务错误进入死信，运营修复后可审计地人工重试", async (t) => {
  const connector = new ToggleValidationConnector();
  const app = createApplication({
    databasePath: ":memory:",
    confirmationSecret: "dead-letter-confirmation-secret-long-enough",
    webhookSecret: "dead-letter-webhook-secret-is-long-enough",
    connectors: [connector],
  });
  t.after(() => app.db.close());
  const { confirmation } = prepare(app);
  const requestNo = confirmation.case.globalRequestNo;
  await assert.rejects(() => app.services.demands.submit(employee, requestNo, {
    draftVersion: confirmation.case.version,
    confirmationToken: confirmation.confirmationToken,
    idempotencyKey: `${requestNo}-dead-letter-submit`,
  }), (error) => error.code === "DOWNSTREAM_VALIDATION_ERROR");
  const dead = app.services.demands.listIntegrationTasks()[0];
  assert.equal(dead.status, "DEAD");
  assert.equal(dead.attemptCount, 1);

  connector.accept = true;
  const retried = await app.services.demands.retryIntegrationTask(dead.taskId, "OPS-RECOVERY");
  assert.equal(retried.succeeded, true);
  assert.equal(app.services.demands.getOwned(employee, requestNo).status, "SUBMITTED");
  const actions = app.db.prepare("SELECT action FROM audit_events ORDER BY audit_id").all().map((row) => row.action);
  assert.ok(actions.includes("RETRY_INTEGRATION_TASK"));
  assert.ok(actions.includes("CREATE_EXTERNAL_TICKET"));
});
