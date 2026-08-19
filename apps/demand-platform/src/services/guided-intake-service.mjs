import crypto from "node:crypto";
import { AppError, assert } from "../domain/errors.mjs";
import { validateFields } from "../domain/schema-validation.mjs";

const ACTIONS = new Set(["COLLECT", "PREPARE_CONFIRMATION", "CONFIRM_SUBMIT"]);
const ALLOWED_INPUTS = Object.freeze({
  COLLECT: new Set(["action", "serviceCode", "conversationId", "fieldUpdates", "globalRequestNo", "expectedVersion"]),
  PREPARE_CONFIRMATION: new Set(["action", "conversationId", "globalRequestNo"]),
  CONFIRM_SUBMIT: new Set(["action", "conversationId", "globalRequestNo", "draftVersion", "confirmationToken", "idempotencyKey", "employeeConfirmed"]),
});

function ensureObject(value, code, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(code, message, 400);
  return value;
}

function questionFor(definition, error = null) {
  const constraints = {};
  for (const key of ["minLength", "maxLength", "pattern"]) {
    if (definition[key] !== undefined) constraints[key] = definition[key];
  }
  return {
    fieldName: definition.name,
    label: definition.label,
    type: definition.type,
    required: Boolean(definition.required),
    prompt: error?.message || definition.help || `请提供${definition.label}`,
    help: definition.help ?? "",
    ...(definition.options ? { options: definition.options } : {}),
    ...(Object.keys(constraints).length > 0 ? { constraints } : {}),
    ...(error ? { errorCode: error.code } : {}),
  };
}

function buildQuestions(schema, validation) {
  const definitions = new Map((schema.fields ?? []).map((field) => [field.name, field]));
  const questions = [];
  const included = new Set();
  for (const issue of [...validation.fieldErrors, ...validation.missingFields]) {
    const definition = definitions.get(issue.name);
    if (!definition || included.has(issue.name)) continue;
    questions.push(questionFor(definition, validation.fieldErrors.includes(issue) ? issue : null));
    included.add(issue.name);
  }
  return questions;
}

export class GuidedIntakeService {
  constructor({ catalog, demands }) {
    this.catalog = catalog;
    this.demands = demands;
  }

  assertConversation(demandCase, conversationId) {
    if (!conversationId) return;
    assert(demandCase.conversationId === conversationId, "CONVERSATION_MISMATCH", "会话与需求草稿不匹配", 409);
  }

  async turn(employee, input = {}) {
    ensureObject(input, "INVALID_GUIDED_INTAKE_REQUEST", "引导式填单请求必须是对象");
    const action = String(input.action ?? "COLLECT").toUpperCase();
    assert(ACTIONS.has(action), "INVALID_GUIDED_INTAKE_ACTION", "不支持的引导式填单动作", 400, { action });
    const unknown = Object.keys(input).filter((key) => !ALLOWED_INPUTS[action].has(key));
    assert(unknown.length === 0, "INVALID_GUIDED_INTAKE_REQUEST", "引导式填单请求包含未知字段", 400, { unknown });
    if (input.conversationId !== undefined && input.conversationId !== null) {
      assert(typeof input.conversationId === "string" && input.conversationId.length >= 1 && input.conversationId.length <= 120, "INVALID_CONVERSATION_ID", "会话编号格式无效", 400);
    }

    if (action === "COLLECT") return this.collect(employee, input);

    assert(typeof input.globalRequestNo === "string" && input.globalRequestNo, "REQUEST_NO_REQUIRED", "必须提供统一需求编号", 400);
    const current = this.demands.getOwned(employee, input.globalRequestNo);
    this.assertConversation(current, input.conversationId);

    if (action === "PREPARE_CONFIRMATION") {
      const prepared = this.demands.prepareConfirmation(employee, input.globalRequestNo);
      return {
        stage: "AWAITING_EXPLICIT_CONFIRMATION",
        message: "信息已完整。请核对预览并明确确认后再提交；未确认不会创建下游工单。",
        ...prepared,
      };
    }

    assert(input.employeeConfirmed === true, "EXPLICIT_CONFIRMATION_REQUIRED", "只有员工明确确认后才能提交需求", 409);
    const submitted = await this.demands.submit(employee, input.globalRequestNo, {
      draftVersion: input.draftVersion,
      confirmationToken: input.confirmationToken,
      idempotencyKey: input.idempotencyKey,
    });
    return {
      stage: submitted.queued ? "SUBMISSION_QUEUED" : "SUBMITTED",
      message: submitted.queued ? "需求已受理，平台将在后台重试下游建单。" : "需求已提交。",
      ...submitted,
    };
  }

  collect(employee, input) {
    const fields = input.fieldUpdates === undefined
      ? {}
      : ensureObject(input.fieldUpdates, "INVALID_FIELD_UPDATES", "fieldUpdates必须是结构化对象");
    let result;
    if (input.globalRequestNo) {
      const current = this.demands.getOwned(employee, input.globalRequestNo);
      this.assertConversation(current, input.conversationId);
      result = Object.keys(fields).length === 0
        ? { case: current, validation: validateFields(this.catalog.getSchema(current.serviceCode, current.schemaVersion, employee), current.fields) }
        : this.demands.updateDraft(employee, input.globalRequestNo, { fields, expectedVersion: input.expectedVersion });
    } else {
      assert(typeof input.serviceCode === "string" && input.serviceCode, "SERVICE_CODE_REQUIRED", "首次收集信息必须提供服务编码", 400);
      const conversationId = input.conversationId || crypto.randomUUID();
      result = this.demands.createDraft(employee, { serviceCode: input.serviceCode, fields, conversationId });
    }

    const schema = this.catalog.getSchema(result.case.serviceCode, result.case.schemaVersion, employee);
    const questions = buildQuestions(schema, result.validation);
    if (result.validation.valid) {
      return {
        stage: "READY_FOR_CONFIRMATION",
        message: "信息已收集完整。下一步应生成提交预览，且必须由员工明确确认。",
        case: result.case,
        validation: result.validation,
        nextQuestions: [],
      };
    }
    return {
      stage: "COLLECTING_INFORMATION",
      message: questions[0]?.prompt ?? "请补充或修正需求信息。",
      case: result.case,
      validation: result.validation,
      nextQuestions: questions,
    };
  }
}
