import { AppError } from "./errors.mjs";

const FIELD_TYPES = new Set(["string", "textarea", "date", "enum", "boolean", "array"]);
const RISK_LEVELS = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const FIELD_PATTERN = /^[a-z][A-Za-z0-9]{1,63}$/;
const AUDIENCE_VISIBILITIES = new Set(["ALL_EMPLOYEES", "DEPARTMENTS"]);

function fail(message, details) {
  throw new AppError("INVALID_SERVICE_DEFINITION", message, 422, details);
}

function requiredText(value, path, maxLength = 500) {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maxLength) {
    fail(`${path} 必须是1至${maxLength}个字符的文本`, { path });
  }
  return value.trim();
}

function validateField(field, index) {
  const path = `schema.fields[${index}]`;
  if (!field || typeof field !== "object" || Array.isArray(field)) fail(`${path} 必须是对象`, { path });
  const name = requiredText(field.name, `${path}.name`, 64);
  if (!FIELD_PATTERN.test(name)) fail(`${path}.name 必须使用 lowerCamelCase`, { path: `${path}.name`, value: name });
  const label = requiredText(field.label, `${path}.label`, 100);
  const type = requiredText(field.type, `${path}.type`, 20);
  if (!FIELD_TYPES.has(type)) fail(`${path}.type 不受支持`, { path: `${path}.type`, value: type, allowed: [...FIELD_TYPES] });
  if (field.required !== undefined && typeof field.required !== "boolean") fail(`${path}.required 必须是布尔值`, { path: `${path}.required` });
  for (const key of ["minLength", "maxLength"]) {
    if (field[key] !== undefined && (!Number.isInteger(field[key]) || field[key] < 0 || field[key] > 10000)) {
      fail(`${path}.${key} 必须是0至10000的整数`, { path: `${path}.${key}` });
    }
  }
  if (field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength) {
    fail(`${path}.minLength 不能大于 maxLength`, { path });
  }
  if (field.pattern !== undefined) {
    requiredText(field.pattern, `${path}.pattern`, 500);
    try { new RegExp(field.pattern); } catch { fail(`${path}.pattern 不是有效正则表达式`, { path: `${path}.pattern` }); }
  }
  if (type === "enum") {
    if (!Array.isArray(field.options) || field.options.length === 0 || field.options.length > 100) {
      fail(`${path}.options 必须包含1至100个枚举项`, { path: `${path}.options` });
    }
    const values = new Set();
    for (const [optionIndex, option] of field.options.entries()) {
      const optionPath = `${path}.options[${optionIndex}]`;
      if (!option || typeof option !== "object" || Array.isArray(option)) fail(`${optionPath} 必须是对象`, { path: optionPath });
      const value = requiredText(option.value, `${optionPath}.value`, 100);
      requiredText(option.label, `${optionPath}.label`, 100);
      if (values.has(value)) fail(`${path}.options 存在重复值`, { path: `${path}.options`, value });
      values.add(value);
    }
  } else if (field.options !== undefined) {
    fail(`${path}.options 仅允许用于 enum 类型`, { path: `${path}.options` });
  }
  return { ...field, name, label, type, required: Boolean(field.required) };
}

