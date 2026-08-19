import crypto from "node:crypto";
import { AppError } from "./errors.mjs";

export const OperatorRole = Object.freeze({
  OPS_VIEWER: "OPS_VIEWER",
  HANDOFF_OPERATOR: "HANDOFF_OPERATOR",
  INTEGRATION_OPERATOR: "INTEGRATION_OPERATOR",
  SECURITY_ADMIN: "SECURITY_ADMIN",
  PLATFORM_ADMIN: "PLATFORM_ADMIN",
});

export const OperatorPermission = Object.freeze({
  VIEW_OVERVIEW: "VIEW_OVERVIEW",
  VIEW_HANDOFFS: "VIEW_HANDOFFS",
  MANAGE_HANDOFFS: "MANAGE_HANDOFFS",
  VIEW_INTEGRATIONS: "VIEW_INTEGRATIONS",
  MANAGE_INTEGRATIONS: "MANAGE_INTEGRATIONS",
  VIEW_CASES: "VIEW_CASES",
  VIEW_AUDIT: "VIEW_AUDIT",
  MANAGE_SESSIONS: "MANAGE_SESSIONS",
});

const ALL_ROLES = new Set(Object.values(OperatorRole));
const ALL_PERMISSIONS = Object.values(OperatorPermission);
const ROLE_PERMISSIONS = new Map([
  [OperatorRole.OPS_VIEWER, new Set([OperatorPermission.VIEW_OVERVIEW, OperatorPermission.VIEW_HANDOFFS, OperatorPermission.VIEW_INTEGRATIONS, OperatorPermission.VIEW_CASES, OperatorPermission.VIEW_AUDIT])],
  [OperatorRole.HANDOFF_OPERATOR, new Set([OperatorPermission.VIEW_OVERVIEW, OperatorPermission.VIEW_HANDOFFS, OperatorPermission.MANAGE_HANDOFFS, OperatorPermission.VIEW_CASES])],
  [OperatorRole.INTEGRATION_OPERATOR, new Set([OperatorPermission.VIEW_OVERVIEW, OperatorPermission.VIEW_INTEGRATIONS, OperatorPermission.MANAGE_INTEGRATIONS, OperatorPermission.VIEW_CASES])],
  [OperatorRole.SECURITY_ADMIN, new Set([OperatorPermission.VIEW_OVERVIEW, OperatorPermission.VIEW_AUDIT, OperatorPermission.MANAGE_SESSIONS])],
  [OperatorRole.PLATFORM_ADMIN, new Set(ALL_PERMISSIONS)],
]);

function normalizedText(value, name, maximum) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum) throw new AppError("INVALID_OPERATOR_CONTEXT", `${name}格式无效`, 401);
  return normalized;
}

export function normalizeOperatorRoles(roles) {
  const input = Array.isArray(roles) ? roles : String(roles ?? "").split(",");
  const normalized = [...new Set(input.map((role) => String(role).trim().toUpperCase()).filter(Boolean))].sort();
  if (normalized.length === 0 || normalized.length > 5 || normalized.some((role) => !ALL_ROLES.has(role))) {
    throw new AppError("INVALID_OPERATOR_ROLES", "运营角色无效", 403, { allowed: [...ALL_ROLES] });
  }
  return normalized;
}

function payload({ operatorId, name, roles, timestamp }) {
  return `${operatorId}\n${name}\n${roles.join(",")}\n${timestamp}`;
}

export function signOperatorContext({ operatorId, name, roles, timestamp, secret }) {
  const normalizedRoles = normalizeOperatorRoles(roles);
  return crypto.createHmac("sha256", secret).update(payload({
    operatorId: normalizedText(operatorId, "operatorId", 128),
    name: normalizedText(name, "name", 200),
    roles: normalizedRoles,
    timestamp,
  })).digest("hex");
}

export function verifyOperatorContext({ operatorId, name, roles, timestamp, signature, secret, ttlSeconds = 300, now = Date.now() }) {
  const normalizedOperatorId = normalizedText(operatorId, "operatorId", 128);
  const normalizedName = normalizedText(name, "name", 200);
  const normalizedRoles = normalizeOperatorRoles(roles);
  const parsedTimestamp = Number(timestamp);
  if (!Number.isInteger(parsedTimestamp)) throw new AppError("INVALID_OPERATOR_SIGNATURE", "运营身份时间戳无效", 401);
  const ageSeconds = Math.floor(now / 1000) - parsedTimestamp;
  if (ageSeconds < -30 || ageSeconds > ttlSeconds) throw new AppError("OPERATOR_SIGNATURE_EXPIRED", "运营身份上下文已过期", 401);
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/i.test(signature)) throw new AppError("INVALID_OPERATOR_SIGNATURE", "运营身份签名无效", 401);
  const expected = signOperatorContext({ operatorId: normalizedOperatorId, name: normalizedName, roles: normalizedRoles, timestamp: parsedTimestamp, secret });
  const valid = crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  if (!valid) throw new AppError("INVALID_OPERATOR_SIGNATURE", "运营身份签名无效", 401);
  return { operatorId: normalizedOperatorId, name: normalizedName, roles: normalizedRoles, permissions: permissionsForRoles(normalizedRoles) };
}

export function permissionsForRoles(roles) {
  const permissions = new Set();
  for (const role of normalizeOperatorRoles(roles)) for (const permission of ROLE_PERMISSIONS.get(role)) permissions.add(permission);
  return [...permissions].sort();
}

export function requireOperatorPermission(operator, permission) {
  if (!Object.values(OperatorPermission).includes(permission)) throw new AppError("INVALID_PERMISSION", "未知运营权限", 500);
  if (!operator?.permissions?.includes(permission)) throw new AppError("OPERATOR_PERMISSION_DENIED", "当前运营角色无权执行该操作", 403, { permission });
  return operator;
}
