import { AppError } from "./errors.mjs";
import { stableJson } from "./service-definition.mjs";

function fail(message, details) {
  throw new AppError("INVALID_ORGANIZATION_SNAPSHOT", message, 422, details);
}

function text(value, path, maximum = 200) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) fail(`${path}格式无效`, { path });
  return value.trim();
}

function timestamp(value, path) {
  const normalized = text(value, path, 40);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) fail(`${path}必须是规范UTC ISO时间`, { path });
  return normalized;
}

export function validateOrganizationSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) fail("组织快照必须是对象", { path: "$" });
  const allowed = new Set(["version", "sourceSystem", "generatedAt", "expiresAt", "departments"]);
  const unknown = Object.keys(snapshot).filter((key) => !allowed.has(key));
  if (unknown.length) fail("组织快照包含未知字段", { path: "$", unknown });
  if (!Number.isInteger(snapshot.version) || snapshot.version < 1) fail("version必须是正整数", { path: "version" });
  const sourceSystem = text(snapshot.sourceSystem, "sourceSystem", 64).toUpperCase();
  const generatedAt = timestamp(snapshot.generatedAt, "generatedAt");
  const expiresAt = timestamp(snapshot.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(generatedAt)) fail("expiresAt必须晚于generatedAt", { path: "expiresAt" });
  if (Date.parse(expiresAt) - Date.parse(generatedAt) > 90 * 86400_000) fail("组织快照有效期不能超过90天", { path: "expiresAt" });
  if (!Array.isArray(snapshot.departments) || snapshot.departments.length < 1 || snapshot.departments.length > 10000) {
    fail("departments必须包含1至10000个部门", { path: "departments" });
  }
  const departments = snapshot.departments.map((department, index) => {
    const path = `departments[${index}]`;
    if (!department || typeof department !== "object" || Array.isArray(department)) fail(`${path}必须是对象`, { path });
    const fields = Object.keys(department).filter((key) => !["departmentId", "name", "parentDepartmentId"].includes(key));
    if (fields.length) fail(`${path}包含未知字段`, { path, unknown: fields });
    const departmentId = text(department.departmentId, `${path}.departmentId`, 128);
    const name = text(department.name, `${path}.name`, 200);
    const parentDepartmentId = department.parentDepartmentId === null ? null : text(department.parentDepartmentId, `${path}.parentDepartmentId`, 128);
    if (parentDepartmentId === departmentId) fail("部门不能以自身为父部门", { path: `${path}.parentDepartmentId`, departmentId });
    return { departmentId, name, parentDepartmentId };
  });
  const ids = departments.map((item) => item.departmentId);
  if (new Set(ids).size !== ids.length) fail("departmentId不能重复", { path: "departments" });
  const byId = new Map(departments.map((item) => [item.departmentId, item]));
  for (const department of departments) {
    if (department.parentDepartmentId && !byId.has(department.parentDepartmentId)) fail("父部门不存在于同一快照", { departmentId: department.departmentId, parentDepartmentId: department.parentDepartmentId });
    const visited = new Set([department.departmentId]);
    let current = department;
    while (current.parentDepartmentId) {
      if (visited.has(current.parentDepartmentId)) fail("组织层级存在循环", { departmentId: department.departmentId });
      visited.add(current.parentDepartmentId);
      current = byId.get(current.parentDepartmentId);
    }
  }
  if (!departments.some((item) => item.parentDepartmentId === null)) fail("组织快照必须至少有一个根部门", { path: "departments" });
  return { version: snapshot.version, sourceSystem, generatedAt, expiresAt, departments };
}

export { stableJson };
