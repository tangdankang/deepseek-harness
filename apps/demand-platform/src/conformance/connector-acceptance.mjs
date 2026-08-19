import crypto from "node:crypto";
import { HttpJsonConnector, validateConnectorConfiguration } from "../connectors/http-json-connector.mjs";
import { AppError } from "../domain/errors.mjs";
import { CaseStatus } from "../domain/state-machine.mjs";

const SYSTEM_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const UNIFIED_STATUSES = new Set(Object.values(CaseStatus));

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").toUpperCase();
}

function check(condition, message, details) {
  if (!condition) throw new AppError("INVALID_CONNECTOR_ACCEPTANCE_FIXTURE", message, 400, details);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateRequest(value, location) {
  check(isObject(value), `${location}必须是对象`);
  check(isObject(value.case) && typeof value.case.globalRequestNo === "string" && typeof value.case.serviceCode === "string", `${location}.case缺少编号或服务编码`);
  check(isObject(value.service) && typeof value.service.targetSystem === "string", `${location}.service缺少targetSystem`);
  check(isObject(value.fields), `${location}.fields必须是对象`);
  check(isObject(value.requester) && typeof value.requester.employeeId === "string" && typeof value.requester.departmentId === "string", `${location}.requester缺少员工或部门标识`);
  check(typeof value.idempotencyKey === "string" && value.idempotencyKey.length >= 16 && value.idempotencyKey.length <= 200, `${location}.idempotencyKey长度必须为16至200`);
}

export function validateConnectorAcceptanceFixture(fixture, configuration) {
  check(isObject(fixture), "验收夹具必须是对象");
  const allowed = new Set(["version", "systemCode", "validRequest", "invalidRequest", "conflictingRequest", "rawStatuses"]);
  const unknown = Object.keys(fixture).filter((key) => !allowed.has(key));
  check(unknown.length === 0, "验收夹具包含未知字段", { unknown });
  check(fixture.version === 1, "验收夹具version必须为1");
  check(SYSTEM_CODE.test(fixture.systemCode ?? ""), "验收夹具systemCode格式无效");
  validateRequest(fixture.validRequest, "validRequest");
  validateRequest(fixture.invalidRequest, "invalidRequest");
  validateRequest(fixture.conflictingRequest, "conflictingRequest");
  check(fixture.validRequest.service.targetSystem === fixture.systemCode, "有效请求目标系统与夹具systemCode不一致");
  check(fixture.invalidRequest.service.targetSystem !== fixture.systemCode, "无效请求必须使用不同的目标系统以验证拒绝路径");
  check(fixture.conflictingRequest.idempotencyKey === fixture.validRequest.idempotencyKey, "冲突请求必须复用有效请求的幂等键");
  check(hash(fixture.conflictingRequest) !== hash(fixture.validRequest), "冲突请求内容必须与有效请求不同");
  check(Array.isArray(fixture.rawStatuses) && fixture.rawStatuses.length > 0 && fixture.rawStatuses.every((item) => typeof item === "string" && item), "rawStatuses必须为非空字符串数组");
  const definitions = configuration.connectors.filter((item) => item.systemCode === fixture.systemCode);
  check(definitions.length === 1, "配置中必须且只能存在一个目标连接器", { systemCode: fixture.systemCode, count: definitions.length });
  check(Object.hasOwn(definitions[0].createTicket.services, fixture.validRequest.case.serviceCode), "配置缺少夹具服务映射", { serviceCode: fixture.validRequest.case.serviceCode });
  return {
    valid: true,
    systemCode: fixture.systemCode,
    fixtureHash: hash(fixture),
    rawStatusCount: new Set(fixture.rawStatuses).size,
  };
}

function targetClass(baseUrl) {
  const url = new URL(baseUrl);
  if (["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) return "LOOPBACK";
  return url.protocol === "https:" ? "REMOTE_HTTPS" : "REMOTE_INSECURE";
}

function passed(id, evidence = {}) {
  return { id, outcome: "PASS", evidence };
}

function skipped(id, reason) {
  return { id, outcome: "SKIP", evidence: { reason } };
}

function failed(id, error) {
  return {
    id,
    outcome: "FAIL",
    evidence: {
      errorCode: typeof error?.code === "string" ? error.code : "UNEXPECTED_ERROR",
      httpStatus: Number.isInteger(error?.details?.httpStatus) ? error.details.httpStatus : null,
    },
  };
}

function statusCoverage(connector, rawStatuses) {
  const mappings = rawStatuses.map((rawStatus) => ({ rawStatusHash: hash(rawStatus), unifiedStatus: connector.mapStatus(rawStatus) }));
  const invalid = mappings.filter((item) => !UNIFIED_STATUSES.has(item.unifiedStatus));
  if (invalid.length > 0) throw new AppError("CONNECTOR_STATUS_MAPPING_INVALID", "状态映射产生未知统一状态", 500, { count: invalid.length });
  return { tested: mappings.length, unifiedStatuses: [...new Set(mappings.map((item) => item.unifiedStatus))].sort() };
}

function secretValues(definition, env) {
  if (definition.auth.type === "none") return [];
  const value = String(env[definition.auth.envVar] ?? "");
  return value ? [value] : [];
}

function reportLeakCheck(report, fixture, secrets) {
  const serialized = JSON.stringify(report);
  const sensitive = [
    fixture.validRequest.case.globalRequestNo,
    fixture.validRequest.requester.employeeId,
    fixture.validRequest.requester.departmentId,
    fixture.validRequest.idempotencyKey,
    ...secrets,
  ].filter((value) => typeof value === "string" && value.length >= 4);
  return sensitive.every((value) => !serialized.includes(value));
}

export async function runConnectorAcceptance({ configuration, fixture, env = process.env, allowWrite = false, productionMode = true, fetchImpl = globalThis.fetch }) {
  const startedAt = new Date();
  const checks = [];
  let definition;
  try {
    const configReport = validateConnectorConfiguration(configuration, { productionMode });
    checks.push(passed("CONFIGURATION", { connectorCount: configReport.connectorCount, serviceMappings: configReport.serviceMappings }));
    const fixtureReport = validateConnectorAcceptanceFixture(fixture, configuration);
    checks.push(passed("FIXTURE", { rawStatusCount: fixtureReport.rawStatusCount }));
    [definition] = configuration.connectors.filter((item) => item.systemCode === fixture.systemCode);
  } catch (error) {
    checks.push(failed(checks.length === 0 ? "CONFIGURATION" : "FIXTURE", error));
  }

  if (definition && !allowWrite) {
    for (const id of ["VALIDATION", "INPUT_IMMUTABILITY", "CREATE_TICKET", "IDEMPOTENT_REPLAY", "IDEMPOTENCY_CONFLICT", "QUERY_TICKET", "STATUS_MAPPING"]) {
      checks.push(skipped(id, "需要显式允许测试环境写入"));
    }
  } else if (definition) {
    let connector;
    let first;
    try {
      connector = new HttpJsonConnector(definition, { env, productionMode, fetchImpl });
      const valid = connector.validate(fixture.validRequest);
      const invalid = connector.validate(fixture.invalidRequest);
      if (!valid.valid || invalid.valid || invalid.errors.length === 0) throw new AppError("CONNECTOR_VALIDATION_BEHAVIOR_INVALID", "有效/无效请求校验行为不符合预期", 500);
      checks.push(passed("VALIDATION", { invalidErrorCount: invalid.errors.length }));
    } catch (error) {
      checks.push(failed("VALIDATION", error));
    }
    if (connector) {
      const before = JSON.stringify(fixture.validRequest);
      try {
        first = await connector.createTicket(fixture.validRequest);
        if (JSON.stringify(fixture.validRequest) !== before) throw new AppError("CONNECTOR_MUTATED_INPUT", "连接器修改了输入对象", 500);
        checks.push(passed("INPUT_IMMUTABILITY"));
        checks.push(passed("CREATE_TICKET", { unifiedStatus: first.unifiedStatus, ticketUrlReturned: Boolean(first.ticketUrl) }));
      } catch (error) {
        checks.push(failed("CREATE_TICKET", error));
        if (JSON.stringify(fixture.validRequest) === before) checks.push(passed("INPUT_IMMUTABILITY"));
        else checks.push(failed("INPUT_IMMUTABILITY", new AppError("CONNECTOR_MUTATED_INPUT", "连接器修改了输入对象", 500)));
      }
      if (first) {
        try {
          const replay = await connector.createTicket(fixture.validRequest);
          if (replay.ticketNo !== first.ticketNo) throw new AppError("IDEMPOTENT_REPLAY_MISMATCH", "重复请求返回不同工单", 500);
          checks.push(passed("IDEMPOTENT_REPLAY"));
        } catch (error) { checks.push(failed("IDEMPOTENT_REPLAY", error)); }
        try {
          await connector.createTicket(fixture.conflictingRequest);
          checks.push(failed("IDEMPOTENCY_CONFLICT", new AppError("IDEMPOTENCY_CONFLICT_NOT_REJECTED", "冲突请求未被拒绝", 500)));
        } catch (error) {
          if (error?.code === "IDEMPOTENCY_CONFLICT") checks.push(passed("IDEMPOTENCY_CONFLICT"));
          else checks.push(failed("IDEMPOTENCY_CONFLICT", error));
        }
        if (connector.capabilities().getTicket) {
          try {
            const queried = await connector.getTicket(first.ticketNo);
            if (queried.ticketNo !== first.ticketNo) throw new AppError("QUERY_TICKET_MISMATCH", "查单编号不一致", 500);
            checks.push(passed("QUERY_TICKET", { unifiedStatus: queried.unifiedStatus }));
          } catch (error) { checks.push(failed("QUERY_TICKET", error)); }
        } else checks.push(skipped("QUERY_TICKET", "连接器未声明主动查单能力"));
      } else {
        for (const id of ["IDEMPOTENT_REPLAY", "IDEMPOTENCY_CONFLICT", "QUERY_TICKET"]) checks.push(skipped(id, "首次建单未成功"));
      }
      try { checks.push(passed("STATUS_MAPPING", statusCoverage(connector, fixture.rawStatuses))); }
      catch (error) { checks.push(failed("STATUS_MAPPING", error)); }
    } else {
      for (const id of ["INPUT_IMMUTABILITY", "CREATE_TICKET", "IDEMPOTENT_REPLAY", "IDEMPOTENCY_CONFLICT", "QUERY_TICKET", "STATUS_MAPPING"]) checks.push(skipped(id, "连接器初始化失败"));
    }
  }

  const finishedAt = new Date();
  const failedChecks = checks.filter((item) => item.outcome === "FAIL").length;
  const skippedChecks = checks.filter((item) => item.outcome === "SKIP").length;
  const report = {
    reportType: "BUSINESS_SYSTEM_CONNECTOR_ACCEPTANCE",
    reportVersion: "1.0",
    outcome: failedChecks > 0 ? "FAIL" : skippedChecks > 0 ? "NOT_READY" : "PASS",
    mode: allowWrite ? "WRITE_ACCEPTANCE" : "CONFIGURATION_ONLY",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    systemCode: fixture?.systemCode ?? null,
    targetClass: definition ? targetClass(definition.baseUrl) : null,
    configurationHash: hash(configuration),
    fixtureHash: hash(fixture),
    summary: { total: checks.length, passed: checks.length - failedChecks - skippedChecks, failed: failedChecks, skipped: skippedChecks },
    checks,
    security: {
      explicitWriteAuthorization: Boolean(allowWrite),
      reportContainsEndpoint: false,
      reportContainsTicketNumber: false,
      reportContainsFixtureValues: false,
      reportContainsCredential: false,
    },
  };
  const leakFree = definition ? reportLeakCheck(report, fixture, secretValues(definition, env)) : true;
  if (!leakFree) throw new AppError("CONNECTOR_ACCEPTANCE_REPORT_LEAK", "验收报告包含夹具或凭据值", 500);
  return report;
}

export function connectorAcceptanceMarkdown(report) {
  const rows = report.checks.map((item) => `| ${item.id} | ${item.outcome} | ${item.evidence.errorCode ?? item.evidence.reason ?? "通过"} |`).join("\n");
  return `# 业务系统连接器验收报告

- 结果：**${report.outcome}**
- 模式：${report.mode}
- 系统编码：${report.systemCode}
- 目标类型：${report.targetClass ?? "未识别"}
- 开始时间：${report.startedAt}
- 总耗时：${report.durationMs} ms
- 通过/失败/跳过：${report.summary.passed}/${report.summary.failed}/${report.summary.skipped}
- 配置SHA-256：${report.configurationHash}
- 夹具SHA-256：${report.fixtureHash}

| 检查项 | 结果 | 说明 |
|---|---|---|
${rows}

## 证据边界

- 报告不记录目标URL、凭据、员工标识、字段值、幂等键或下游工单编号。
- NOT_READY表示仅完成静态配置检查，未获得测试环境写入授权。
- PASS仅证明本夹具覆盖的连接器契约，不替代业务字段、权限、Webhook、容量和灾备验收。
`;
}
