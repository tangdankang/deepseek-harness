import fs from "node:fs";
import path from "node:path";
import { BaseConnector } from "./base-connector.mjs";
import { AppError } from "../domain/errors.mjs";
import { CaseStatus } from "../domain/state-machine.mjs";

const SYSTEM_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,127}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const OBJECT_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const SOURCE_ROOTS = new Set(["case", "service", "fields", "requester"]);
const UNIFIED_STATUSES = new Set(Object.values(CaseStatus));
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "upgrade", "proxy-authorization", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"]);

function invalid(message, details) {
  throw new AppError("INVALID_CONNECTOR_CONFIGURATION", message, 500, details);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function allowedKeys(value, allowed, location) {
  if (!plainObject(value)) invalid(`${location}必须为对象`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) invalid(`${location}包含未知配置项`, { location, unknown });
}

function safePath(value, location, { source = false } = {}) {
  if (typeof value !== "string" || !OBJECT_PATH.test(value)) invalid(`${location}路径格式无效`, { location });
  const segments = value.split(".");
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) invalid(`${location}包含禁止的路径片段`, { location });
  if (source && !SOURCE_ROOTS.has(segments[0])) invalid(`${location}只能读取受控请求上下文`, { location, root: segments[0] });
  return segments;
}

function readPath(source, dottedPath) {
  return safePath(dottedPath, "映射源", { source: true }).reduce((value, segment) => value?.[segment], source);
}

function writePath(target, dottedPath, value) {
  const segments = safePath(dottedPath, "映射目标");
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    if (!plainObject(current[segment])) current[segment] = {};
    current = current[segment];
  }
  current[segments.at(-1)] = value;
}

function jsonClone(value) {
  if (value === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(value)); }
  catch { invalid("映射常量必须是可序列化JSON值"); }
}

function normalizeMappingSpec(spec, location) {
  if (typeof spec === "string") {
    safePath(spec, `${location}.from`, { source: true });
    return { from: spec, required: true };
  }
  allowedKeys(spec, new Set(["from", "required", "default", "value"]), location);
  const hasFrom = Object.hasOwn(spec, "from");
  const hasValue = Object.hasOwn(spec, "value");
  if (hasFrom === hasValue) invalid(`${location}必须且只能配置from或value`);
  if (hasFrom) safePath(spec.from, `${location}.from`, { source: true });
  if (Object.hasOwn(spec, "required") && typeof spec.required !== "boolean") invalid(`${location}.required必须为布尔值`);
  if (hasValue && (Object.hasOwn(spec, "required") || Object.hasOwn(spec, "default"))) invalid(`${location}常量映射不得配置required/default`);
  return hasValue
    ? { value: jsonClone(spec.value), constant: true }
    : { from: spec.from, required: spec.required ?? true, ...(Object.hasOwn(spec, "default") ? { default: jsonClone(spec.default) } : {}) };
}

function normalizeRequestMapping(mapping, location) {
  if (!plainObject(mapping) || Object.keys(mapping).length === 0) invalid(`${location}必须包含至少一个字段映射`);
  return Object.fromEntries(Object.entries(mapping).map(([target, spec]) => {
    safePath(target, `${location}.${target}`);
    return [target, normalizeMappingSpec(spec, `${location}.${target}`)];
  }));
}

function normalizeHeaderName(name, location) {
  if (typeof name !== "string" || !HEADER_NAME.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase())) invalid(`${location}请求头名称无效或被禁止`, { header: name });
  return name;
}

function normalizeResponseMapping(input, location) {
  allowedKeys(input, new Set(["ticketNo", "rawStatus", "ticketUrl"]), location);
  for (const required of ["ticketNo", "rawStatus"]) if (!input[required]) invalid(`${location}缺少${required}`);
  const mapping = {};
  for (const [name, source] of Object.entries(input)) {
    safePath(source, `${location}.${name}`);
    mapping[name] = source;
  }
  return mapping;
}

function normalizeStaticHeaders(input, location, reserved) {
  const headers = input ?? {};
  if (!plainObject(headers)) invalid(`${location}必须为对象`);
  for (const [name, value] of Object.entries(headers)) {
    normalizeHeaderName(name, `${location}.${name}`);
    if (typeof value !== "string" || value.length > 500) invalid(`${location}.${name}必须为不超过500字符的字符串`);
    if (reserved.has(name.toLowerCase())) invalid("静态请求头不得覆盖平台保留请求头", { header: name });
  }
  return { ...headers };
}

