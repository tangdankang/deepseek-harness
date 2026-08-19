import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { openDatabase } from "./db.mjs";
import { resolveRuntimeConfig } from "./config.mjs";
import { AppError } from "./domain/errors.mjs";
import { validateFields } from "./domain/schema-validation.mjs";
import { verifyWebhookSignature } from "./domain/confirmation-token.mjs";
import { verifyIdentityContext } from "./domain/identity-signature.mjs";
import { normalizeDepartmentMemberships } from "./domain/employee-identity.mjs";
import { OperatorPermission, OperatorRole, permissionsForRoles, verifyOperatorContext } from "./domain/operator-signature.mjs";
import { AuditService } from "./services/audit-service.mjs";
import { CatalogService } from "./services/catalog-service.mjs";
import { OrganizationDirectoryService } from "./services/organization-directory-service.mjs";
import { KnowledgeService } from "./services/knowledge-service.mjs";
import { DemandService } from "./services/demand-service.mjs";
import { HandoffService } from "./services/handoff-service.mjs";
import { AnalyticsService } from "./services/analytics-service.mjs";
import { FeedbackService } from "./services/feedback-service.mjs";
import { SessionService } from "./services/session-service.mjs";
import { IdentityLifecycleService } from "./services/identity-lifecycle-service.mjs";
import { IdentityExchangeService } from "./services/identity-exchange-service.mjs";
import { OperatorSessionService } from "./services/operator-session-service.mjs";
import { OperationsService } from "./services/operations-service.mjs";
import { ToolInvocationService } from "./services/tool-invocation-service.mjs";
import { GuidedIntakeService } from "./services/guided-intake-service.mjs";
import { FixedWindowRateLimiter } from "./security/rate-limiter.mjs";
import { resolveInboundWebhookSecrets } from "./security/inbound-webhook-auth.mjs";
import { MetricsService } from "./observability/metrics.mjs";
import { ConnectorRegistry, MockConnector } from "./connectors/mock-connector.mjs";
import { createConnectorsFromConfiguration, loadConnectorConfiguration } from "./connectors/http-json-connector.mjs";
import { DemoAgent } from "./agents/demo-agent.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, "..");
const publicDir = path.join(projectRoot, "public");
const SESSION_REVOKE_REASONS = new Set(["EMPLOYEE_DISABLED", "EMPLOYEE_LEFT", "SECURITY_EVENT", "ROLE_CHANGE", "ADMIN_REQUEST"]);
const TOOL_OPERATION_BY_PATH = new Map([
  ["/api/v1/tools/search-service-catalog", "search_service_catalog"],
  ["/api/v1/tools/get-service-form-schema", "get_service_form_schema"],
  ["/api/v1/tools/get-employee-context", "get_employee_context"],
  ["/api/v1/tools/search-knowledge", "search_knowledge"],
  ["/api/v1/tools/validate-request-draft", "validate_request_draft"],
  ["/api/v1/tools/create-or-update-draft", "create_or_update_draft"],
  ["/api/v1/tools/prepare-confirmation", "prepare_confirmation"],
  ["/api/v1/tools/submit-request", "submit_request"],
  ["/api/v1/tools/get-request-status", "get_request_status"],
  ["/api/v1/tools/handoff-to-human", "handoff_to_human"],
  ["/api/v1/tools/get-handoff-status", "get_handoff_status"],
  ["/api/v1/tools/record-feedback", "record_feedback"],
  ["/api/v1/tools/guided-request-turn", "guided_request_turn"],
]);

function loadLocalEnv() {
  const envPath = path.join(projectRoot, ".env");
  if (fs.existsSync(envPath) && typeof process.loadEnvFile === "function") process.loadEnvFile(envPath);
}

function readHeaderEmployee(req, identityHmacSecret = "", identityTtlSeconds = 300) {
  const employeeId = String(req.headers["x-employee-id"] ?? "").trim();
  if (!employeeId) throw new AppError("AUTH_REQUIRED", "缺少员工身份，请通过钉钉免登或演示请求头访问", 401);
  const departmentId = String(req.headers["x-department-id"] ?? "UNKNOWN");
  const name = decodeHeader(String(req.headers["x-employee-name"] ?? employeeId));
  const membershipHeader = req.headers["x-department-ids"];
  const identityVersion = String(req.headers["x-identity-version"] ?? "").trim().toLowerCase();
  let suppliedMemberships;
  if (membershipHeader !== undefined) {
    if (identityVersion !== "v2" || Array.isArray(membershipHeader)) throw new AppError("INVALID_IDENTITY_CONTEXT", "多部门身份必须使用v2签名且部门头只能出现一次", 401);
    suppliedMemberships = String(membershipHeader).split(",").map((value) => value.trim()).filter(Boolean);
  } else if (identityVersion) {
    throw new AppError("INVALID_IDENTITY_CONTEXT", "v2身份签名必须同时提供X-Department-Ids", 401);
  }
  const departmentIds = normalizeDepartmentMemberships(departmentId, suppliedMemberships, { code: "INVALID_IDENTITY_CONTEXT", status: 401 });
  if (identityHmacSecret) {
    verifyIdentityContext({
      employeeId,
      departmentId,
      departmentIds: suppliedMemberships === undefined ? undefined : departmentIds,
      name,
      timestamp: req.headers["x-identity-timestamp"],
      signature: req.headers["x-identity-signature"],
      secret: identityHmacSecret,
      ttlSeconds: identityTtlSeconds,
    });
  }
  return {
    employeeId,
    departmentId,
    departmentIds,
    name,
  };
}

function readHeaderOperator(req, operatorHmacSecret, ttlSeconds = 300) {
  if (!operatorHmacSecret) throw new AppError("OPERATOR_AUTH_DISABLED", "运营身份网关未配置", 401);
  const operatorId = String(req.headers["x-operator-id"] ?? "").trim();
  const name = decodeHeader(String(req.headers["x-operator-name"] ?? operatorId));
  const roles = String(req.headers["x-operator-roles"] ?? "").split(",");
  return verifyOperatorContext({
    operatorId,
    name,
    roles,
    timestamp: req.headers["x-operator-timestamp"],
    signature: req.headers["x-operator-signature"],
    secret: operatorHmacSecret,
    ttlSeconds,
  });
}

