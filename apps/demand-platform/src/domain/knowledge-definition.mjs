import { AppError } from "./errors.mjs";
import { stableJson } from "./service-definition.mjs";

const ID_PATTERN = /^[A-Z][A-Z0-9_-]{2,63}$/;
const SHA256_PATTERN = /^[A-F0-9]{64}$/;

function fail(message, details) {
  throw new AppError("INVALID_KNOWLEDGE_DEFINITION", message, 422, details);
}

function requiredText(value, path, maxLength) {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maxLength) {
    fail(`${path} 必须是1至${maxLength}个字符的文本`, { path });
  }
  return value.trim();
}

function isoInstant(value, path, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  const normalized = requiredText(value, path, 40);
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp) || !/^\d{4}-\d{2}-\d{2}T/.test(normalized)) fail(`${path} 必须是ISO 8601时间`, { path });
  return new Date(timestamp).toISOString();
}

function sourceUrl(value) {
  const normalized = requiredText(value, "source.url", 1000);
  let parsed;
  try { parsed = new URL(normalized); }
  catch { fail("source.url 必须是有效URL", { path: "source.url" }); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    fail("source.url 必须使用HTTPS且不得内嵌凭据", { path: "source.url" });
  }
  const sensitiveQuery = [...parsed.searchParams.keys()].find((key) => /token|secret|password|signature|api[_-]?key|access[_-]?key/i.test(key));
  if (sensitiveQuery) fail("source.url 查询参数包含疑似凭据字段", { path: "source.url", parameter: sensitiveQuery });
  return parsed.href;
}

function uniqueTexts(values, path, { maximum, itemMaximum, normalize = (value) => value } = {}) {
  if (!Array.isArray(values) || values.length === 0 || values.length > maximum) {
    fail(`${path} 必须包含1至${maximum}项`, { path });
  }
  const result = values.map((value, index) => normalize(requiredText(value, `${path}[${index}]`, itemMaximum)));
  if (new Set(result.map((value) => value.toLowerCase())).size !== result.length) fail(`${path} 不能重复`, { path });
  return result;
}

export function validateKnowledgeDefinition(definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) fail("知识定义必须是对象", { path: "$" });
  const knowledgeId = requiredText(definition.knowledgeId, "knowledgeId", 64).toUpperCase();
  if (!ID_PATTERN.test(knowledgeId)) fail("knowledgeId 必须是大写字母开头的大写编码", { path: "knowledgeId", value: knowledgeId });
  if (!Number.isInteger(definition.version) || definition.version < 1) fail("version 必须是正整数", { path: "version" });
  const patterns = uniqueTexts(definition.patterns, "patterns", { maximum: 100, itemMaximum: 200 });
  const allowedDepartments = uniqueTexts(definition.allowedDepartments, "allowedDepartments", {
    maximum: 100,
    itemMaximum: 100,
    normalize: (value) => value === "*" ? value : value.toUpperCase(),
  });
  if (allowedDepartments.includes("*") && allowedDepartments.length !== 1) {
    fail("allowedDepartments 使用 * 时不能同时配置其他部门", { path: "allowedDepartments" });
  }
  if (!definition.source || typeof definition.source !== "object" || Array.isArray(definition.source)) {
    fail("source 必须是对象", { path: "source" });
  }
  const contentSha256 = requiredText(definition.source.contentSha256, "source.contentSha256", 64).toUpperCase();
  if (!SHA256_PATTERN.test(contentSha256)) fail("source.contentSha256 必须是64位SHA-256", { path: "source.contentSha256" });
  const reviewedAt = isoInstant(definition.source.reviewedAt, "source.reviewedAt");
  const expiresAt = isoInstant(definition.expiresAt, "expiresAt", { nullable: true });
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(reviewedAt)) {
    fail("expiresAt 必须晚于 source.reviewedAt", { path: "expiresAt" });
  }
  return {
    knowledgeId,
    version: definition.version,
    title: requiredText(definition.title, "title", 200),
    patterns,
    answer: requiredText(definition.answer, "answer", 5000),
    ownerTeam: requiredText(definition.ownerTeam, "ownerTeam", 120),
    changeRef: requiredText(definition.changeRef, "changeRef", 120),
    source: {
      title: requiredText(definition.source.title, "source.title", 300),
      url: sourceUrl(definition.source.url),
      contentSha256,
      reviewedAt,
    },
    allowedDepartments,
    enabled: definition.enabled !== false,
    expiresAt,
  };
}

export function stableKnowledgeJson(value) {
  return stableJson(value);
}
