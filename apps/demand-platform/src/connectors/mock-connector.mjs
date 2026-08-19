import crypto from "node:crypto";
import { BaseConnector } from "./base-connector.mjs";
import { AppError } from "../domain/errors.mjs";

export class MockConnector extends BaseConnector {
  validate(request) {
    if (request.service.targetSystem !== this.systemCode) {
      return { valid: false, errors: [{ code: "WRONG_TARGET", message: `服务目标系统不是 ${this.systemCode}` }] };
    }
    return { valid: true, errors: [] };
  }

  createTicket(request) {
    if (request.fields.__simulateFailure === true) throw new AppError("DOWNSTREAM_UNAVAILABLE", "模拟下游暂时不可用", 503);
    if (!this.createdTickets) this.createdTickets = new Map();
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({
      requestNo: request.case?.globalRequestNo,
      serviceCode: request.case?.serviceCode,
      targetSystem: request.service?.targetSystem,
      fields: request.fields,
      employeeId: request.requester?.employeeId,
    })).digest("hex");
    const existing = this.createdTickets.get(request.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new AppError("IDEMPOTENCY_CONFLICT", "相同幂等键对应了不同请求", 409);
      return { ...existing.result };
    }
    const suffix = crypto.createHash("sha256").update(`${this.systemCode}:${request.idempotencyKey}`).digest("hex").slice(0, 12).toUpperCase();
    const result = {
      systemCode: this.systemCode,
      ticketNo: `${this.systemCode}-${suffix}`,
      rawStatus: "OPEN",
      unifiedStatus: "SUBMITTED",
      ticketUrl: `https://downstream.example.invalid/${this.systemCode.toLowerCase()}/${suffix}`,
    };
    this.createdTickets.set(request.idempotencyKey, { fingerprint, result });
    return { ...result };
  }
}

export class ConnectorRegistry {
  constructor(connectors = []) {
    const codes = connectors.map((connector) => connector.systemCode);
    if (new Set(codes).size !== codes.length) throw new AppError("DUPLICATE_CONNECTOR", "连接器systemCode不得重复", 500, { systemCodes: codes });
    this.connectors = new Map(connectors.map((connector) => [connector.systemCode, connector]));
  }

  listSystemCodes() {
    return [...this.connectors.keys()].sort();
  }

  get(systemCode) {
    const connector = this.connectors.get(systemCode);
    if (!connector) throw new AppError("CONNECTOR_NOT_FOUND", `未配置 ${systemCode} 连接器`, 501, { systemCode });
    return connector;
  }
}