function normalizeConfiguration(input, productionMode) {
  allowedKeys(input, new Set(["type", "systemCode", "baseUrl", "timeoutMs", "maxResponseBytes", "allowInsecureHttp", "auth", "createTicket", "getTicket", "statusMapping", "unknownStatus"]), "connector");
  if (input.type !== "http-json") invalid("connector.type必须为http-json");
  if (!SYSTEM_CODE.test(input.systemCode ?? "")) invalid("systemCode格式无效", { systemCode: input.systemCode });
  let baseUrl;
  try { baseUrl = new URL(input.baseUrl); } catch { invalid("baseUrl不是有效URL"); }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) invalid("baseUrl不得包含凭据、查询参数或片段");
  if (!['https:', 'http:'].includes(baseUrl.protocol)) invalid("baseUrl只允许HTTP(S)");
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(baseUrl.hostname);
  if (baseUrl.protocol !== "https:" && (productionMode || !input.allowInsecureHttp || !loopback)) invalid("非生产测试仅允许显式启用本机HTTP地址");

  const timeoutMs = Number(input.timeoutMs ?? 10000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) invalid("timeoutMs必须为1000至30000毫秒");
  const maxResponseBytes = Number(input.maxResponseBytes ?? 1024 * 1024);
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 5 * 1024 * 1024) invalid("maxResponseBytes必须为1024至5242880字节");

  allowedKeys(input.auth, new Set(["type", "envVar", "header"]), "auth");
  const authType = input.auth.type;
  if (!new Set(["bearer-env", "header-env", "none"]).has(authType)) invalid("auth.type不受支持");
  if (productionMode && authType === "none") invalid("生产连接器不得使用无鉴权模式");
  if (authType !== "none" && !ENV_NAME.test(input.auth.envVar ?? "")) invalid("auth.envVar格式无效");
  if (authType === "header-env") normalizeHeaderName(input.auth.header, "auth.header");
  if (authType === "bearer-env" && Object.hasOwn(input.auth, "header")) invalid("bearer-env不得自定义鉴权请求头");
  if (authType === "none" && (Object.hasOwn(input.auth, "envVar") || Object.hasOwn(input.auth, "header"))) invalid("none鉴权不得配置envVar/header");

  allowedKeys(input.createTicket, new Set(["path", "method", "idempotencyHeader", "headers", "services", "responseMapping"]), "createTicket");
  if (typeof input.createTicket.path !== "string" || !input.createTicket.path.startsWith("/") || input.createTicket.path.startsWith("//")) invalid("createTicket.path必须为同源绝对路径");
  const method = String(input.createTicket.method ?? "POST").toUpperCase();
  if (!new Set(["POST", "PUT"]).has(method)) invalid("createTicket.method只允许POST或PUT");
  const idempotencyHeader = normalizeHeaderName(input.createTicket.idempotencyHeader ?? "Idempotency-Key", "createTicket.idempotencyHeader");
  const reserved = new Set(["content-type", "accept", idempotencyHeader.toLowerCase()]);
  if (authType === "bearer-env") reserved.add("authorization");
  if (authType === "header-env") reserved.add(input.auth.header.toLowerCase());
  const staticHeaders = normalizeStaticHeaders(input.createTicket.headers, "createTicket.headers", reserved);

  if (!plainObject(input.createTicket.services) || Object.keys(input.createTicket.services).length === 0) invalid("createTicket.services不能为空");
  const services = {};
  for (const [serviceCode, serviceConfig] of Object.entries(input.createTicket.services)) {
    if (!SYSTEM_CODE.test(serviceCode)) invalid("服务编码格式无效", { serviceCode });
    allowedKeys(serviceConfig, new Set(["requestMapping"]), `createTicket.services.${serviceCode}`);
    services[serviceCode] = { requestMapping: normalizeRequestMapping(serviceConfig.requestMapping, `createTicket.services.${serviceCode}.requestMapping`) };
  }

  const responseMapping = normalizeResponseMapping(input.createTicket.responseMapping, "createTicket.responseMapping");

  let getTicket = null;
  if (input.getTicket !== undefined) {
    allowedKeys(input.getTicket, new Set(["pathTemplate", "method", "headers", "responseMapping"]), "getTicket");
    const pathTemplate = input.getTicket.pathTemplate;
    if (typeof pathTemplate !== "string" || !pathTemplate.startsWith("/") || pathTemplate.startsWith("//") || pathTemplate.split("{ticketNo}").length !== 2) invalid("getTicket.pathTemplate必须是包含一个{ticketNo}的同源绝对路径");
    const getMethod = String(input.getTicket.method ?? "GET").toUpperCase();
    if (getMethod !== "GET") invalid("getTicket.method只允许GET");
    const getReserved = new Set(["accept", "content-type"]);
    if (authType === "bearer-env") getReserved.add("authorization");
    if (authType === "header-env") getReserved.add(input.auth.header.toLowerCase());
    const getHeaders = normalizeStaticHeaders(input.getTicket.headers, "getTicket.headers", getReserved);
    const getResponseMapping = normalizeResponseMapping(input.getTicket.responseMapping, "getTicket.responseMapping");
    const getEndpoint = new URL(pathTemplate.replace("{ticketNo}", "TICKET-EXAMPLE"), baseUrl);
    if (getEndpoint.origin !== baseUrl.origin) invalid("getTicket.pathTemplate不得改变目标源");
    getTicket = { pathTemplate, method: getMethod, headers: getHeaders, responseMapping: getResponseMapping };
  }

  if (!plainObject(input.statusMapping) || Object.keys(input.statusMapping).length === 0) invalid("statusMapping不能为空");
  for (const [raw, unified] of Object.entries(input.statusMapping)) {
    if (!raw || !UNIFIED_STATUSES.has(unified)) invalid("statusMapping包含无效统一状态", { rawStatus: raw, unifiedStatus: unified });
  }
  const unknownStatus = input.unknownStatus ?? CaseStatus.IN_PROGRESS;
  if (!UNIFIED_STATUSES.has(unknownStatus)) invalid("unknownStatus不是有效统一状态");

  const endpoint = new URL(input.createTicket.path, baseUrl);
  if (endpoint.origin !== baseUrl.origin) invalid("createTicket.path不得改变目标源");
  return {
    type: "http-json",
    systemCode: input.systemCode,
    baseUrl: baseUrl.toString(),
    timeoutMs,
    maxResponseBytes,
    auth: { ...input.auth },
    createTicket: { path: input.createTicket.path, method, idempotencyHeader, headers: { ...staticHeaders }, services, responseMapping },
    getTicket,
    statusMapping: { ...input.statusMapping },
    unknownStatus,
  };
}

