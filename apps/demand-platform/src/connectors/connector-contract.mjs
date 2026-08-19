import { AppError } from "../domain/errors.mjs";
import { CaseStatus } from "../domain/state-machine.mjs";

const SYSTEM_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const UNIFIED_STATUSES = new Set(Object.values(CaseStatus));

function check(condition, message, details) {
  if (!condition) throw new AppError("CONNECTOR_CONTRACT_VIOLATION", message, 500, details);
}

export async function verifyConnectorContract(connector, fixture) {
  check(connector && typeof connector === "object", "连接器必须是对象");
  check(typeof connector.systemCode === "string" && SYSTEM_CODE.test(connector.systemCode), "systemCode格式无效", { systemCode: connector.systemCode });
  for (const method of ["capabilities", "validate", "createTicket", "mapStatus"]) {
    check(typeof connector[method] === "function", `连接器缺少 ${method} 方法`, { systemCode: connector.systemCode, method });
  }
  const capabilities = connector.capabilities();
  check(capabilities && typeof capabilities === "object" && !Array.isArray(capabilities), "capabilities必须返回对象");
  for (const [name, enabled] of Object.entries(capabilities)) check(typeof enabled === "boolean", `能力 ${name} 必须是布尔值`, { name, enabled });

  const before = JSON.stringify(fixture.validRequest);
  const validation = connector.validate(fixture.validRequest);
  check(validation && typeof validation.valid === "boolean" && Array.isArray(validation.errors), "validate返回结构无效");
  check(validation.valid, "有效夹具未通过连接器校验", { errors: validation.errors });
  check(JSON.stringify(fixture.validRequest) === before, "连接器不得修改输入请求");

  if (fixture.invalidRequest) {
    const invalid = connector.validate(fixture.invalidRequest);
    check(invalid && invalid.valid === false && Array.isArray(invalid.errors) && invalid.errors.length > 0, "无效夹具必须返回至少一个错误");
  }

  const first = await connector.createTicket(fixture.validRequest);
  const replay = await connector.createTicket(fixture.validRequest);
  for (const key of ["systemCode", "ticketNo", "rawStatus", "unifiedStatus"]) {
    check(typeof first?.[key] === "string" && first[key].length > 0, `createTicket缺少 ${key}`);
  }
  check(first.systemCode === connector.systemCode, "工单systemCode与连接器不一致", { expected: connector.systemCode, actual: first.systemCode });
  check(UNIFIED_STATUSES.has(first.unifiedStatus), "连接器返回未知统一状态", { unifiedStatus: first.unifiedStatus });
  check(replay.ticketNo === first.ticketNo, "相同幂等键重复调用必须返回同一工单", { first: first.ticketNo, replay: replay.ticketNo });
  let queryVerified = false;
  if (capabilities.getTicket) {
    check(typeof connector.getTicket === "function", "声明getTicket能力时必须实现对应方法");
    const queried = await connector.getTicket(first.ticketNo);
    check(queried?.systemCode === connector.systemCode && queried?.ticketNo === first.ticketNo, "getTicket返回的系统或工单编号不一致");
    check(typeof queried.rawStatus === "string" && UNIFIED_STATUSES.has(queried.unifiedStatus), "getTicket返回状态结构无效");
    queryVerified = true;
  }
  if (fixture.conflictingRequest) {
    let conflict;
    try { await connector.createTicket(fixture.conflictingRequest); } catch (error) { conflict = error; }
    check(conflict?.code === "IDEMPOTENCY_CONFLICT", "相同幂等键对应不同请求时必须拒绝", { actualCode: conflict?.code });
  }

  for (const rawStatus of fixture.rawStatuses ?? ["OPEN", "WORKING", "NEED_INFO", "RESOLVED", "CLOSED", "UNKNOWN"]) {
    const mapped = connector.mapStatus(rawStatus);
    check(UNIFIED_STATUSES.has(mapped), "状态映射返回未知统一状态", { rawStatus, mapped });
  }
  return {
    systemCode: connector.systemCode,
    capabilities,
    idempotencyVerified: true,
    idempotencyConflictVerified: Boolean(fixture.conflictingRequest),
    statusMappingVerified: true,
    queryVerified,
    sampleTicketNo: first.ticketNo,
  };
}
