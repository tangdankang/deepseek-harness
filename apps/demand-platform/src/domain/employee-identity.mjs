import { AppError } from "./errors.mjs";

function invalid(code, status, message, details) {
  throw new AppError(code, message, status, details);
}

function department(value, path, code, status) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 128) invalid(code, status, `${path}格式无效`, { path });
  return value.trim();
}

export function normalizeDepartmentMemberships(departmentId, departmentIds, { code = "INVALID_IDENTITY_CONTEXT", status = 400 } = {}) {
  const primary = department(departmentId, "departmentId", code, status);
  if (departmentIds === undefined) return [primary];
  if (!Array.isArray(departmentIds) || departmentIds.length < 1 || departmentIds.length > 20) invalid(code, status, "departmentIds必须包含1至20个部门", { path: "departmentIds" });
  const normalized = departmentIds.map((value, index) => department(value, `departmentIds[${index}]`, code, status));
  if (new Set(normalized).size !== normalized.length) invalid(code, status, "departmentIds不能重复", { path: "departmentIds" });
  if (!normalized.includes(primary)) invalid(code, status, "departmentIds必须包含主部门departmentId", { path: "departmentIds", departmentId: primary });
  return [primary, ...normalized.filter((value) => value !== primary).sort()];
}

export function employeeDepartmentIds(employee) {
  const values = Array.isArray(employee?.departmentIds) && employee.departmentIds.length ? employee.departmentIds : undefined;
  return normalizeDepartmentMemberships(employee?.departmentId, values);
}