function decodeHeader(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function secureEquals(actual, expected) {
  const actualHash = crypto.createHash("sha256").update(String(actual ?? "")).digest();
  const expectedHash = crypto.createHash("sha256").update(String(expected ?? "")).digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

function immediateTransaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function json(res, status, payload, traceId, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "x-trace-id": traceId,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...extraHeaders,
  });
  res.end(body);
}

function text(res, status, body, traceId, contentType, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "x-trace-id": traceId,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  res.end(body);
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new AppError("BODY_TOO_LARGE", "请求内容过大", 413);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return { raw: "", data: {} };
  try { return { raw, data: JSON.parse(raw) }; }
  catch { throw new AppError("INVALID_JSON", "请求正文不是有效JSON", 400); }
}

function serveStatic(req, res, pathname, traceId) {
  const relative = pathname === "/" ? "index.html" : ["/admin", "/admin/"].includes(pathname) ? "admin.html" : pathname.slice(1);
  const resolved = path.resolve(publicDir, relative);
  const isInsidePublic = resolved === publicDir || resolved.startsWith(`${publicDir}${path.sep}`);
  if (!isInsidePublic || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) return false;
  const ext = path.extname(resolved).toLowerCase();
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
  const body = fs.readFileSync(resolved);
  res.writeHead(200, {
    "content-type": types[ext] ?? "application/octet-stream",
    "content-length": body.length,
    "x-trace-id": traceId,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; object-src 'none'",
  });
  res.end(body);
  return true;
}

