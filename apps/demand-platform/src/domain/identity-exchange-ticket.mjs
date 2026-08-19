import crypto from "node:crypto";
import { AppError } from "./errors.mjs";
import { normalizeDepartmentMemberships } from "./employee-identity.mjs";

const VERSION = "v1";
const ALLOWED_CLAIMS = new Set(["iss", "aud", "sub", "dept", "depts", "name", "iat", "exp", "jti"]);

function signInput(encodedPayload) {
  return `${VERSION}.${encodedPayload}`;
}

function signature(encodedPayload, secret) {
  return crypto.createHmac("sha256", secret).update(signInput(encodedPayload)).digest("base64url");
}

function requiredString(value, name, maximum = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new AppError("INVALID_IDENTITY_TICKET", `身份交换票据字段${name}无效`, 401);
  }
  return value.trim();
}

function validEndpointId(value, name) {
  const normalized = requiredString(value, name, 200);
  if (!/^[A-Za-z0-9._:/-]+$/.test(normalized)) throw new AppError("INVALID_IDENTITY_TICKET", `身份交换票据字段${name}无效`, 401);
  return normalized;
}

function timingSafeSignature(actual, expected) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(actual)) return false;
  const left = Buffer.from(actual, "base64url");
  const right = Buffer.from(expected, "base64url");
  if (left.toString("base64url") !== actual) return false;
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function validateClaims(claims, { issuer, audience, maxTtlSeconds, now }) {
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) throw new AppError("INVALID_IDENTITY_TICKET", "身份交换票据载荷无效", 401);
  const unknown = Object.keys(claims).filter((key) => !ALLOWED_CLAIMS.has(key));
  if (unknown.length > 0) throw new AppError("INVALID_IDENTITY_TICKET", "身份交换票据包含未知字段", 401);

  const normalizedIssuer = validEndpointId(claims.iss, "iss");
  const normalizedAudience = validEndpointId(claims.aud, "aud");
  if (normalizedIssuer !== issuer || normalizedAudience !== audience) throw new AppError("INVALID_IDENTITY_TICKET", "身份交换票据签发方或受众不匹配", 401);

  const employeeId = requiredString(claims.sub, "sub", 128);
  const departmentId = requiredString(claims.dept, "dept", 128);
  const departmentIds = normalizeDepartmentMemberships(departmentId, claims.depts, { code: "INVALID_IDENTITY_TICKET", status: 401 });
  const name = requiredString(claims.name, "name", 200);
  const ticketId = requiredString(claims.jti, "jti", 128);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(ticketId)) throw new AppError("INVALID_IDENTITY_TICKET", "身份交换票据jti无效", 401);
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.exp <= claims.iat || claims.exp - claims.iat > maxTtlSeconds) {
    throw new AppError("INVALID_IDENTITY_TICKET", "身份交换票据时间窗无效", 401);
  }
  const nowSeconds = Math.floor(now / 1000);
  if (claims.iat > nowSeconds + 30) throw new AppError("INVALID_IDENTITY_TICKET", "身份交换票据签发时间超前", 401);
  if (claims.exp <= nowSeconds) throw new AppError("IDENTITY_TICKET_EXPIRED", "身份交换票据已过期", 401);

  return {
    employee: { employeeId, departmentId, departmentIds, name },
    ticketId,
    issuer: normalizedIssuer,
    audience: normalizedAudience,
    issuedAt: new Date(claims.iat * 1000).toISOString(),
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  };
}

export function issueIdentityExchangeTicket({ employee, issuer, audience, secret, ttlSeconds = 90, now = Date.now(), ticketId = crypto.randomBytes(18).toString("base64url") }) {
  if (typeof secret !== "string" || secret.length < 32) throw new AppError("INVALID_CONFIGURATION", "身份交换票据签名密钥至少需要32位", 500);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 300) throw new AppError("INVALID_CONFIGURATION", "身份交换票据有效期必须为30至300秒", 500);
  const issuedAt = Math.floor(now / 1000);
  const claims = {
    iss: validEndpointId(issuer, "iss"),
    aud: validEndpointId(audience, "aud"),
    sub: requiredString(employee?.employeeId, "sub", 128),
    dept: requiredString(employee?.departmentId, "dept", 128),
    name: requiredString(employee?.name, "name", 200),
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    jti: requiredString(ticketId, "jti", 128),
  };
  if (employee?.departmentIds !== undefined) claims.depts = normalizeDepartmentMemberships(claims.dept, employee.departmentIds, { code: "INVALID_IDENTITY_TICKET", status: 401 });
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(claims.jti)) throw new AppError("INVALID_IDENTITY_TICKET", "身份交换票据jti无效", 401);
  const encodedPayload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${signInput(encodedPayload)}.${signature(encodedPayload, secret)}`;
}

export function verifyIdentityExchangeTicket({ ticket, issuer, audience, secret, maxTtlSeconds = 90, now = Date.now() }) {
  if (typeof secret !== "string" || secret.length < 32) throw new AppError("IDENTITY_EXCHANGE_DISABLED", "一次性身份交换未配置", 401);
  if (typeof ticket !== "string" || ticket.length < 40 || ticket.length > 4096) throw new AppError("INVALID_IDENTITY_TICKET", "身份交换票据无效", 401);
  const parts = ticket.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION || !parts[1] || !parts[2]) throw new AppError("INVALID_IDENTITY_TICKET", "身份交换票据格式无效", 401);
  const expected = signature(parts[1], secret);
  if (!timingSafeSignature(parts[2], expected)) throw new AppError("INVALID_IDENTITY_TICKET", "身份交换票据签名无效", 401);

  let claims;
  try {
    const decoded = Buffer.from(parts[1], "base64url");
    if (decoded.toString("base64url") !== parts[1]) throw new Error("non-canonical");
    claims = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new AppError("INVALID_IDENTITY_TICKET", "身份交换票据载荷无效", 401);
  }
  return validateClaims(claims, { issuer, audience, maxTtlSeconds, now });
}
