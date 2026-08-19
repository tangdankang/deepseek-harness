import path from "node:path";
import { AppError } from "./domain/errors.mjs";

function strong(value) {
  return typeof value === "string" && value.length >= 32 && !value.startsWith("dev-only") && !value.startsWith("replace-with");
}

function booleanValue(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  throw new AppError("INVALID_CONFIGURATION", "布尔配置必须为true/false或1/0", 500);
}

function objectValue(value, name) {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch { /* 使用统一配置错误。 */ }
  throw new AppError("INVALID_CONFIGURATION", `${name}必须是JSON对象`, 500);
}

export function resolveRuntimeConfig(options = {}, env = process.env, projectRoot = process.cwd()) {
  const productionMode = options.productionMode ?? env.NODE_ENV === "production";
  const config = {
    productionMode,
    runtimeProfile: String(options.runtimeProfile ?? env.RUNTIME_PROFILE ?? "PILOT_SINGLE_NODE_SQLITE").toUpperCase(),
    confirmationSecret: options.confirmationSecret ?? env.CONFIRMATION_SECRET ?? "dev-only-confirmation-secret-change-me",
    webhookSecret: options.webhookSecret ?? env.MOCK_WEBHOOK_SECRET ?? "dev-only-webhook-secret-change-me",
    inboundWebhookSecretEnvs: objectValue(options.inboundWebhookSecretEnvs ?? env.INBOUND_WEBHOOK_SECRET_ENVS, "INBOUND_WEBHOOK_SECRET_ENVS"),
    businessWebhookMaxAgeSeconds: Number(options.businessWebhookMaxAgeSeconds ?? env.BUSINESS_WEBHOOK_MAX_AGE_SECONDS ?? 86400),
    toolApiKey: options.toolApiKey ?? env.TOOL_API_KEY ?? "",
    adminApiKey: options.adminApiKey ?? env.ADMIN_API_KEY ?? "",
    metricsApiKey: options.metricsApiKey ?? env.METRICS_API_KEY ?? "",
    identityHmacSecret: options.identityHmacSecret ?? env.IDENTITY_HMAC_SECRET ?? "",
    identityEventSecret: options.identityEventSecret ?? env.IDENTITY_EVENT_SECRET ?? "",
    identityEventSource: options.identityEventSource ?? env.IDENTITY_EVENT_SOURCE ?? "company-identity-gateway",
    identityEventMaxAgeSeconds: Number(options.identityEventMaxAgeSeconds ?? env.IDENTITY_EVENT_MAX_AGE_SECONDS ?? 86400),
    operatorHmacSecret: options.operatorHmacSecret ?? env.OPERATOR_HMAC_SECRET ?? "",
    identityExchangeMode: String(options.identityExchangeMode ?? env.IDENTITY_EXCHANGE_MODE ?? "header").toLowerCase(),
    identityExchangeSecret: options.identityExchangeSecret ?? env.IDENTITY_EXCHANGE_SECRET ?? "",
    identityExchangeIssuer: options.identityExchangeIssuer ?? env.IDENTITY_EXCHANGE_ISSUER ?? "company-identity-gateway",
    identityExchangeAudience: options.identityExchangeAudience ?? env.IDENTITY_EXCHANGE_AUDIENCE ?? "ai-demand-platform",
    analyticsHashSecret: options.analyticsHashSecret ?? env.ANALYTICS_HASH_SECRET ?? "dev-only-analytics-hash-secret-change-me",
    auditChainSecret: options.auditChainSecret ?? env.AUDIT_CHAIN_SECRET ?? "dev-only-audit-chain-secret-change-me",
    auditChainKeyVersion: Number(options.auditChainKeyVersion ?? env.AUDIT_CHAIN_KEY_VERSION ?? 1),
    auditChainAllowLegacyBackfill: booleanValue(options.auditChainAllowLegacyBackfill ?? env.AUDIT_CHAIN_ALLOW_LEGACY_BACKFILL, !productionMode),
    databasePath: options.databasePath ?? env.DATABASE_PATH ?? path.join(projectRoot, "data", "demand-platform.db"),
    connectorConfigPath: options.connectorConfigPath ?? env.CONNECTOR_CONFIG_PATH ?? "",
    confirmationTtlSeconds: Number(options.confirmationTtlSeconds ?? env.CONFIRMATION_TTL_SECONDS ?? 600),
    identityTtlSeconds: Number(options.identityTtlSeconds ?? env.IDENTITY_TTL_SECONDS ?? 300),
    operatorIdentityTtlSeconds: Number(options.operatorIdentityTtlSeconds ?? env.OPERATOR_IDENTITY_TTL_SECONDS ?? 300),
    identityExchangeTtlSeconds: Number(options.identityExchangeTtlSeconds ?? env.IDENTITY_EXCHANGE_TTL_SECONDS ?? 90),
    integrationMaxAttempts: Number(options.integrationMaxAttempts ?? env.INTEGRATION_MAX_ATTEMPTS ?? 5),
    integrationRetryBaseSeconds: Number(options.integrationRetryBaseSeconds ?? env.INTEGRATION_RETRY_BASE_SECONDS ?? 30),
    requestTimeoutMs: Number(options.requestTimeoutMs ?? env.REQUEST_TIMEOUT_MS ?? 30000),
    headersTimeoutMs: Number(options.headersTimeoutMs ?? env.HEADERS_TIMEOUT_MS ?? 15000),
    keepAliveTimeoutMs: Number(options.keepAliveTimeoutMs ?? env.KEEP_ALIVE_TIMEOUT_MS ?? 5000),
    gracefulShutdownMs: Number(options.gracefulShutdownMs ?? env.GRACEFUL_SHUTDOWN_MS ?? 15000),
    sessionTtlSeconds: Number(options.sessionTtlSeconds ?? env.SESSION_TTL_SECONDS ?? 3600),
    sessionMaxPerEmployee: Number(options.sessionMaxPerEmployee ?? env.SESSION_MAX_PER_EMPLOYEE ?? 10),
    sessionCookieSecure: booleanValue(options.sessionCookieSecure ?? env.SESSION_COOKIE_SECURE, options.productionMode ?? env.NODE_ENV === "production"),
    operatorSessionTtlSeconds: Number(options.operatorSessionTtlSeconds ?? env.OPERATOR_SESSION_TTL_SECONDS ?? 1800),
    operatorSessionMaxPerOperator: Number(options.operatorSessionMaxPerOperator ?? env.OPERATOR_SESSION_MAX_PER_OPERATOR ?? 5),
    operatorBootstrapEnabled: booleanValue(options.operatorBootstrapEnabled ?? env.OPERATOR_BOOTSTRAP_ENABLED, !productionMode),
    toolInvocationRetentionDays: Number(options.toolInvocationRetentionDays ?? env.TOOL_INVOCATION_RETENTION_DAYS ?? 90),
    rateLimitEnabled: booleanValue(options.rateLimitEnabled ?? env.RATE_LIMIT_ENABLED, true),
    rateLimitWindowSeconds: Number(options.rateLimitWindowSeconds ?? env.RATE_LIMIT_WINDOW_SECONDS ?? 60),
    employeeRateLimit: Number(options.employeeRateLimit ?? env.EMPLOYEE_RATE_LIMIT ?? 120),
    toolRateLimit: Number(options.toolRateLimit ?? env.TOOL_RATE_LIMIT ?? 300),
    authRateLimit: Number(options.authRateLimit ?? env.AUTH_RATE_LIMIT ?? 600),
    adminRateLimit: Number(options.adminRateLimit ?? env.ADMIN_RATE_LIMIT ?? 300),
    webhookRateLimit: Number(options.webhookRateLimit ?? env.WEBHOOK_RATE_LIMIT ?? 600),
    rateLimitMaxEntries: Number(options.rateLimitMaxEntries ?? env.RATE_LIMIT_MAX_ENTRIES ?? 50000),
  };
  if (!new Set(["PILOT_SINGLE_NODE_SQLITE", "PRODUCTION_HIGH_AVAILABILITY"]).has(config.runtimeProfile)) {
    throw new AppError("INVALID_CONFIGURATION", "RUNTIME_PROFILE必须为PILOT_SINGLE_NODE_SQLITE或PRODUCTION_HIGH_AVAILABILITY", 500);
  }
  if (config.runtimeProfile === "PRODUCTION_HIGH_AVAILABILITY") {
    throw new AppError("UNSUPPORTED_HIGH_AVAILABILITY_RUNTIME", "当前版本仅实现单机SQLite试点运行时；高可用档位必须先接入公司批准的共享数据库、分布式限流和任务协调适配器", 500);
  }
  if (!Number.isInteger(config.confirmationTtlSeconds) || config.confirmationTtlSeconds < 60 || config.confirmationTtlSeconds > 3600) {
    throw new AppError("INVALID_CONFIGURATION", "CONFIRMATION_TTL_SECONDS必须为60至3600秒", 500);
  }
  if (!Number.isInteger(config.identityTtlSeconds) || config.identityTtlSeconds < 30 || config.identityTtlSeconds > 900) {
    throw new AppError("INVALID_CONFIGURATION", "IDENTITY_TTL_SECONDS必须为30至900秒", 500);
  }
  if (!Number.isInteger(config.businessWebhookMaxAgeSeconds) || config.businessWebhookMaxAgeSeconds < 300 || config.businessWebhookMaxAgeSeconds > 604800) {
    throw new AppError("INVALID_CONFIGURATION", "BUSINESS_WEBHOOK_MAX_AGE_SECONDS必须为300至604800秒", 500);
  }
  if (typeof config.identityEventSource !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/.test(config.identityEventSource)) {
    throw new AppError("INVALID_CONFIGURATION", "IDENTITY_EVENT_SOURCE格式无效", 500);
  }
  if (!Number.isInteger(config.identityEventMaxAgeSeconds) || config.identityEventMaxAgeSeconds < 300 || config.identityEventMaxAgeSeconds > 604800) {
    throw new AppError("INVALID_CONFIGURATION", "IDENTITY_EVENT_MAX_AGE_SECONDS必须为300至604800秒", 500);
  }
  if (!Number.isInteger(config.operatorIdentityTtlSeconds) || config.operatorIdentityTtlSeconds < 30 || config.operatorIdentityTtlSeconds > 900) {
    throw new AppError("INVALID_CONFIGURATION", "OPERATOR_IDENTITY_TTL_SECONDS必须为30至900秒", 500);
  }
  if (!new Set(["header", "ticket", "both"]).has(config.identityExchangeMode)) {
    throw new AppError("INVALID_CONFIGURATION", "IDENTITY_EXCHANGE_MODE必须为header、ticket或both", 500);
  }
  if (!Number.isInteger(config.identityExchangeTtlSeconds) || config.identityExchangeTtlSeconds < 30 || config.identityExchangeTtlSeconds > 300) {
    throw new AppError("INVALID_CONFIGURATION", "IDENTITY_EXCHANGE_TTL_SECONDS必须为30至300秒", 500);
  }
  for (const [name, value] of [["IDENTITY_EXCHANGE_ISSUER", config.identityExchangeIssuer], ["IDENTITY_EXCHANGE_AUDIENCE", config.identityExchangeAudience]]) {
    if (typeof value !== "string" || value.length < 3 || value.length > 200 || !/^[A-Za-z0-9._:/-]+$/.test(value)) {
      throw new AppError("INVALID_CONFIGURATION", `${name}格式无效`, 500);
    }
  }
  if (["ticket", "both"].includes(config.identityExchangeMode) && !strong(config.identityExchangeSecret)) {
    throw new AppError("INVALID_CONFIGURATION", "启用一次性身份交换时IDENTITY_EXCHANGE_SECRET必须为至少32位的非示例随机值", 500);
  }
  if (!Number.isInteger(config.integrationMaxAttempts) || config.integrationMaxAttempts < 1 || config.integrationMaxAttempts > 20) {
    throw new AppError("INVALID_CONFIGURATION", "INTEGRATION_MAX_ATTEMPTS必须为1至20", 500);
  }
  if (!Number.isInteger(config.integrationRetryBaseSeconds) || config.integrationRetryBaseSeconds < 0 || config.integrationRetryBaseSeconds > 3600) {
    throw new AppError("INVALID_CONFIGURATION", "INTEGRATION_RETRY_BASE_SECONDS必须为0至3600秒", 500);
  }
  for (const [name, value, min, max] of [
    ["REQUEST_TIMEOUT_MS", config.requestTimeoutMs, 1000, 120000],
    ["HEADERS_TIMEOUT_MS", config.headersTimeoutMs, 1000, 60000],
    ["KEEP_ALIVE_TIMEOUT_MS", config.keepAliveTimeoutMs, 500, 30000],
    ["GRACEFUL_SHUTDOWN_MS", config.gracefulShutdownMs, 1000, 60000],
  ]) {
    if (!Number.isInteger(value) || value < min || value > max) throw new AppError("INVALID_CONFIGURATION", `${name}必须为${min}至${max}毫秒`, 500);
  }
  if (config.headersTimeoutMs > config.requestTimeoutMs) throw new AppError("INVALID_CONFIGURATION", "HEADERS_TIMEOUT_MS不得大于REQUEST_TIMEOUT_MS", 500);
  if (!Number.isInteger(config.sessionTtlSeconds) || config.sessionTtlSeconds < 300 || config.sessionTtlSeconds > 28800) {
    throw new AppError("INVALID_CONFIGURATION", "SESSION_TTL_SECONDS必须为300至28800秒", 500);
  }
  if (!Number.isInteger(config.sessionMaxPerEmployee) || config.sessionMaxPerEmployee < 1 || config.sessionMaxPerEmployee > 20) {
    throw new AppError("INVALID_CONFIGURATION", "SESSION_MAX_PER_EMPLOYEE必须为1至20", 500);
  }
  if (!Number.isInteger(config.operatorSessionTtlSeconds) || config.operatorSessionTtlSeconds < 300 || config.operatorSessionTtlSeconds > 14400) {
    throw new AppError("INVALID_CONFIGURATION", "OPERATOR_SESSION_TTL_SECONDS必须为300至14400秒", 500);
  }
  if (!Number.isInteger(config.operatorSessionMaxPerOperator) || config.operatorSessionMaxPerOperator < 1 || config.operatorSessionMaxPerOperator > 10) {
    throw new AppError("INVALID_CONFIGURATION", "OPERATOR_SESSION_MAX_PER_OPERATOR必须为1至10", 500);
  }
  if (!Number.isInteger(config.toolInvocationRetentionDays) || config.toolInvocationRetentionDays < 7 || config.toolInvocationRetentionDays > 365) {
    throw new AppError("INVALID_CONFIGURATION", "TOOL_INVOCATION_RETENTION_DAYS必须为7至365天", 500);
  }
  if (!Number.isInteger(config.rateLimitWindowSeconds) || config.rateLimitWindowSeconds < 1 || config.rateLimitWindowSeconds > 3600) {
    throw new AppError("INVALID_CONFIGURATION", "RATE_LIMIT_WINDOW_SECONDS必须为1至3600秒", 500);
  }
  for (const [name, value] of [
    ["EMPLOYEE_RATE_LIMIT", config.employeeRateLimit],
    ["TOOL_RATE_LIMIT", config.toolRateLimit],
    ["AUTH_RATE_LIMIT", config.authRateLimit],
    ["ADMIN_RATE_LIMIT", config.adminRateLimit],
    ["WEBHOOK_RATE_LIMIT", config.webhookRateLimit],
  ]) {
    if (!Number.isInteger(value) || value < 1 || value > 100000) throw new AppError("INVALID_CONFIGURATION", `${name}必须为1至100000`, 500);
  }
  if (!Number.isInteger(config.rateLimitMaxEntries) || config.rateLimitMaxEntries < 1000 || config.rateLimitMaxEntries > 1000000) {
    throw new AppError("INVALID_CONFIGURATION", "RATE_LIMIT_MAX_ENTRIES必须为1000至1000000", 500);
  }
  if (!Number.isInteger(config.auditChainKeyVersion) || config.auditChainKeyVersion < 1 || config.auditChainKeyVersion > 9999) {
    throw new AppError("INVALID_CONFIGURATION", "AUDIT_CHAIN_KEY_VERSION必须为1至9999", 500);
  }
  if (config.productionMode) {
    const required = [
      ["CONFIRMATION_SECRET", config.confirmationSecret],
      ["MOCK_WEBHOOK_SECRET", config.webhookSecret],
      ["TOOL_API_KEY", config.toolApiKey],
      ["ADMIN_API_KEY", config.adminApiKey],
      ["METRICS_API_KEY", config.metricsApiKey],
      ["IDENTITY_HMAC_SECRET", config.identityHmacSecret],
      ["IDENTITY_EVENT_SECRET", config.identityEventSecret],
      ["OPERATOR_HMAC_SECRET", config.operatorHmacSecret],
      ["ANALYTICS_HASH_SECRET", config.analyticsHashSecret],
      ["AUDIT_CHAIN_SECRET", config.auditChainSecret],
    ];
    if (["ticket", "both"].includes(config.identityExchangeMode)) required.push(["IDENTITY_EXCHANGE_SECRET", config.identityExchangeSecret]);
    for (const [name, value] of required) {
      if (!strong(value)) throw new AppError("INSECURE_PRODUCTION_CONFIGURATION", `${name}必须设置为至少32位的非示例随机值`, 500, { name });
    }
    if (new Set(required.map(([, value]) => value)).size !== required.length) {
      throw new AppError("INSECURE_PRODUCTION_CONFIGURATION", "生产环境的不同用途密钥不得复用", 500);
    }
    if (config.databasePath === ":memory:") throw new AppError("INSECURE_PRODUCTION_CONFIGURATION", "生产环境不得使用内存数据库", 500);
    if (!config.sessionCookieSecure) throw new AppError("INSECURE_PRODUCTION_CONFIGURATION", "生产环境会话Cookie必须启用Secure", 500);
    if (config.operatorBootstrapEnabled) throw new AppError("INSECURE_PRODUCTION_CONFIGURATION", "生产环境不得启用Admin Key浏览器运营会话引导", 500);
    if (!config.rateLimitEnabled) throw new AppError("INSECURE_PRODUCTION_CONFIGURATION", "生产环境不得关闭平台侧限流", 500);
  }
  return config;
}
