export class OperationsService {
  constructor({ db, connectors }) {
    this.db = db;
    this.connectors = connectors;
  }

  overview() {
    const now = new Date().toISOString();
    const scalar = (sql, ...parameters) => Number(this.db.prepare(sql).get(...parameters).count);
    const grouped = (table, column, where = "", ...parameters) => Object.fromEntries(
      this.db.prepare(`SELECT ${column} AS key, COUNT(*) AS count FROM ${table} ${where} GROUP BY ${column}`).all(...parameters)
        .map((row) => [row.key, Number(row.count)]),
    );
    return {
      generatedAt: now,
      demands: {
        total: scalar("SELECT COUNT(*) AS count FROM demand_cases"),
        byStatus: grouped("demand_cases", "status"),
      },
      handoffs: {
        total: scalar("SELECT COUNT(*) AS count FROM handoff_items"),
        byStatus: grouped("handoff_items", "status"),
      },
      integrations: {
        total: scalar("SELECT COUNT(*) AS count FROM integration_tasks"),
        byStatus: grouped("integration_tasks", "status"),
      },
      sessions: {
        activeEmployees: scalar("SELECT COUNT(DISTINCT employee_id) AS count FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ?", now),
        activeEmployeeSessions: scalar("SELECT COUNT(*) AS count FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ?", now),
        activeOperators: scalar("SELECT COUNT(DISTINCT operator_id) AS count FROM operator_sessions WHERE revoked_at IS NULL AND expires_at > ?", now),
      },
      audit: {
        failures24h: scalar("SELECT COUNT(*) AS count FROM audit_events WHERE outcome = 'FAILURE' AND created_at >= ?", new Date(Date.now() - 86400000).toISOString()),
      },
      connectors: this.connectors.listSystemCodes(),
    };
  }
}