function mappedBody(mapping, context) {
  const body = {};
  const errors = [];
  for (const [target, spec] of Object.entries(mapping)) {
    let value;
    if (spec.constant) value = jsonClone(spec.value);
    else {
      value = readPath(context, spec.from);
      if ((value === undefined || value === null || value === "") && Object.hasOwn(spec, "default")) value = jsonClone(spec.default);
      if ((value === undefined || value === null || value === "") && spec.required) {
        errors.push({ code: "MISSING_MAPPED_FIELD", target, source: spec.from });
        continue;
      }
    }
    if (value !== undefined) writePath(body, target, value);
  }
  return { body, errors };
}

async function readLimitedText(response, maximum) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maximum) throw new AppError("DOWNSTREAM_RESPONSE_TOO_LARGE", "下游响应超过允许大小", 422, { maximum });
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new AppError("DOWNSTREAM_RESPONSE_TOO_LARGE", "下游响应超过允许大小", 422, { maximum });
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock?.(); }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function responseValue(payload, dottedPath) {
  return safePath(dottedPath, "响应映射源").reduce((value, segment) => value?.[segment], payload);
}

function validateTicketUrl(value, productionMode) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new AppError("DOWNSTREAM_CONTRACT_ERROR", "下游ticketUrl类型无效", 422);
  let parsed;
  try { parsed = new URL(value); } catch { throw new AppError("DOWNSTREAM_CONTRACT_ERROR", "下游ticketUrl不是有效URL", 422); }
  if (!['https:', 'http:'].includes(parsed.protocol) || (productionMode && parsed.protocol !== "https:")) throw new AppError("DOWNSTREAM_CONTRACT_ERROR", "下游ticketUrl协议不安全", 422);
  return parsed.toString();
}

