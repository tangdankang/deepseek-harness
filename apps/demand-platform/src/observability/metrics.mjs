const DURATION_BUCKETS = Object.freeze([0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]);
const CASE_STATUSES = Object.freeze(["DRAFT", "WAITING_INFORMATION", "WAITING_CONFIRMATION", "SUBMITTING", "SUBMITTED", "IN_PROGRESS", "WAITING_USER", "RESOLVED", "CLOSED", "REJECTED", "SUBMIT_FAILED", "CANCELLED"]);
const HANDOFF_STATUSES = Object.freeze(["OPEN", "ASSIGNED", "RESOLVED", "CLOSED"]);
const INTEGRATION_STATUSES = Object.freeze(["PENDING", "RUNNING", "RETRY_WAIT", "SUCCEEDED", "DEAD"]);

const EXACT_ROUTES = new Map([
  ["/health", "health_ready"],
  ["/health/ready", "health_ready"],
  ["/health/live", "health_live"],
  ["/internal/metrics", "internal_metrics"],
  ["/", "employee_portal"],
  ["/admin", "operator_portal"],
  ["/admin/", "operator_portal"],
  ...[
    "/api/v1/admin/audit-events", "/api/v1/admin/audit-integrity", "/api/v1/admin/auth-sessions",
    "/api/v1/admin/auth-sessions/revoke", "/api/v1/admin/cases", "/api/v1/admin/external-tickets/reconcile",
    "/api/v1/admin/handoffs", "/api/v1/admin/integration-tasks", "/api/v1/admin/integration-tasks/run",
    "/api/v1/admin/metrics", "/api/v1/admin/overview", "/api/v1/admin/tool-invocations", "/api/v1/admin/identity-states",
    "/api/v1/assistant/messages", "/api/v1/auth/logout", "/api/v1/auth/me", "/api/v1/auth/session",
    "/api/v1/cases", "/api/v1/cases/drafts", "/api/v1/feedback", "/api/v1/guided-intake/turn", "/api/v1/handoffs",
    "/api/v1/operator/auth/logout", "/api/v1/operator/auth/me", "/api/v1/operator/auth/session", "/api/v1/services", "/api/v1/webhooks/identity/events",
    "/api/v1/tools/search-service-catalog", "/api/v1/tools/get-service-form-schema", "/api/v1/tools/get-employee-context",
    "/api/v1/tools/search-knowledge", "/api/v1/tools/validate-request-draft", "/api/v1/tools/create-or-update-draft",
    "/api/v1/tools/prepare-confirmation", "/api/v1/tools/submit-request", "/api/v1/tools/get-request-status",
    "/api/v1/tools/handoff-to-human", "/api/v1/tools/get-handoff-status", "/api/v1/tools/record-feedback", "/api/v1/tools/guided-request-turn",
  ].map((pathname) => [pathname, pathname.slice(1).replaceAll("/", "_").replaceAll("-", "_")]),
]);

function routeLabel(pathname) {
  if (EXACT_ROUTES.has(pathname)) return EXACT_ROUTES.get(pathname);
  if (/^\/api\/v1\/services\/[^/]+\/schema$/.test(pathname)) return "api_v1_services_code_schema";
  if (/^\/api\/v1\/handoffs\/HOF-\d{8}-\d{6}$/.test(pathname)) return "api_v1_handoffs_number";
  if (/^\/api\/v1\/cases\/REQ-\d{8}-\d{6}$/.test(pathname)) return "api_v1_cases_number";
  if (/^\/api\/v1\/cases\/REQ-\d{8}-\d{6}\/draft$/.test(pathname)) return "api_v1_cases_number_draft";
  if (/^\/api\/v1\/cases\/REQ-\d{8}-\d{6}\/prepare-confirmation$/.test(pathname)) return "api_v1_cases_number_prepare_confirmation";
  if (/^\/api\/v1\/cases\/REQ-\d{8}-\d{6}\/submit$/.test(pathname)) return "api_v1_cases_number_submit";
  if (/^\/api\/v1\/admin\/handoffs\/HOF-\d{8}-\d{6}$/.test(pathname)) return "api_v1_admin_handoffs_number";
  if (/^\/api\/v1\/admin\/integration-tasks\/[0-9a-f-]{36}\/retry$/i.test(pathname)) return "api_v1_admin_integration_tasks_id_retry";
  if (/^\/api\/v1\/webhooks\/[A-Za-z0-9_-]+\/status$/.test(pathname)) return "api_v1_webhooks_system_status";
  if (pathname.startsWith("/static/") || /\.(?:css|js|svg|png|ico)$/.test(pathname)) return "static_asset";
  return "other";
}