export function createApplication(options = {}) {
  const config = resolveRuntimeConfig(options, process.env, projectRoot);
  const runtimeInstanceId = crypto.randomUUID();
  const { confirmationSecret, webhookSecret, toolApiKey, adminApiKey, metricsApiKey, identityHmacSecret, identityEventSecret, operatorHmacSecret, analyticsHashSecret, auditChainSecret, databasePath, identityTtlSeconds } = config;
  let connectorInstances;
  let connectorMode;
  if (options.connectors) {
    connectorInstances = options.connectors;
    connectorMode = "injected";
  } else if (options.connectorConfiguration || config.connectorConfigPath) {
    const configuration = options.connectorConfiguration ?? loadConnectorConfiguration(path.resolve(projectRoot, config.connectorConfigPath));
    connectorInstances = createConnectorsFromConfiguration(configuration, {
      env: options.connectorEnv ?? process.env,
      productionMode: config.productionMode,
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
    });
    connectorMode = "http-json-configured";
  } else if (config.productionMode) {
    throw new AppError("INSECURE_PRODUCTION_CONFIGURATION", "生产环境必须配置真实连接器，不允许隐式使用模拟连接器", 500);
  } else {
    connectorInstances = ["CRM", "OA", "ERP", "TB"].map((code) => new MockConnector(code));
    connectorMode = "mock";
  }
  const connectors = new ConnectorRegistry(connectorInstances);
  const inboundWebhookSecrets = resolveInboundWebhookSecrets({
    systemCodes: connectors.listSystemCodes(),
    productionMode: config.productionMode,
    fallbackSecret: webhookSecret,
    secretEnvBySystem: config.inboundWebhookSecretEnvs,
    env: options.webhookEnv ?? process.env,
    injectedSecrets: options.webhookSecrets,
    reservedSecrets: [confirmationSecret, webhookSecret, toolApiKey, adminApiKey, metricsApiKey, identityHmacSecret, identityEventSecret, operatorHmacSecret, analyticsHashSecret, auditChainSecret, config.identityExchangeSecret],
  });
  const db = openDatabase(databasePath, { seedDemo: !config.productionMode });
  const audit = new AuditService({ db, secret: auditChainSecret, keyVersion: config.auditChainKeyVersion, allowLegacyBackfill: config.auditChainAllowLegacyBackfill });
  const sessions = new SessionService({ db, ttlSeconds: config.sessionTtlSeconds, maxSessionsPerEmployee: config.sessionMaxPerEmployee, cookieSecure: config.sessionCookieSecure });
  const identityLifecycle = new IdentityLifecycleService({
    db,
    sessions,
    audit,
    expectedSource: config.identityEventSource,
    maxAgeSeconds: config.identityEventMaxAgeSeconds,
  });
  const identityExchange = new IdentityExchangeService({
    db,
    secret: config.identityExchangeSecret,
    issuer: config.identityExchangeIssuer,
    audience: config.identityExchangeAudience,
    ttlSeconds: config.identityExchangeTtlSeconds,
    enabled: ["ticket", "both"].includes(config.identityExchangeMode),
  });
  const operatorSessions = new OperatorSessionService({
    db,
    ttlSeconds: config.operatorSessionTtlSeconds,
    maxSessionsPerOperator: config.operatorSessionMaxPerOperator,
    cookieSecure: config.sessionCookieSecure,
  });
  const organizationDirectory = new OrganizationDirectoryService(db);
  const catalog = new CatalogService(db, { organizationDirectory });
  const knowledge = new KnowledgeService(db);
  const demands = new DemandService({
    db,
    catalog,
    connectors,
    audit,
    confirmationSecret,
    confirmationTtlSeconds: config.confirmationTtlSeconds,
    integrationMaxAttempts: config.integrationMaxAttempts,
    integrationRetryBaseSeconds: config.integrationRetryBaseSeconds,
    businessWebhookMaxAgeSeconds: config.businessWebhookMaxAgeSeconds,
  });
  const handoffs = new HandoffService({ db, audit });
  const analytics = new AnalyticsService({ db, hashSecret: analyticsHashSecret });
  const feedback = new FeedbackService({ db, audit, hashSecret: analyticsHashSecret });
  const agent = new DemoAgent({ knowledge, catalog, demands, handoffs });
  const guidedIntake = new GuidedIntakeService({ catalog, demands });
  const operations = new OperationsService({ db, connectors });
  const toolInvocations = new ToolInvocationService({ db, hashSecret: analyticsHashSecret, retentionDays: config.toolInvocationRetentionDays });
  const rateLimiter = new FixedWindowRateLimiter({
    secret: analyticsHashSecret,
    windowSeconds: config.rateLimitWindowSeconds,
    maxEntries: config.rateLimitMaxEntries,
    now: options.rateLimitNow ?? (() => Date.now()),
  });
  const rateLimits = {
    employee: config.employeeRateLimit,
    tool: config.toolRateLimit,
    auth: config.authRateLimit,
    admin: config.adminRateLimit,
    webhook: config.webhookRateLimit,
  };
  const applicationVersion = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")).version;
  const metrics = new MetricsService({
    db,
    rateLimiter,
    applicationVersion,
    connectorSystems: connectors.listSystemCodes(),
    auditStartupValid: audit.startupReport?.outcome === "PASS",
    now: options.metricsNow ?? (() => Date.now()),
  });
  const enforceRateLimit = ({ scope, subject, actorType = "SYSTEM", actorId = "RATE_LIMIT", traceId = null }) => {
    if (!config.rateLimitEnabled) return null;
    const result = rateLimiter.consume({ scope, subject, limit: rateLimits[scope] });
    if (result.allowed) return result;
    if (result.firstRejected) {
      try {
        audit.record({ actorType, actorId, action: "RATE_LIMITED", outcome: "FAILURE", details: { scope, limit: result.limit, retryAfterSeconds: result.retryAfterSeconds, overloaded: result.overloaded }, traceId });
      } catch { /* 限流主结果优先；审计写入失败由集中日志捕获。 */ }
    }
    const error = new AppError(
      result.overloaded ? "RATE_LIMIT_CAPACITY_EXCEEDED" : "RATE_LIMIT_EXCEEDED",
      result.overloaded ? "限流状态容量已满，请稍后重试" : "请求过于频繁，请稍后重试",
      result.overloaded ? 503 : 429,
      { scope, limit: result.limit, retryAfterSeconds: result.retryAfterSeconds },
    );
    error.responseHeaders = {
      "retry-after": String(result.retryAfterSeconds),
      "x-ratelimit-limit": String(result.limit),
      "x-ratelimit-remaining": "0",
    };
    throw error;
  };
  const isDemoSecret = confirmationSecret.startsWith("dev-only") || webhookSecret.startsWith("dev-only");
  const employeeFrom = (req, { allowSession = true, rateScope = "employee" } = {}) => {
    const session = allowSession ? sessions.authenticate(req, { requireCsrf: !["GET", "HEAD", "OPTIONS"].includes(req.method) }) : null;
    const employee = session?.employee ?? readHeaderEmployee(req, identityHmacSecret, identityTtlSeconds);
    identityLifecycle.assertEmployeeAllowed(employee.employeeId);
    if (rateScope) enforceRateLimit({ scope: rateScope, subject: employee.employeeId, actorType: "EMPLOYEE", actorId: employee.employeeId, traceId: req.platformTraceId });
    return employee;
  };
  const requireAdmin = (req, permission) => {
    const operator = operatorSessions.authorize(req, permission, { requireCsrf: !["GET", "HEAD", "OPTIONS"].includes(req.method) });
    let authorized;
    if (operator) authorized = { ...operator, authMode: "operator-session" };
    else {
      if (!adminApiKey || !secureEquals(req.headers["x-admin-key"], adminApiKey)) {
        enforceRateLimit({ scope: "auth", subject: `admin-credential:${req.socket.remoteAddress ?? "UNKNOWN"}`, traceId: req.platformTraceId });
        throw new AppError("INVALID_ADMIN_CREDENTIAL", "管理接口凭据无效", 401);
      }
      const roles = [OperatorRole.PLATFORM_ADMIN];
      authorized = {
        operatorId: String(req.headers["x-admin-id"] ?? "ADMIN_API").slice(0, 100),
        name: String(req.headers["x-admin-id"] ?? "Admin API").slice(0, 200),
        roles,
        permissions: permissionsForRoles(roles),
        authMode: "admin-api-key",
      };
    }
    enforceRateLimit({ scope: "admin", subject: authorized.operatorId, actorType: "OPERATOR", actorId: authorized.operatorId, traceId: req.platformTraceId });
    return authorized;
  };
  const executeTool = async (operationId, employee, data, traceId) => {
    if (operationId === "search_service_catalog") return { status: 200, payload: { services: catalog.search(data.query ?? "", employee) } };
    if (operationId === "get_service_form_schema") return { status: 200, payload: { service: catalog.get(data.serviceCode, employee), schema: catalog.getSchema(data.serviceCode, undefined, employee) } };
    if (operationId === "get_employee_context") return { status: 200, payload: { employee: { employeeId: employee.employeeId, departmentId: employee.departmentId, departmentIds: employee.departmentIds ?? [employee.departmentId] } } };
    if (operationId === "search_knowledge") return { status: 200, payload: { result: knowledge.search(data.query ?? "", employee) } };
    if (operationId === "validate_request_draft") {
      const schema = catalog.getSchema(data.serviceCode, undefined, employee);
      return { status: 200, payload: validateFields(schema, data.fields ?? {}) };
    }
    if (operationId === "create_or_update_draft") {
      if (data.globalRequestNo) {
        return { status: 200, payload: demands.updateDraft(employee, data.globalRequestNo, { fields: data.fields ?? {}, expectedVersion: data.expectedVersion }) };
      }
      return { status: 201, payload: demands.createDraft(employee, { serviceCode: data.serviceCode, fields: data.fields ?? {}, conversationId: data.conversationId ?? null }) };
    }
    if (operationId === "prepare_confirmation") return { status: 200, payload: demands.prepareConfirmation(employee, data.globalRequestNo) };
    if (operationId === "submit_request") return { status: 200, payload: await demands.submit(employee, data.globalRequestNo, data) };
    if (operationId === "get_request_status") return { status: 200, payload: { case: demands.getOwned(employee, data.globalRequestNo) } };
    if (operationId === "handoff_to_human") return { status: 201, payload: handoffs.create(employee, data, { traceId }) };
    if (operationId === "get_handoff_status") return { status: 200, payload: { handoff: handoffs.getOwned(employee, data.handoffNo) } };
    if (operationId === "record_feedback") return { status: 201, payload: feedback.record(employee, data, { traceId }) };
    if (operationId === "guided_request_turn") return { status: 200, payload: await guidedIntake.turn(employee, data) };
    throw new AppError("INVALID_TOOL_OPERATION", "未知工具操作", 404);
  };

  const server = http.createServer(async (req, res) => {
    const traceId = crypto.randomUUID();
    req.platformTraceId = traceId;
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;
    const metricObservation = metrics.beginRequest(req.method, pathname);
    res.once("finish", () => metrics.completeRequest(metricObservation, res.statusCode));
    try {
      if (req.method === "GET" && pathname === "/health/live") {
        return json(res, 200, { status: "ok", process: "alive", time: new Date().toISOString() }, traceId);
      }
      if (req.method === "GET" && (pathname === "/health" || pathname === "/health/ready")) {
        let databaseProbe;
        let pendingTasks;
        let deadTasks;
        try {
          databaseProbe = db.prepare("SELECT 1 AS ok").get();
          pendingTasks = Number(db.prepare("SELECT COUNT(*) AS count FROM integration_tasks WHERE status IN ('PENDING', 'RUNNING', 'RETRY_WAIT')").get().count);
          deadTasks = Number(db.prepare("SELECT COUNT(*) AS count FROM integration_tasks WHERE status = 'DEAD'").get().count);
        } catch {
          throw new AppError("READINESS_FAILED", "数据库尚未就绪", 503);
        }
        const organization = organizationDirectory.status();
        if (organization.readiness === "not_ready") throw new AppError("READINESS_FAILED", "组织目录未就绪，部门子树授权已默认拒绝", 503, { organization });
        return json(res, 200, {
          status: "ok",
          readiness: "ready",
          instanceId: runtimeInstanceId,
          runtimeProfile: config.runtimeProfile,
          deploymentModel: "SINGLE_NODE_PILOT",
          storageBackend: "SQLITE",
          runtimeCapabilities: {
            sharedSessionState: false,
            distributedRateLimit: false,
            sharedIntegrationCoordination: false,
          },
          database: databaseProbe.ok === 1 ? "ok" : "error",
          integrationTasks: { pending: pendingTasks, dead: deadTasks },
          securityMode: isDemoSecret ? "demo-secrets" : "configured",
          toolAuth: toolApiKey ? "configured" : "disabled-for-demo",
          adminAuth: adminApiKey ? "configured" : "disabled-for-demo",
          identityAuth: identityHmacSecret ? `session+signed-gateway-context+${config.identityExchangeMode}` : "session+unsigned-demo-headers",
          identityLifecycle: identityEventSecret ? `signed-events:${config.identityEventSource}` : "disabled-for-demo",
          connectorMode,
          connectorSystems: connectors.listSystemCodes(),
          organizationDirectory: organization,
          rateLimiting: { enabled: config.rateLimitEnabled, ...rateLimiter.status() },
          time: new Date().toISOString(),
        }, traceId);
      }
      if (req.method === "GET" && pathname === "/internal/metrics") {
        if (!metricsApiKey) throw new AppError("METRICS_DISABLED", "监控指标端点未启用", 404);
        const authorization = String(req.headers.authorization ?? "");
        const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        if (!supplied || !secureEquals(supplied, metricsApiKey)) {
          enforceRateLimit({ scope: "auth", subject: `metrics:${req.socket.remoteAddress ?? "UNKNOWN"}`, traceId });
          throw new AppError("INVALID_METRICS_CREDENTIAL", "监控指标凭据无效", 401);
        }
        return text(res, 200, metrics.render(), traceId, "application/openmetrics-text; version=1.0.0; charset=utf-8");
      }

      if (req.method === "POST" && pathname === "/api/v1/auth/session") {
        enforceRateLimit({ scope: "auth", subject: `employee:${req.socket.remoteAddress ?? "UNKNOWN"}`, traceId });
        const { data } = await readBody(req);
        const unknownFields = Object.keys(data ?? {}).filter((key) => key !== "exchangeTicket");
        if (unknownFields.length > 0) throw new AppError("INVALID_AUTH_REQUEST", "身份交换请求包含未知字段", 400);
        const exchangedSession = immediateTransaction(db, () => {
          let employee;
          let identitySource;
          let ticketIdHash;
          if (data?.exchangeTicket !== undefined) {
            const exchanged = identityExchange.consume(data.exchangeTicket);
            employee = exchanged.employee;
            ticketIdHash = exchanged.ticketIdHash;
            identitySource = "gateway-one-time-ticket";
          } else {
            if (config.identityExchangeMode === "ticket") throw new AppError("IDENTITY_TICKET_REQUIRED", "需要一次性身份交换票据", 401);
            employee = readHeaderEmployee(req, identityHmacSecret, identityTtlSeconds);
            identitySource = "gateway-signed-headers";
          }
          identityLifecycle.assertEmployeeAllowed(employee.employeeId);
          const created = sessions.create(employee);
          audit.record({ actorType: "EMPLOYEE", actorId: employee.employeeId, action: "CREATE_AUTH_SESSION", details: { departmentId: employee.departmentId, departmentMembershipCount: created.employee.departmentIds.length, expiresAt: created.expiresAt, identitySource, ticketIdHash: ticketIdHash ?? null }, traceId });
          return { created, identitySource };
        });
        return json(res, 201, { employee: exchangedSession.created.employee, csrfToken: exchangedSession.created.csrfToken, expiresAt: exchangedSession.created.expiresAt, authMode: "server-session", identitySource: exchangedSession.identitySource }, traceId, { "set-cookie": exchangedSession.created.setCookie });
      }
      if (req.method === "GET" && pathname === "/api/v1/auth/me") {
        const session = sessions.authenticate(req);
        if (!session) throw new AppError("SESSION_REQUIRED", "需要有效登录会话", 401);
        return json(res, 200, { employee: session.employee, csrfToken: session.csrfToken, expiresAt: session.expiresAt, authMode: "server-session" }, traceId);
      }
      if (req.method === "POST" && pathname === "/api/v1/auth/logout") {
        await readBody(req);
        const session = sessions.authenticate(req, { requireCsrf: true });
        if (!session) throw new AppError("SESSION_REQUIRED", "需要有效登录会话", 401);
        sessions.revoke(session);
        audit.record({ actorType: "EMPLOYEE", actorId: session.employee.employeeId, action: "REVOKE_AUTH_SESSION", details: {}, traceId });
        return json(res, 200, { loggedOut: true }, traceId, { "set-cookie": sessions.clearCookie() });
      }

      if (req.method === "POST" && pathname === "/api/v1/operator/auth/session") {
        enforceRateLimit({ scope: "auth", subject: `operator:${req.socket.remoteAddress ?? "UNKNOWN"}`, traceId });
        const { data } = await readBody(req);
        let operator;
        let identitySource;
        if (data?.adminKey !== undefined) {
          if (!config.operatorBootstrapEnabled) throw new AppError("OPERATOR_BOOTSTRAP_DISABLED", "生产环境请从公司管理入口登录", 403);
          const unknownFields = Object.keys(data).filter((key) => !["adminKey", "operatorId", "operatorName"].includes(key));
          if (unknownFields.length > 0) throw new AppError("INVALID_OPERATOR_AUTH_REQUEST", "运营登录请求包含未知字段", 400);
          if (!adminApiKey || !secureEquals(data.adminKey, adminApiKey)) throw new AppError("INVALID_ADMIN_CREDENTIAL", "管理接口凭据无效", 401);
          const operatorId = String(data.operatorId ?? "LOCAL-OPERATOR").trim();
          const name = String(data.operatorName ?? operatorId).trim();
          const roles = [OperatorRole.PLATFORM_ADMIN];
          operator = { operatorId, name, roles, permissions: permissionsForRoles(roles) };
          identitySource = "development-admin-key-bootstrap";
        } else {
          if (Object.keys(data ?? {}).length > 0) throw new AppError("INVALID_OPERATOR_AUTH_REQUEST", "运营登录请求包含未知字段", 400);
          operator = readHeaderOperator(req, operatorHmacSecret, config.operatorIdentityTtlSeconds);
          identitySource = "operator-gateway-signed-context";
        }
        const created = immediateTransaction(db, () => {
          const session = operatorSessions.create(operator);
          audit.record({ actorType: "OPERATOR", actorId: operator.operatorId, action: "CREATE_OPERATOR_SESSION", details: { roles: operator.roles, expiresAt: session.expiresAt, identitySource }, traceId });
          return session;
        });
        return json(res, 201, { operator: created.operator, csrfToken: created.csrfToken, expiresAt: created.expiresAt, authMode: "operator-session", identitySource }, traceId, { "set-cookie": created.setCookie });
      }
      if (req.method === "GET" && pathname === "/api/v1/operator/auth/me") {
        const operator = operatorSessions.authenticate(req);
        if (!operator) throw new AppError("OPERATOR_SESSION_REQUIRED", "需要有效运营会话", 401);
        return json(res, 200, { operator: { operatorId: operator.operatorId, name: operator.name, roles: operator.roles, permissions: operator.permissions }, csrfToken: operator.csrfToken, expiresAt: operator.expiresAt, authMode: "operator-session" }, traceId);
      }
      if (req.method === "POST" && pathname === "/api/v1/operator/auth/logout") {
        await readBody(req);
        const operator = operatorSessions.authenticate(req, { requireCsrf: true });
        if (!operator) throw new AppError("OPERATOR_SESSION_REQUIRED", "需要有效运营会话", 401);
        operatorSessions.revoke(operator);
        audit.record({ actorType: "OPERATOR", actorId: operator.operatorId, action: "REVOKE_OPERATOR_SESSION", details: {}, traceId });
        return json(res, 200, { loggedOut: true }, traceId, { "set-cookie": operatorSessions.clearCookie() });
      }

      if (req.method === "GET" && (pathname === "/" || pathname === "/admin" || pathname === "/admin/" || pathname.startsWith("/app.js") || pathname.startsWith("/styles.css") || pathname.startsWith("/admin.js") || pathname.startsWith("/admin.css"))) {
        if (serveStatic(req, res, pathname, traceId)) return;
      }

      if (req.method === "POST" && /^\/api\/v1\/webhooks\/[^/]+\/status$/.test(pathname)) {
        const systemCode = decodeURIComponent(pathname.split("/")[4]).toUpperCase();
        const { raw, data } = await readBody(req);
        const signature = String(req.headers["x-webhook-signature"] ?? "");
        const systemWebhookSecret = inboundWebhookSecrets.get(systemCode);
        if (!systemWebhookSecret) throw new AppError("WEBHOOK_SYSTEM_NOT_CONFIGURED", "Webhook系统未配置", 404);
        if (!verifyWebhookSignature(raw, signature, systemWebhookSecret)) throw new AppError("INVALID_WEBHOOK_SIGNATURE", "Webhook签名无效", 401);
        enforceRateLimit({ scope: "webhook", subject: systemCode, actorType: "SYSTEM", actorId: `WEBHOOK_${systemCode}`, traceId });
        const payloadHash = crypto.createHash("sha256").update(raw).digest("hex");
        return json(res, 200, demands.applyStatusEvent(systemCode, data, payloadHash), traceId);
      }

      if (req.method === "POST" && pathname === "/api/v1/webhooks/identity/events") {
        if (!identityEventSecret) throw new AppError("IDENTITY_EVENTS_DISABLED", "身份生命周期事件入口未启用", 404);
        const { raw, data } = await readBody(req);
        const signature = String(req.headers["x-identity-event-signature"] ?? "");
        if (!verifyWebhookSignature(raw, signature, identityEventSecret)) throw new AppError("INVALID_IDENTITY_EVENT_SIGNATURE", "身份事件签名无效", 401);
        enforceRateLimit({ scope: "webhook", subject: config.identityEventSource, actorType: "SYSTEM", actorId: config.identityEventSource, traceId });
        const payloadHash = crypto.createHash("sha256").update(raw).digest("hex");
        return json(res, 200, identityLifecycle.applyEvent(data, payloadHash, { traceId }), traceId);
      }

      if (req.method === "GET" && pathname === "/api/v1/services") {
        const employee = employeeFrom(req);
        return json(res, 200, { services: catalog.search(url.searchParams.get("query") ?? "", employee) }, traceId);
      }
      const schemaMatch = pathname.match(/^\/api\/v1\/services\/([^/]+)\/schema$/);
      if (req.method === "GET" && schemaMatch) {
        const employee = employeeFrom(req);
        const serviceCode = decodeURIComponent(schemaMatch[1]);
        return json(res, 200, { service: catalog.get(serviceCode, employee), schema: catalog.getSchema(serviceCode, undefined, employee) }, traceId);
      }
      if (req.method === "POST" && pathname === "/api/v1/assistant/messages") {
        const employee = employeeFrom(req);
        const { data } = await readBody(req);
        const response = agent.respond(employee, data);
        analytics.recordInteraction(employee, data, response, traceId);
        return json(res, 200, response, traceId);
      }
      if (req.method === "POST" && pathname === "/api/v1/guided-intake/turn") {
        const employee = employeeFrom(req);
        const { data } = await readBody(req);
        return json(res, 200, await guidedIntake.turn(employee, data), traceId);
      }
      if (req.method === "POST" && pathname === "/api/v1/cases/drafts") {
        const employee = employeeFrom(req);
        const { data } = await readBody(req);
        return json(res, 201, demands.createDraft(employee, data), traceId);
      }
      if (req.method === "GET" && pathname === "/api/v1/cases") {
        const employee = employeeFrom(req);
        return json(res, 200, { cases: demands.listOwned(employee) }, traceId);
      }
      if (req.method === "POST" && pathname === "/api/v1/handoffs") {
        const employee = employeeFrom(req);
        const { data } = await readBody(req);
        return json(res, 201, handoffs.create(employee, data, { traceId }), traceId);
      }
      if (req.method === "GET" && pathname === "/api/v1/handoffs") {
        const employee = employeeFrom(req);
        return json(res, 200, { handoffs: handoffs.listOwned(employee) }, traceId);
      }
      if (req.method === "POST" && pathname === "/api/v1/feedback") {
        const employee = employeeFrom(req);
        const { data } = await readBody(req);
        return json(res, 201, feedback.record(employee, data, { traceId }), traceId);
      }
      const handoffMatch = pathname.match(/^\/api\/v1\/handoffs\/(HOF-\d{8}-\d{6})$/);
      if (req.method === "GET" && handoffMatch) {
        const employee = employeeFrom(req);
        return json(res, 200, { handoff: handoffs.getOwned(employee, handoffMatch[1]) }, traceId);
      }
      const caseMatch = pathname.match(/^\/api\/v1\/cases\/(REQ-\d{8}-\d{6})$/);
      if (req.method === "GET" && caseMatch) {
        const employee = employeeFrom(req);
        return json(res, 200, { case: demands.getOwned(employee, caseMatch[1]) }, traceId);
      }
      const draftMatch = pathname.match(/^\/api\/v1\/cases\/(REQ-\d{8}-\d{6})\/draft$/);
      if (req.method === "PATCH" && draftMatch) {
        const employee = employeeFrom(req);
        const { data } = await readBody(req);
        return json(res, 200, demands.updateDraft(employee, draftMatch[1], data), traceId);
      }
      const confirmMatch = pathname.match(/^\/api\/v1\/cases\/(REQ-\d{8}-\d{6})\/prepare-confirmation$/);
      if (req.method === "POST" && confirmMatch) {
        const employee = employeeFrom(req);
        await readBody(req);
        return json(res, 200, demands.prepareConfirmation(employee, confirmMatch[1]), traceId);
      }
      const submitMatch = pathname.match(/^\/api\/v1\/cases\/(REQ-\d{8}-\d{6})\/submit$/);
      if (req.method === "POST" && submitMatch) {
        const employee = employeeFrom(req);
        const { data } = await readBody(req);
        return json(res, 200, await demands.submit(employee, submitMatch[1], data), traceId);
      }

      if (req.method === "POST" && pathname.startsWith("/api/v1/tools/")) {
        const operationId = TOOL_OPERATION_BY_PATH.get(pathname);
        if (!operationId) throw new AppError("INVALID_TOOL_OPERATION", "未知工具操作", 404);
        if (toolApiKey && !secureEquals(req.headers["x-tool-key"], toolApiKey)) {
          enforceRateLimit({ scope: "auth", subject: `tool-credential:${req.socket.remoteAddress ?? "UNKNOWN"}`, traceId });
          throw new AppError("INVALID_TOOL_CREDENTIAL", "DEAP工具调用凭据无效", 401);
        }
        const employee = employeeFrom(req, { allowSession: false, rateScope: null });
        const invocation = toolInvocations.start({ requestedId: req.headers["x-tool-invocation-id"], operationId, employee, traceId });
        try {
          enforceRateLimit({ scope: "tool", subject: employee.employeeId, actorType: "EMPLOYEE", actorId: employee.employeeId, traceId });
          const { data } = await readBody(req);
          const result = await executeTool(operationId, employee, data, traceId);
          try { toolInvocations.finish(invocation, { outcome: "SUCCESS", httpStatus: result.status }); }
          catch (trackingError) { console.error(`[${traceId}] tool invocation completion tracking failed`, trackingError); }
          return json(res, result.status, result.payload, traceId, { "x-tool-invocation-id": invocation.invocationId });
        } catch (error) {
          const appError = error instanceof AppError ? error : new AppError("INTERNAL_ERROR", "服务器处理失败", 500);
          try { toolInvocations.finish(invocation, { outcome: "FAILURE", httpStatus: appError.status, errorCode: appError.code }); }
          catch (trackingError) { console.error(`[${traceId}] tool invocation failure tracking failed`, trackingError); }
          error.toolInvocationId = invocation.invocationId;
          throw error;
        }
      }

      if (req.method === "GET" && pathname === "/api/v1/admin/metrics") {
        const operator = requireAdmin(req, OperatorPermission.VIEW_OVERVIEW);
        const days = url.searchParams.get("days") ?? 7;
        audit.record({ actorType: "OPERATOR", actorId: operator.operatorId, action: "VIEW_PILOT_METRICS", details: { days }, traceId });
        return json(res, 200, analytics.metrics({ days }), traceId);
      }
      if (req.method === "GET" && pathname === "/api/v1/admin/overview") {
        const operator = requireAdmin(req, OperatorPermission.VIEW_OVERVIEW);
        audit.record({ actorType: "OPERATOR", actorId: operator.operatorId, action: "VIEW_OPERATIONS_OVERVIEW", details: {}, traceId });
        return json(res, 200, operations.overview(), traceId);
      }
      if (req.method === "POST" && pathname === "/api/v1/admin/auth-sessions/revoke") {
        const operator = requireAdmin(req, OperatorPermission.MANAGE_SESSIONS);
        const { data } = await readBody(req);
        const reason = String(data.reason ?? "");
        if (!SESSION_REVOKE_REASONS.has(reason)) throw new AppError("INVALID_REVOCATION_REASON", "会话撤销原因无效", 400, { allowed: [...SESSION_REVOKE_REASONS] });
        const result = immediateTransaction(db, () => {
          const revoked = sessions.revokeEmployee(data.employeeId);
          audit.record({ actorType: "OPERATOR", actorId: operator.operatorId, action: "REVOKE_EMPLOYEE_AUTH_SESSIONS", details: { employeeId: revoked.employeeId, revokedSessions: revoked.revokedSessions, reason }, traceId });
          return revoked;
        });
        return json(res, 200, { ...result, reason }, traceId);
      }
      if (req.method === "GET" && pathname === "/api/v1/admin/handoffs") {
        const operator = requireAdmin(req, OperatorPermission.VIEW_HANDOFFS);
        const status = url.searchParams.get("status") ?? undefined;
        const limit = url.searchParams.get("limit") ?? 100;
        audit.record({ actorType: "OPERATOR", actorId: operator.operatorId, action: "VIEW_HANDOFF_QUEUE", details: { status }, traceId });
        return json(res, 200, { handoffs: handoffs.listAdmin({ status, limit }) }, traceId);
      }
      const adminHandoffMatch = pathname.match(/^\/api\/v1\/admin\/handoffs\/(HOF-\d{8}-\d{6})$/);
      if (req.method === "PATCH" && adminHandoffMatch) {
        const operator = requireAdmin(req, OperatorPermission.MANAGE_HANDOFFS);
        const { data } = await readBody(req);
        return json(res, 200, handoffs.updateAdmin(adminHandoffMatch[1], data, operator.operatorId, { traceId }), traceId);
      }
      if (req.method === "GET" && pathname === "/api/v1/admin/integration-tasks") {
        const operator = requireAdmin(req, OperatorPermission.VIEW_INTEGRATIONS);
        const status = url.searchParams.get("status") ?? undefined;
        audit.record({ actorType: "OPERATOR", actorId: operator.operatorId, action: "VIEW_INTEGRATION_TASKS", details: { status }, traceId });
        return json(res, 200, { tasks: demands.listIntegrationTasks({ status }) }, traceId);
      }
      if (req.method === "POST" && pathname === "/api/v1/admin/integration-tasks/run") {
        const operator = requireAdmin(req, OperatorPermission.MANAGE_INTEGRATIONS);
        const { data } = await readBody(req);
        const result = await demands.processDueSubmissionTasks({ limit: data.limit ?? 20 });
        audit.record({ actorType: "OPERATOR", actorId: operator.operatorId, action: "RUN_INTEGRATION_WORKER", details: { selected: result.selected, succeeded: result.succeeded, failed: result.failed }, traceId });
        return json(res, 200, result, traceId);
      }
      if (req.method === "POST" && pathname === "/api/v1/admin/external-tickets/reconcile") {
        const operator = requireAdmin(req, OperatorPermission.MANAGE_INTEGRATIONS);
        const { data } = await readBody(req);
        const result = await demands.reconcileExternalTickets({ limit: data.limit ?? 20, systemCode: data.systemCode });
        audit.record({ actorType: "OPERATOR", actorId: operator.operatorId, action: "RUN_EXTERNAL_TICKET_RECONCILIATION", details: { selected: result.selected, updated: result.updated, failed: result.failed, systemCode: data.systemCode ?? null }, traceId });
        return json(res, 200, result, traceId);
      }
      const retryTaskMatch = pathname.match(/^\/api\/v1\/admin\/integration-tasks\/([0-9a-f-]{36})\/retry$/i);
      if (req.method === "POST" && retryTaskMatch) {
        const operator = requireAdmin(req, OperatorPermission.MANAGE_INTEGRATIONS);
        await readBody(req);
        return json(res, 200, await demands.retryIntegrationTask(retryTaskMatch[1], operator.operatorId), traceId);
      }

      if (req.method === "GET" && pathname === "/api/v1/admin/cases") {
        const operator = requireAdmin(req, OperatorPermission.VIEW_CASES);
        const status = url.searchParams.get("status") ?? undefined;
        const serviceCode = url.searchParams.get("serviceCode") ?? undefined;
        const limit = url.searchParams.get("limit") ?? 100;
        audit.record({ actorType: "OPERATOR", actorId: operator.operatorId, action: "VIEW_DEMAND_QUEUE", details: { status, serviceCode }, traceId });
        return json(res, 200, { cases: demands.listAdminCases({ status, serviceCode, limit }) }, traceId);
      }
      if (req.method === "GET" && pathname === "/api/v1/admin/audit-events") {
        const operator = requireAdmin(req, OperatorPermission.VIEW_AUDIT);
        const query = { action: url.searchParams.get("action") ?? undefined, outcome: url.searchParams.get("outcome") ?? undefined, actorType: url.searchParams.get("actorType") ?? undefined, limit: url.searchParams.get("limit") ?? 100 };
        return json(res, 200, { events: audit.listAdmin(query) }, traceId);
      }
      if (req.method === "GET" && pathname === "/api/v1/admin/audit-integrity") {
        const operator = requireAdmin(req, OperatorPermission.VIEW_AUDIT);
        audit.assertIntegrity();
        audit.record({ actorType: "OPERATOR", actorId: operator.operatorId, action: "VERIFY_AUDIT_CHAIN", details: {}, traceId });
        return json(res, 200, audit.assertIntegrity(), traceId);
      }
      if (req.method === "GET" && pathname === "/api/v1/admin/tool-invocations") {
        requireAdmin(req, OperatorPermission.VIEW_AUDIT);
        return json(res, 200, { invocations: toolInvocations.listAdmin({ operationId: url.searchParams.get("operationId") ?? undefined, outcome: url.searchParams.get("outcome") ?? undefined, limit: url.searchParams.get("limit") ?? 100 }) }, traceId);
      }
      if (req.method === "GET" && pathname === "/api/v1/admin/auth-sessions") {
        requireAdmin(req, OperatorPermission.MANAGE_SESSIONS);
        return json(res, 200, { sessions: sessions.listActive({ employeeId: url.searchParams.get("employeeId") ?? undefined, limit: url.searchParams.get("limit") ?? 100 }) }, traceId);
      }
      if (req.method === "GET" && pathname === "/api/v1/admin/identity-states") {
        const operator = requireAdmin(req, OperatorPermission.MANAGE_SESSIONS);
        const query = { employeeId: url.searchParams.get("employeeId") ?? undefined, accessStatus: url.searchParams.get("accessStatus") ?? undefined, limit: url.searchParams.get("limit") ?? 100 };
        audit.record({ actorType: "OPERATOR", actorId: operator.operatorId, action: "VIEW_IDENTITY_ACCESS_STATES", details: { filteredByEmployee: Boolean(query.employeeId), accessStatus: query.accessStatus ?? null }, traceId });
        return json(res, 200, { states: identityLifecycle.listStates(query) }, traceId);
      }

      if (serveStatic(req, res, pathname, traceId)) return;
      throw new AppError("NOT_FOUND", "接口或页面不存在", 404);
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError("INTERNAL_ERROR", "服务器处理失败", 500);
      if (req.method === "POST" && pathname === "/api/v1/auth/session") {
        try { audit.record({ actorType: "SYSTEM", actorId: "IDENTITY_EXCHANGE", action: "CREATE_AUTH_SESSION", outcome: "FAILURE", details: { errorCode: appError.code }, traceId }); }
        catch { /* 主错误优先，审计写入失败由平台日志和监控捕获。 */ }
      }
      if (req.method === "POST" && pathname === "/api/v1/operator/auth/session") {
        try { audit.record({ actorType: "SYSTEM", actorId: "OPERATOR_AUTH", action: "CREATE_OPERATOR_SESSION", outcome: "FAILURE", details: { errorCode: appError.code }, traceId }); }
        catch { /* 主错误优先。 */ }
      }
      if (!(error instanceof AppError)) console.error(`[${traceId}]`, error);
      const toolInvocationId = error?.toolInvocationId;
      json(res, appError.status, { error: { code: appError.code, message: appError.message, details: appError.details, traceId } }, traceId, { ...(toolInvocationId ? { "x-tool-invocation-id": toolInvocationId } : {}), ...(appError.responseHeaders ?? {}) });
    }
  });

  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = config.headersTimeoutMs;
  server.keepAliveTimeout = config.keepAliveTimeoutMs;
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 1000;

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    if (server.listening) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          server.closeAllConnections?.();
          resolve();
        }, config.gracefulShutdownMs);
        timer.unref?.();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        server.closeIdleConnections?.();
      });
    }
    db.close();
    rateLimiter.clear();
    metrics.clear();
  }

  return { server, db, close, services: { audit, catalog, organizationDirectory, knowledge, demands, handoffs, analytics, feedback, agent, connectors, sessions, identityExchange, identityLifecycle, operatorSessions, operations, toolInvocations, rateLimiter, metrics }, secrets: { webhookSecret }, config: { productionMode: config.productionMode, runtimeProfile: config.runtimeProfile, connectorMode, inboundWebhookSystems: [...inboundWebhookSecrets.keys()], identityExchangeMode: config.identityExchangeMode, identityEventsEnabled: Boolean(identityEventSecret), operatorBootstrapEnabled: config.operatorBootstrapEnabled, rateLimitEnabled: config.rateLimitEnabled } };
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  loadLocalEnv();
  const app = createApplication();
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 8787);
  app.server.listen(port, host, () => {
    console.log(`AI统一需求平台MVP已启动：http://${host}:${port}`);
    console.log("提示：当前员工身份和下游系统均为演示适配器，请勿直接用于生产。 ");
  });
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`收到${signal}，停止接收新请求并等待在途请求完成。`);
    try { await app.close(); }
    catch (error) { console.error("优雅停机失败", error); process.exitCode = 1; }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