function httpFailure(response) {
  const details = { httpStatus: response.status };
  if (response.status === 429) return new AppError("DOWNSTREAM_RATE_LIMITED", "下游系统限流", 503, details);
  if ([401, 403].includes(response.status)) return new AppError("DOWNSTREAM_AUTHORIZATION_ERROR", "下游连接器鉴权或权限失败", 422, details);
  if (response.status === 409) return new AppError("IDEMPOTENCY_CONFLICT", "下游拒绝相同幂等键的不同请求", 409, details);
  if ([400, 404, 422].includes(response.status)) return new AppError("DOWNSTREAM_BUSINESS_ERROR", "下游业务校验拒绝", 422, details);
  if (response.status >= 500) return new AppError("DOWNSTREAM_UNAVAILABLE", "下游系统暂时不可用", 503, details);
  if (response.status >= 300) return new AppError("DOWNSTREAM_REDIRECT_REJECTED", "下游返回了未授权重定向", 422, details);
  return new AppError("DOWNSTREAM_HTTP_ERROR", "下游返回非成功状态", 422, details);
}

export class HttpJsonConnector extends BaseConnector {
  constructor(configuration, { env = process.env, productionMode = false, fetchImpl = globalThis.fetch } = {}) {
    const normalized = normalizeConfiguration(configuration, productionMode);
    super(normalized.systemCode);
    if (typeof fetchImpl !== "function") invalid("运行环境缺少fetch实现");
    if (normalized.auth.type !== "none" && !String(env[normalized.auth.envVar] ?? "")) invalid("连接器凭据环境变量未设置", { envVar: normalized.auth.envVar, systemCode: normalized.systemCode });
    this.configuration = normalized;
    this.env = env;
    this.productionMode = productionMode;
    this.fetchImpl = fetchImpl;
  }

  capabilities() {
    return { validate: true, createTicket: true, getTicket: Boolean(this.configuration.getTicket), addComment: false, cancelTicket: false, statusWebhook: true };
  }

  validate(request) {
    const errors = [];
    if (request?.service?.targetSystem !== this.systemCode) errors.push({ code: "WRONG_TARGET", message: `服务目标系统不是 ${this.systemCode}` });
    const serviceCode = request?.case?.serviceCode;
    const service = this.configuration.createTicket.services[serviceCode];
    if (!service) errors.push({ code: "SERVICE_MAPPING_NOT_FOUND", message: `未配置服务映射：${serviceCode ?? "UNKNOWN"}` });
    else errors.push(...mappedBody(service.requestMapping, request).errors);
    return { valid: errors.length === 0, errors };
  }

  mapStatus(rawStatus) {
    return this.configuration.statusMapping[String(rawStatus)] ?? this.configuration.unknownStatus;
  }

  authenticatedHeaders(headers = {}) {
    const result = { accept: "application/json", ...headers };
    const auth = this.configuration.auth;
    if (auth.type === "bearer-env") result.authorization = `Bearer ${String(this.env[auth.envVar])}`;
    if (auth.type === "header-env") result[auth.header] = String(this.env[auth.envVar]);
    return result;
  }