function validateAudiencePolicy(policy = { visibility: "ALL_EMPLOYEES", departmentIds: [] }) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) fail("audiencePolicy 必须是对象", { path: "audiencePolicy" });
  const unknown = Object.keys(policy).filter((key) => ![
    "visibility", "departmentIds", "includeDescendants", "includeEmployeeIds", "excludeEmployeeIds",
  ].includes(key));
  if (unknown.length > 0) fail("audiencePolicy 包含未知字段", { path: "audiencePolicy", unknown });
  const visibility = requiredText(policy.visibility ?? "ALL_EMPLOYEES", "audiencePolicy.visibility", 30).toUpperCase();
  if (!AUDIENCE_VISIBILITIES.has(visibility)) fail("audiencePolicy.visibility 不受支持", { path: "audiencePolicy.visibility", visibility, allowed: [...AUDIENCE_VISIBILITIES] });
  const rawDepartments = policy.departmentIds ?? [];
  if (!Array.isArray(rawDepartments) || rawDepartments.length > 200) fail("audiencePolicy.departmentIds 必须是最多200项的数组", { path: "audiencePolicy.departmentIds" });
  const departmentIds = rawDepartments.map((value, index) => requiredText(value, `audiencePolicy.departmentIds[${index}]`, 128));
  if (new Set(departmentIds).size !== departmentIds.length) fail("audiencePolicy.departmentIds 不能重复", { path: "audiencePolicy.departmentIds" });
  if (policy.includeDescendants !== undefined && typeof policy.includeDescendants !== "boolean") fail("audiencePolicy.includeDescendants 必须是布尔值", { path: "audiencePolicy.includeDescendants" });
  const includeDescendants = Boolean(policy.includeDescendants);
  const normalizeEmployees = (key) => {
    const values = policy[key] ?? [];
    if (!Array.isArray(values) || values.length > 500) fail(`audiencePolicy.${key} 必须是最多500项的数组`, { path: `audiencePolicy.${key}` });
    const normalized = values.map((value, index) => requiredText(value, `audiencePolicy.${key}[${index}]`, 128));
    if (new Set(normalized).size !== normalized.length) fail(`audiencePolicy.${key} 不能重复`, { path: `audiencePolicy.${key}` });
    return normalized;
  };
  const includeEmployeeIds = normalizeEmployees("includeEmployeeIds");
  const excludeEmployeeIds = normalizeEmployees("excludeEmployeeIds");
  const overlap = includeEmployeeIds.filter((employeeId) => excludeEmployeeIds.includes(employeeId));
  if (overlap.length > 0) fail("同一员工不能同时位于包含和排除名单", { path: "audiencePolicy", employeeIds: overlap });
  if (visibility === "DEPARTMENTS" && departmentIds.length === 0 && includeEmployeeIds.length === 0) fail("DEPARTMENTS可见性必须至少指定一个部门或包含员工", { path: "audiencePolicy" });
  if (visibility === "ALL_EMPLOYEES" && departmentIds.length > 0) fail("ALL_EMPLOYEES可见性不能同时指定部门", { path: "audiencePolicy.departmentIds" });
  if (visibility === "ALL_EMPLOYEES" && includeDescendants) fail("ALL_EMPLOYEES可见性不能启用部门子树", { path: "audiencePolicy.includeDescendants" });
  if (visibility === "ALL_EMPLOYEES" && includeEmployeeIds.length > 0) fail("ALL_EMPLOYEES可见性不需要包含员工例外", { path: "audiencePolicy.includeEmployeeIds" });
  return { visibility, departmentIds, includeDescendants, includeEmployeeIds, excludeEmployeeIds };
}

export function validateServiceDefinition(definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) fail("服务定义必须是对象", { path: "$" });
  const serviceCode = requiredText(definition.serviceCode, "serviceCode", 64).toUpperCase();
  if (!CODE_PATTERN.test(serviceCode)) fail("serviceCode 必须是大写字母开头的大写编码", { path: "serviceCode", value: serviceCode });
  const riskLevel = requiredText(definition.riskLevel, "riskLevel", 20).toUpperCase();
  if (!RISK_LEVELS.has(riskLevel)) fail("riskLevel 不受支持", { path: "riskLevel", value: riskLevel, allowed: [...RISK_LEVELS] });
  if (!definition.aiPolicy || typeof definition.aiPolicy !== "object" || Array.isArray(definition.aiPolicy)) fail("aiPolicy 必须是对象", { path: "aiPolicy" });
  if (!Array.isArray(definition.keywords) || definition.keywords.length === 0 || definition.keywords.length > 100) {
    fail("keywords 必须包含1至100个关键词", { path: "keywords" });
  }
  const keywords = definition.keywords.map((keyword, index) => requiredText(keyword, `keywords[${index}]`, 100));
  if (new Set(keywords.map((keyword) => keyword.toLowerCase())).size !== keywords.length) fail("keywords 不能重复", { path: "keywords" });
  if (!definition.schema || typeof definition.schema !== "object" || Array.isArray(definition.schema)) fail("schema 必须是对象", { path: "schema" });
  if (!Number.isInteger(definition.schema.version) || definition.schema.version < 1) fail("schema.version 必须是正整数", { path: "schema.version" });
  if (!Array.isArray(definition.schema.fields) || definition.schema.fields.length === 0 || definition.schema.fields.length > 100) {
    fail("schema.fields 必须包含1至100个字段", { path: "schema.fields" });
  }
  const fields = definition.schema.fields.map(validateField);
  const names = fields.map((field) => field.name);
  if (new Set(names).size !== names.length) fail("schema.fields 存在重复字段名", { path: "schema.fields" });
  return {
    serviceCode,
    serviceName: requiredText(definition.serviceName, "serviceName", 120),
    domainCode: requiredText(definition.domainCode, "domainCode", 64).toUpperCase(),
    ownerTeam: requiredText(definition.ownerTeam, "ownerTeam", 120),
    description: requiredText(definition.description, "description", 1000),
    targetSystem: requiredText(definition.targetSystem, "targetSystem", 64).toUpperCase(),
    targetTicketType: requiredText(definition.targetTicketType, "targetTicketType", 64).toUpperCase(),
    riskLevel,
    aiPolicy: definition.aiPolicy,
    audiencePolicy: validateAudiencePolicy(definition.audiencePolicy),
    keywords,
    enabled: definition.enabled !== false,
    schema: { ...definition.schema, version: definition.schema.version, fields },
  };
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
