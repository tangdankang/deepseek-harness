import crypto from "node:crypto";
import { AppError } from "./errors.mjs";
import { normalizeDepartmentMemberships } from "./employee-identity.mjs";

function payload({ employeeId, departmentId, departmentIds, name, timestamp }) {
  if (departmentIds !== undefined) {
    const memberships = normalizeDepartmentMemberships(departmentId, departmentIds, { code: "INVALID_IDENTITY_SIGNATURE", status: 401 });
    return `v2\n${employeeId}\n${departmentId}\n${JSON.stringify(memberships)}\n${name ?? ""}\n${timestamp}`;
  }
  return `${employeeId}\n${departmentId}\n${timestamp}`;
}

export function signIdentityContext({ employeeId, departmentId, departmentIds, name, timestamp, secret }) {
  return crypto.createHmac("sha256", secret).update(payload({ employeeId, departmentId, departmentIds, name, timestamp })).digest("hex");
}

export function verifyIdentityContext({ employeeId, departmentId, departmentIds, name, timestamp, signature, secret, ttlSeconds = 300, now = Date.now() }) {
  const parsedTimestamp = Number(timestamp);
  if (!Number.isInteger(parsedTimestamp)) throw new AppError("INVALID_IDENTITY_SIGNATURE", "身份时间戳无效", 401);
  const ageSeconds = Math.floor(now / 1000) - parsedTimestamp;
  if (ageSeconds < -30 || ageSeconds > ttlSeconds) throw new AppError("IDENTITY_SIGNATURE_EXPIRED", "员工身份上下文已过期", 401);
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/i.test(signature)) throw new AppError("INVALID_IDENTITY_SIGNATURE", "员工身份签名无效", 401);
  const expected = signIdentityContext({ employeeId, departmentId, departmentIds, name, timestamp: parsedTimestamp, secret });
  const valid = crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  if (!valid) throw new AppError("INVALID_IDENTITY_SIGNATURE", "员工身份签名无效", 401);
  return true;
}
