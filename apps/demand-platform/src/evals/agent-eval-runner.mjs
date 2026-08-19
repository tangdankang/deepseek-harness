import { AppError } from "../domain/errors.mjs";

const SEVERITIES = new Set(["normal", "high", "critical"]);
const AUTOMATED_KEYS = new Set(["type", "serviceCode", "mustContain", "mustNotContain", "citationRequired", "supported", "handoff", "handoffOrClarify"]);

function ensure(condition, message, details) {
  if (!condition) throw new AppError("INVALID_EVAL_SET", message, 422, details);
}

export function parseEvalJsonl(text) {
  const cases = [];
  for (const [index, line] of String(text).split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { cases.push(JSON.parse(line)); }
    catch (error) { throw new AppError("INVALID_EVAL_JSON", `评测集第${index + 1}行不是有效JSON`, 422, { line: index + 1, reason: error.message }); }
  }
  return validateEvalCases(cases);
}

export function validateEvalCases(cases) {
  ensure(Array.isArray(cases) && cases.length > 0, "评测集不能为空");
  const ids = new Set();
  for (const [index, item] of cases.entries()) {
    const path = `cases[${index}]`;
    ensure(item && typeof item === "object" && !Array.isArray(item), `${path}必须是对象`);
    for (const key of ["id", "category", "severity", "input", "expected"]) ensure(item[key] !== undefined, `${path}缺少${key}`, { path, key });
    ensure(typeof item.id === "string" && /^[A-Z][A-Z0-9_-]{2,63}$/.test(item.id), `${path}.id格式无效`, { id: item.id });
    ensure(!ids.has(item.id), `评测ID重复：${item.id}`, { id: item.id });
    ids.add(item.id);
    ensure(typeof item.category === "string" && item.category.length > 0, `${path}.category无效`);
    ensure(SEVERITIES.has(item.severity), `${path}.severity无效`, { severity: item.severity });
    ensure(typeof item.input === "string" && item.input.trim().length > 0, `${path}.input无效`);
    ensure(item.expected && typeof item.expected === "object" && !Array.isArray(item.expected) && Object.keys(item.expected).length > 0, `${path}.expected无效`);
    for (const key of ["mustContain", "mustNotContain"]) {
      if (item.expected[key] !== undefined) ensure(Array.isArray(item.expected[key]) && item.expected[key].every((value) => typeof value === "string"), `${path}.expected.${key}必须是文本数组`);
    }
    const overlap = (item.expected.mustContain ?? []).filter((value) => (item.expected.mustNotContain ?? []).includes(value));
    ensure(overlap.length === 0, `${path}的mustContain与mustNotContain冲突`, { overlap });
  }
  return cases;
}

function containsResponse(response, expectedText) {
  return JSON.stringify(response).includes(expectedText);
}

export function evaluateAgentResponse(testCase, response) {
  const checks = [];
  const expected = testCase.expected;
  if (expected.type !== undefined) checks.push({ name: "type", passed: response.type === expected.type, expected: expected.type, actual: response.type });
  if (expected.serviceCode !== undefined) {
    const codes = [response.serviceCode, ...(response.services ?? []).map((service) => service.serviceCode)].filter(Boolean);
    checks.push({ name: "serviceCode", passed: codes.includes(expected.serviceCode), expected: expected.serviceCode, actual: codes });
  }
  for (const text of expected.mustContain ?? []) checks.push({ name: `mustContain:${text}`, passed: containsResponse(response, text) });
  for (const text of expected.mustNotContain ?? []) checks.push({ name: `mustNotContain:${text}`, passed: !containsResponse(response, text) });
  if (expected.citationRequired === true) checks.push({ name: "citationRequired", passed: Array.isArray(response.citations) && response.citations.length > 0 });
  if (expected.supported === false) checks.push({ name: "unsupportedFallback", passed: response.type === "HANDOFF_SUGGESTED" });
  if (expected.handoff === true || expected.handoffOrClarify === true) checks.push({ name: "handoffOrClarify", passed: ["HANDOFF_SUGGESTED", "CLARIFICATION_REQUIRED"].includes(response.type) });

  const unsupportedExpectations = Object.keys(expected).filter((key) => !AUTOMATED_KEYS.has(key));
  const failed = checks.filter((check) => !check.passed);
  return {
    id: testCase.id,
    status: failed.length > 0 ? "FAIL" : unsupportedExpectations.length > 0 ? "PARTIAL" : "PASS",
    checks,
    unsupportedExpectations,
  };
}

export async function runAgentEvals(cases, { endpoint, headers = {}, includePreconditions = false } = {}) {
  ensure(typeof endpoint === "string" && endpoint.startsWith("http"), "必须提供有效endpoint");
  const results = [];
  for (const testCase of validateEvalCases(cases)) {
    if (testCase.preconditions && !includePreconditions) {
      results.push({ id: testCase.id, status: "SKIP", reason: "存在需预置的知识、身份或工具条件" });
      continue;
    }
    let response;
    try {
      const httpResponse = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ message: testCase.input, evalCaseId: testCase.id }),
      });
      response = await httpResponse.json();
      if (!httpResponse.ok) {
        results.push({ id: testCase.id, status: "ERROR", httpStatus: httpResponse.status, response });
        continue;
      }
    } catch (error) {
      results.push({ id: testCase.id, status: "ERROR", error: error.message });
      continue;
    }
    results.push({ ...evaluateAgentResponse(testCase, response), response });
  }
  const summary = results.reduce((counts, result) => {
    counts[result.status] = (counts[result.status] ?? 0) + 1;
    return counts;
  }, { total: results.length, PASS: 0, FAIL: 0, PARTIAL: 0, SKIP: 0, ERROR: 0 });
  return { summary, results };
}
