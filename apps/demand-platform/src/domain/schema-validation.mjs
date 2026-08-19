function isEmpty(value) {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

function validIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function validateFields(schema, fields = {}) {
  const missingFields = [];
  const fieldErrors = [];
  const definitions = schema?.fields ?? [];
  const allowed = new Set(definitions.map((field) => field.name));
  const normalizedFields = Object.fromEntries(Object.entries(fields).filter(([key]) => allowed.has(key)));

  for (const def of definitions) {
    const value = fields[def.name];
    if (def.required && isEmpty(value)) {
      missingFields.push({ name: def.name, label: def.label, help: def.help ?? "" });
      continue;
    }
    if (isEmpty(value)) continue;

    if (["string", "textarea"].includes(def.type)) {
      if (typeof value !== "string") {
        fieldErrors.push({ name: def.name, label: def.label, code: "TYPE", message: `${def.label}必须为文本` });
        continue;
      }
      normalizedFields[def.name] = value.trim();
      if (def.minLength && normalizedFields[def.name].length < def.minLength) {
        fieldErrors.push({ name: def.name, label: def.label, code: "MIN_LENGTH", message: `${def.label}至少需要${def.minLength}个字符` });
      }
      if (def.maxLength && normalizedFields[def.name].length > def.maxLength) {
        fieldErrors.push({ name: def.name, label: def.label, code: "MAX_LENGTH", message: `${def.label}不能超过${def.maxLength}个字符` });
      }
      if (def.pattern && !new RegExp(def.pattern).test(normalizedFields[def.name])) {
        fieldErrors.push({ name: def.name, label: def.label, code: "PATTERN", message: def.patternMessage ?? `${def.label}格式不正确` });
      }
    } else if (def.type === "date") {
      if (!validIsoDate(value)) fieldErrors.push({ name: def.name, label: def.label, code: "DATE", message: `${def.label}必须是 YYYY-MM-DD 格式的有效日期` });
    } else if (def.type === "enum") {
      if (!def.options?.some((option) => option.value === value)) {
        fieldErrors.push({ name: def.name, label: def.label, code: "ENUM", message: `${def.label}不是允许的选项` });
      }
    } else if (def.type === "boolean") {
      if (typeof value !== "boolean") fieldErrors.push({ name: def.name, label: def.label, code: "TYPE", message: `${def.label}必须为布尔值` });
    } else if (def.type === "array") {
      if (!Array.isArray(value)) fieldErrors.push({ name: def.name, label: def.label, code: "TYPE", message: `${def.label}必须为列表` });
    } else {
      fieldErrors.push({ name: def.name, label: def.label, code: "SCHEMA", message: `未知字段类型：${def.type}` });
    }
  }

  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) fieldErrors.push({ name: key, label: key, code: "UNKNOWN_FIELD", message: `字段 ${key} 未在当前服务Schema中定义` });
  }

  return { valid: missingFields.length === 0 && fieldErrors.length === 0, missingFields, fieldErrors, normalizedFields };
}
