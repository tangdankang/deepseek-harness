const DEFAULT_POLICY = Object.freeze({
  minPilotDays: 5,
  minInteractions: 100,
  minUniqueEmployees: 20,
  minFeedbackCount: 20,
  minFeedbackResponseRate: 0.2,
  minConfirmedResolutionRate: 0.3,
  minAverageRating: 4,
  minIntegrationTerminalSuccessRate: 0.98,
  maxDeadIntegrationTasks: 0,
  maxCriticalSecurityIncidents: 0,
  maxDuplicateDownstreamTickets: 0,
  minCriticalEvalPassRate: 1,
  minRoutingAccuracy: 0.9,
});

function rule(id, label, source, actual, comparator, target, missing = actual === undefined || actual === null) {
  if (missing) return { id, label, source, status: "MISSING", actual: null, target };
  const passed = comparator(actual, target);
  return { id, label, source, status: passed ? "PASS" : "FAIL", actual, target };
}

function boolRule(id, label, evidence) {
  return rule(id, label, "manual", evidence, (actual) => actual === true, true);
}

export function evaluatePilotGate(metrics, evidence = {}, policyOverrides = {}) {
  const policy = { ...DEFAULT_POLICY, ...policyOverrides };
  const integrationStatuses = metrics.integrations?.byStatus ?? {};
  const rules = [
    rule("PILOT_DAYS", "连续试点天数", "manual", evidence.pilotDays, (a, b) => a >= b, policy.minPilotDays),
    rule("INTERACTIONS", "有效交互样本", "automatic", metrics.interactions?.total, (a, b) => a >= b, policy.minInteractions),
    rule("UNIQUE_EMPLOYEES", "去标识试点员工数", "automatic", metrics.interactions?.uniqueEmployees, (a, b) => a >= b, policy.minUniqueEmployees),
    rule("FEEDBACK_COUNT", "员工反馈样本", "automatic", metrics.feedback?.total, (a, b) => a >= b, policy.minFeedbackCount),
    rule("FEEDBACK_RESPONSE_RATE", "反馈响应率", "automatic", metrics.indicators?.feedbackResponseRate, (a, b) => a >= b, policy.minFeedbackResponseRate),
    rule("CONFIRMED_RESOLUTION_RATE", "员工确认解决率", "automatic", metrics.indicators?.employeeConfirmedResolutionRate, (a, b) => a >= b, policy.minConfirmedResolutionRate),
    rule("AVERAGE_RATING", "平均满意度", "automatic", metrics.feedback?.averageRating, (a, b) => a >= b, policy.minAverageRating),
    rule("INTEGRATION_SUCCESS", "终态集成任务成功率", "automatic", metrics.indicators?.integrationTerminalSuccessRate, (a, b) => a >= b, policy.minIntegrationTerminalSuccessRate),
    rule("DEAD_TASKS", "死信任务数", "automatic", integrationStatuses.DEAD ?? 0, (a, b) => a <= b, policy.maxDeadIntegrationTasks),
    rule("SECURITY_INCIDENTS", "关键安全事件数", "manual", evidence.criticalSecurityIncidents, (a, b) => a <= b, policy.maxCriticalSecurityIncidents),
    rule("DUPLICATE_TICKETS", "已确认重复下游工单数", "manual", evidence.duplicateDownstreamTickets, (a, b) => a <= b, policy.maxDuplicateDownstreamTickets),
    rule("CRITICAL_EVALS", "关键评测通过率", "manual", evidence.criticalEvalPassRate, (a, b) => a >= b, policy.minCriticalEvalPassRate),
    rule("ROUTING_ACCURACY", "真实样本路由准确率", "manual", evidence.routingAccuracy, (a, b) => a >= b, policy.minRoutingAccuracy),
    boolRule("VISUAL_QA", "钉钉PC/移动端视觉与交互验收", evidence.visualQaPassed),
    boolRule("SYNTHETIC_PILOT", "多员工合成试点技术门禁", evidence.syntheticPilotPassed),
    boolRule("ROLLBACK_DRILL", "降级与回滚演练", evidence.rollbackDrillPassed),
    boolRule("BUSINESS_SIGNOFF", "业务放行", evidence.businessSignoff),
    boolRule("SECURITY_SIGNOFF", "安全放行", evidence.securitySignoff),
    boolRule("OPS_SIGNOFF", "运维放行", evidence.opsSignoff),
  ];
  const failed = rules.filter((item) => item.status === "FAIL");
  const missing = rules.filter((item) => item.status === "MISSING");
  const decision = failed.length > 0 ? "NO_GO" : missing.length > 0 ? "NOT_READY" : "GO";
  return {
    decision,
    evidenceClass: evidence.evidenceClass ?? null,
    policy,
    summary: { total: rules.length, passed: rules.filter((item) => item.status === "PASS").length, failed: failed.length, missing: missing.length },
    rules,
    generatedAt: new Date().toISOString(),
    warning: "GO仅表示当前证据满足本策略，不替代公司正式变更审批；任何已知P0/P1缺陷均应在外部证据中反映。",
  };
}

function display(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number" && value >= 0 && value <= 1) return `${(value * 100).toFixed(1)}%`;
  return String(value);
}

export function formatPilotGateReport(result) {
  const names = { GO: "GO（满足放行门槛）", NO_GO: "NO-GO（存在失败项）", NOT_READY: "NOT READY（证据不完整）" };
  return `# AI统一需求平台试点 Go / No-Go 门禁报告

结论：**${names[result.decision]}**

生成时间：${result.generatedAt}

| 检查项 | 来源 | 实际值 | 目标 | 结论 |
|---|---|---:|---:|---|
${result.rules.map((item) => `| ${item.label} | ${item.source === "automatic" ? "平台指标" : "人工证据"} | ${display(item.actual)} | ${display(item.target)} | ${item.status} |`).join("\n")}

汇总：通过 ${result.summary.passed}，失败 ${result.summary.failed}，缺证据 ${result.summary.missing}。

${result.warning}
`;
}

export { DEFAULT_POLICY };