function methodLabel(method) {
  const normalized = String(method ?? "OTHER").toUpperCase();
  return ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(normalized) ? normalized : "OTHER";
}

function escapeLabel(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function labels(values) {
  const entries = Object.entries(values);
  return entries.length ? `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}` : "";
}

function metric(lines, name, value, metricLabels = {}) {
  lines.push(`${name}${labels(metricLabels)} ${Number.isFinite(Number(value)) ? Number(value) : 0}`);
}

function groupedCounts(db, table, allowed) {
  const result = Object.fromEntries(allowed.map((status) => [status, 0]));
  for (const row of db.prepare(`SELECT status, COUNT(*) AS count FROM ${table} GROUP BY status`).all()) {
    if (Object.hasOwn(result, row.status)) result[row.status] = Number(row.count);
  }
  return result;
}

export class MetricsService {
  constructor({ db, rateLimiter, applicationVersion, connectorSystems = [], auditStartupValid = false, now = () => Date.now() }) {
    this.db = db;
    this.rateLimiter = rateLimiter;
    this.applicationVersion = String(applicationVersion);
    this.connectorSystems = [...new Set(connectorSystems.map((value) => String(value).toUpperCase()))].sort().slice(0, 50);
    this.auditStartupValid = Boolean(auditStartupValid);
    this.now = now;
    this.startedAtMs = Number(now());
    this.httpCounters = new Map();
    this.httpDurations = new Map();
  }

  beginRequest(method, pathname) {
    return { method: methodLabel(method), route: routeLabel(pathname), startedAtNs: process.hrtime.bigint() };
  }

  completeRequest(observation, statusCode) {
    if (!observation) return;
    const duration = Math.max(0, Number(process.hrtime.bigint() - observation.startedAtNs) / 1e9);
    const statusClass = Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? `${Math.floor(statusCode / 100)}xx` : "unknown";
    const counterKey = `${observation.method}\0${observation.route}\0${statusClass}`;
    this.httpCounters.set(counterKey, (this.httpCounters.get(counterKey) ?? 0) + 1);
    const durationKey = `${observation.method}\0${observation.route}`;
    const histogram = this.httpDurations.get(durationKey) ?? { buckets: DURATION_BUCKETS.map(() => 0), count: 0, sum: 0 };
    for (let index = 0; index < DURATION_BUCKETS.length; index += 1) if (duration <= DURATION_BUCKETS[index]) histogram.buckets[index] += 1;
    histogram.count += 1;
    histogram.sum += duration;
    this.httpDurations.set(durationKey, histogram);
  }

  render() {
    const lines = [
      "# HELP ai_demand_build_info Application build information.",
      "# TYPE ai_demand_build_info gauge",
    ];
    metric(lines, "ai_demand_build_info", 1, { version: this.applicationVersion });
    lines.push("# HELP ai_demand_process_uptime_seconds Process uptime since this instance started.", "# TYPE ai_demand_process_uptime_seconds gauge");
    metric(lines, "ai_demand_process_uptime_seconds", Math.max(0, (Number(this.now()) - this.startedAtMs) / 1000));

    lines.push("# HELP ai_demand_http_requests_total HTTP requests by bounded route, method and status class.", "# TYPE ai_demand_http_requests_total counter");
    for (const [key, value] of [...this.httpCounters.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const [method, route, statusClass] = key.split("\0");
      metric(lines, "ai_demand_http_requests_total", value, { method, route, status_class: statusClass });
    }
    lines.push("# HELP ai_demand_http_request_duration_seconds HTTP request duration by bounded route and method.", "# TYPE ai_demand_http_request_duration_seconds histogram");
    for (const [key, histogram] of [...this.httpDurations.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const [method, route] = key.split("\0");
      for (let index = 0; index < DURATION_BUCKETS.length; index += 1) {
        metric(lines, "ai_demand_http_request_duration_seconds_bucket", histogram.buckets[index], { method, route, le: DURATION_BUCKETS[index] });
      }
      metric(lines, "ai_demand_http_request_duration_seconds_bucket", histogram.count, { method, route, le: "+Inf" });
      metric(lines, "ai_demand_http_request_duration_seconds_sum", histogram.sum, { method, route });
      metric(lines, "ai_demand_http_request_duration_seconds_count", histogram.count, { method, route });
    }

    lines.push("# HELP ai_demand_cases Current demand cases by status.", "# TYPE ai_demand_cases gauge");
    for (const [status, count] of Object.entries(groupedCounts(this.db, "demand_cases", CASE_STATUSES))) metric(lines, "ai_demand_cases", count, { status });
    lines.push("# HELP ai_demand_handoffs Current human handoffs by status.", "# TYPE ai_demand_handoffs gauge");
    for (const [status, count] of Object.entries(groupedCounts(this.db, "handoff_items", HANDOFF_STATUSES))) metric(lines, "ai_demand_handoffs", count, { status });
    lines.push("# HELP ai_demand_integration_tasks Current integration tasks by status.", "# TYPE ai_demand_integration_tasks gauge");
    for (const [status, count] of Object.entries(groupedCounts(this.db, "integration_tasks", INTEGRATION_STATUSES))) metric(lines, "ai_demand_integration_tasks", count, { status });

    const nowIso = new Date(Number(this.now())).toISOString();
    const pending = this.db.prepare("SELECT MIN(created_at) AS oldest FROM integration_tasks WHERE status IN ('PENDING', 'RUNNING', 'RETRY_WAIT')").get();
    const pendingAge = pending.oldest ? Math.max(0, (Number(this.now()) - Date.parse(pending.oldest)) / 1000) : 0;
    lines.push("# HELP ai_demand_oldest_pending_integration_age_seconds Age of oldest nonterminal integration task.", "# TYPE ai_demand_oldest_pending_integration_age_seconds gauge");
    metric(lines, "ai_demand_oldest_pending_integration_age_seconds", pendingAge);

    const scalar = (sql, ...parameters) => Number(this.db.prepare(sql).get(...parameters).count);
    lines.push("# HELP ai_demand_active_sessions Current non-revoked, non-expired sessions.", "# TYPE ai_demand_active_sessions gauge");
    metric(lines, "ai_demand_active_sessions", scalar("SELECT COUNT(*) AS count FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ?", nowIso), { actor: "employee" });
    metric(lines, "ai_demand_active_sessions", scalar("SELECT COUNT(*) AS count FROM operator_sessions WHERE revoked_at IS NULL AND expires_at > ?", nowIso), { actor: "operator" });
    lines.push("# HELP ai_demand_identity_states Employees governed by identity lifecycle status.", "# TYPE ai_demand_identity_states gauge");
    const identityStates = { ACTIVE: 0, BLOCKED: 0 };
    for (const row of this.db.prepare("SELECT access_status, COUNT(*) AS count FROM employee_identity_states GROUP BY access_status").all()) {
      if (Object.hasOwn(identityStates, row.access_status)) identityStates[row.access_status] = Number(row.count);
    }
    for (const [status, count] of Object.entries(identityStates)) metric(lines, "ai_demand_identity_states", count, { status });
    lines.push("# HELP ai_demand_knowledge_items Current governed knowledge availability.", "# TYPE ai_demand_knowledge_items gauge");
    metric(lines, "ai_demand_knowledge_items", scalar("SELECT COUNT(*) AS count FROM knowledge_items WHERE enabled = 1 AND (expires_at IS NULL OR expires_at > ?)", nowIso), { state: "active" });
    metric(lines, "ai_demand_knowledge_items", scalar("SELECT COUNT(*) AS count FROM knowledge_items WHERE enabled = 1 AND expires_at IS NOT NULL AND expires_at <= ?", nowIso), { state: "expired" });
    const organizationRequired = this.db.prepare("SELECT audience_policy_json FROM service_items WHERE enabled = 1").all().reduce((count, row) => {
      try { return count + (JSON.parse(row.audience_policy_json)?.includeDescendants === true ? 1 : 0); }
      catch { return count; }
    }, 0);
    const organization = this.db.prepare("SELECT version, expires_at FROM organization_snapshots ORDER BY version DESC LIMIT 1").get();
    const organizationState = !organization ? "missing" : Date.parse(organization.expires_at) > Number(this.now()) ? "fresh" : "stale";
    lines.push("# HELP ai_demand_organization_directory_required_services Services that require department-tree expansion.", "# TYPE ai_demand_organization_directory_required_services gauge");
    metric(lines, "ai_demand_organization_directory_required_services", organizationRequired);
    lines.push("# HELP ai_demand_organization_directory_available Organization directory state as a fixed one-hot gauge.", "# TYPE ai_demand_organization_directory_available gauge");
    for (const state of ["fresh", "stale", "missing"]) metric(lines, "ai_demand_organization_directory_available", organizationState === state ? 1 : 0, { state });
    lines.push("# HELP ai_demand_organization_directory_seconds_until_expiry Seconds until the current organization snapshot expires.", "# TYPE ai_demand_organization_directory_seconds_until_expiry gauge");
    metric(lines, "ai_demand_organization_directory_seconds_until_expiry", organization ? (Date.parse(organization.expires_at) - Number(this.now())) / 1000 : 0);
    lines.push("# HELP ai_demand_audit_failures_24h Audit failures recorded during the last 24 hours.", "# TYPE ai_demand_audit_failures_24h gauge");
    metric(lines, "ai_demand_audit_failures_24h", scalar("SELECT COUNT(*) AS count FROM audit_events WHERE outcome = 'FAILURE' AND created_at >= ?", new Date(Number(this.now()) - 86400000).toISOString()));
    lines.push("# HELP ai_demand_audit_chain_startup_valid Whether audit chain verification passed at process startup.", "# TYPE ai_demand_audit_chain_startup_valid gauge");
    metric(lines, "ai_demand_audit_chain_startup_valid", this.auditStartupValid ? 1 : 0);
    lines.push("# HELP ai_demand_rate_limit_active_subjects Current hashed subjects held by the in-memory limiter.", "# TYPE ai_demand_rate_limit_active_subjects gauge");
    metric(lines, "ai_demand_rate_limit_active_subjects", this.rateLimiter.status().activeSubjects);
    lines.push("# HELP ai_demand_rate_limit_rejections_total Requests rejected by platform rate limiting.", "# TYPE ai_demand_rate_limit_rejections_total counter");
    for (const item of this.rateLimiter.rejectionCounts()) metric(lines, "ai_demand_rate_limit_rejections_total", item.count, { scope: item.scope, overloaded: item.overloaded });
    lines.push("# HELP ai_demand_connector_configured Connector systems configured in this instance.", "# TYPE ai_demand_connector_configured gauge");
    for (const system of this.connectorSystems) metric(lines, "ai_demand_connector_configured", 1, { system });
    return `${lines.join("\n")}\n# EOF\n`;
  }

  clear() {
    this.httpCounters.clear();
    this.httpDurations.clear();
  }
}

export const metricsInternals = Object.freeze({ routeLabel, methodLabel, DURATION_BUCKETS });