  async requestJson(endpoint, init, { timeoutUnknownResult = false } = {}) {
    let response;
    try {
      response = await this.fetchImpl(endpoint, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(this.configuration.timeoutMs),
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      const timeout = error?.name === "AbortError" || error?.name === "TimeoutError";
      const code = timeout && timeoutUnknownResult ? "DOWNSTREAM_TIMEOUT_UNKNOWN_RESULT" : "DOWNSTREAM_UNAVAILABLE";
      const message = timeout && timeoutUnknownResult ? "下游响应超时，结果未知" : timeout ? "下游查询超时" : "下游网络调用失败";
      throw new AppError(code, message, 503, { systemCode: this.systemCode });
    }
    if (!response.ok) throw httpFailure(response);
    const text = await readLimitedText(response, this.configuration.maxResponseBytes);
    let payload;
    try { payload = JSON.parse(text); }
    catch { throw new AppError("DOWNSTREAM_CONTRACT_ERROR", "下游响应不是有效JSON", 422, { httpStatus: response.status }); }
    if (!plainObject(payload)) throw new AppError("DOWNSTREAM_CONTRACT_ERROR", "下游响应必须为JSON对象", 422);
    return payload;
  }

  ticketFromPayload(payload, mapping) {
    const ticketNo = responseValue(payload, mapping.ticketNo);
    const rawStatus = responseValue(payload, mapping.rawStatus);
    if (typeof ticketNo !== "string" || !ticketNo.trim() || typeof rawStatus !== "string" || !rawStatus.trim()) {
      throw new AppError("DOWNSTREAM_CONTRACT_ERROR", "下游响应缺少工单编号或状态", 422);
    }
    return {
      systemCode: this.systemCode,
      ticketNo: ticketNo.trim(),
      rawStatus: rawStatus.trim(),
      unifiedStatus: this.mapStatus(rawStatus.trim()),
      ticketUrl: validateTicketUrl(mapping.ticketUrl ? responseValue(payload, mapping.ticketUrl) : null, this.productionMode),
    };
  }

  async createTicket(request) {
    const validation = this.validate(request);
    if (!validation.valid) throw new AppError("DOWNSTREAM_VALIDATION_ERROR", "连接器请求映射校验失败", 422, validation.errors);
    const service = this.configuration.createTicket.services[request.case.serviceCode];
    const { body } = mappedBody(service.requestMapping, request);
    const serialized = JSON.stringify(body);
    const headers = this.authenticatedHeaders({
      "content-type": "application/json; charset=utf-8",
      [this.configuration.createTicket.idempotencyHeader]: request.idempotencyKey,
      ...this.configuration.createTicket.headers,
    });
    const endpoint = new URL(this.configuration.createTicket.path, this.configuration.baseUrl);
    const payload = await this.requestJson(endpoint, { method: this.configuration.createTicket.method, headers, body: serialized }, { timeoutUnknownResult: true });
    return this.ticketFromPayload(payload, this.configuration.createTicket.responseMapping);
  }

  async getTicket(ticketNo) {
    const definition = this.configuration.getTicket;
    if (!definition) throw new AppError("CONNECTOR_CAPABILITY_UNAVAILABLE", "连接器未配置查单能力", 501, { systemCode: this.systemCode });
    if (typeof ticketNo !== "string" || ticketNo.length < 1 || ticketNo.length > 200) throw new AppError("INVALID_TICKET_NUMBER", "下游工单编号格式无效", 400);
    const pathValue = definition.pathTemplate.replace("{ticketNo}", encodeURIComponent(ticketNo));
    const endpoint = new URL(pathValue, this.configuration.baseUrl);
    const payload = await this.requestJson(endpoint, { method: definition.method, headers: this.authenticatedHeaders(definition.headers) });
    const result = this.ticketFromPayload(payload, definition.responseMapping);
    if (result.ticketNo !== ticketNo) throw new AppError("DOWNSTREAM_CONTRACT_ERROR", "查单响应编号与请求不一致", 422);
    return result;
  }
}

export function loadConnectorConfiguration(configPath) {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) invalid("连接器配置文件不存在", { configPath: resolved });
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(resolved, "utf8")); }
  catch { invalid("连接器配置文件不是有效JSON", { configPath: resolved }); }
  return parsed;
}

function normalizeDocument(configuration, productionMode = false) {
  allowedKeys(configuration, new Set(["version", "connectors"]), "root");
  if (configuration.version !== 1) invalid("连接器配置version必须为1");
  if (!Array.isArray(configuration.connectors) || configuration.connectors.length === 0) invalid("connectors必须为非空数组");
  const definitions = configuration.connectors.map((item) => normalizeConfiguration(item, productionMode));
  const codes = definitions.map((definition) => definition.systemCode);
  if (new Set(codes).size !== codes.length) invalid("连接器systemCode不得重复", { systemCodes: codes });
  return definitions;
}

export function validateConnectorConfiguration(configuration, { productionMode = false } = {}) {
  const definitions = normalizeDocument(configuration, productionMode);
  return {
    valid: true,
    version: 1,
    connectorCount: definitions.length,
    systems: definitions.map((definition) => definition.systemCode),
    serviceMappings: definitions.reduce((total, definition) => total + Object.keys(definition.createTicket.services).length, 0),
  };
}

export function createConnectorsFromConfiguration(configuration, options = {}) {
  normalizeDocument(configuration, options.productionMode ?? false);
  const connectors = configuration.connectors.map((definition) => new HttpJsonConnector(definition, options));
  return connectors;
}
