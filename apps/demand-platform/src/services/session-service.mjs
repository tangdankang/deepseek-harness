import crypto from "node:crypto";
import { AppError } from "../domain/errors.mjs";
import { normalizeDepartmentMemberships } from "../domain/employee-identity.mjs";

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("base64url");
}

function secureEqual(actual, expected) {
  const left = Buffer.from(String(actual));
  const right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseCookies(header) {
  const result = new Map();
  for (const part of String(header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name && !result.has(name)) result.set(name, value);
  }
  return result;
}

function validateEmployee(employee) {
  for (const [name, value, maximum] of [
    ["employeeId", employee?.employeeId, 128],
    ["departmentId", employee?.departmentId, 128],
    ["name", employee?.name, 200],
  ]) {
    if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new AppError("INVALID_IDENTITY_CONTEXT", `${name}格式无效`, 400);
  }
  const departmentIds = normalizeDepartmentMemberships(employee.departmentId, employee.departmentIds);
  return { employeeId: employee.employeeId.trim(), departmentId: employee.departmentId.trim(), departmentIds, name: employee.name.trim() };
}

export class SessionService {
  constructor({ db, ttlSeconds = 3600, maxSessionsPerEmployee = 10, cookieSecure = false, cookieName, now = () => Date.now() }) {
    this.db = db;
    this.ttlSeconds = ttlSeconds;
    this.maxSessionsPerEmployee = maxSessionsPerEmployee;
    this.cookieSecure = cookieSecure;
    this.cookieName = cookieName ?? (cookieSecure ? "__Host-ai_demand_session" : "ai_demand_session");
    this.now = now;
  }

  create(employee) {
    const normalizedEmployee = validateEmployee(employee);
    const currentTime = new Date(this.now()).toISOString();
    this.db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(currentTime);
    const active = this.db.prepare(`
      SELECT session_id_hash FROM auth_sessions
      WHERE employee_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC, rowid DESC
    `).all(normalizedEmployee.employeeId, currentTime);
    const revokeAt = new Date(this.now()).toISOString();
    for (const row of active.slice(Math.max(0, this.maxSessionsPerEmployee - 1))) {
      this.db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE session_id_hash = ?").run(revokeAt, row.session_id_hash);
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const csrfToken = crypto.randomBytes(32).toString("base64url");
    const createdAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(this.now() + this.ttlSeconds * 1000).toISOString();
    const sessionHash = digest(token);
    this.db.prepare(`
      INSERT INTO auth_sessions
      (session_id_hash, employee_id, department_id, department_ids_json, employee_name, csrf_token, created_at, expires_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(sessionHash, normalizedEmployee.employeeId, normalizedEmployee.departmentId, JSON.stringify(normalizedEmployee.departmentIds), normalizedEmployee.name, csrfToken, createdAt, expiresAt);
    return {
      employee: normalizedEmployee,
      token,
      csrfToken,
      expiresAt,
      sessionHash,
      setCookie: this.cookie(token),
    };
  }

  tokenFromRequest(req) {
    return parseCookies(req?.headers?.cookie).get(this.cookieName) ?? null;
  }

  authenticate(req, { requireCsrf = false } = {}) {
    const token = this.tokenFromRequest(req);
    if (!token) return null;
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) throw new AppError("INVALID_SESSION", "会话凭据无效", 401);
    const sessionHash = digest(token);
    const row = this.db.prepare("SELECT * FROM auth_sessions WHERE session_id_hash = ?").get(sessionHash);
    if (!row || row.revoked_at) throw new AppError("INVALID_SESSION", "会话不存在或已退出", 401);
    if (new Date(row.expires_at).getTime() <= this.now()) throw new AppError("SESSION_EXPIRED", "会话已过期，请重新登录", 401);
    if (requireCsrf) {
      const csrf = String(req.headers["x-csrf-token"] ?? "");
      if (!csrf) throw new AppError("CSRF_REQUIRED", "写操作缺少CSRF令牌", 403);
      if (!secureEqual(csrf, row.csrf_token)) throw new AppError("INVALID_CSRF", "CSRF令牌无效", 403);
    }
    let storedMemberships;
    try {
      const parsed = JSON.parse(row.department_ids_json ?? "[]");
      storedMemberships = Array.isArray(parsed) && parsed.length ? parsed : undefined;
    } catch { storedMemberships = undefined; }
    const departmentIds = normalizeDepartmentMemberships(row.department_id, storedMemberships, { code: "INVALID_SESSION", status: 401 });
    return {
      sessionHash,
      employee: { employeeId: row.employee_id, departmentId: row.department_id, departmentIds, name: row.employee_name },
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      csrfToken: row.csrf_token,
    };
  }

  revoke(session) {
    this.db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE session_id_hash = ? AND revoked_at IS NULL")
      .run(new Date(this.now()).toISOString(), session.sessionHash);
  }

  revokeEmployee(employeeId) {
    const normalized = String(employeeId ?? "").trim();
    if (!normalized || normalized.length > 128) throw new AppError("INVALID_EMPLOYEE_ID", "员工编号无效", 400);
    const currentTime = new Date(this.now()).toISOString();
    const result = this.db.prepare(`
      UPDATE auth_sessions SET revoked_at = ?
      WHERE employee_id = ? AND revoked_at IS NULL AND expires_at > ?
    `).run(currentTime, normalized, currentTime);
    return { employeeId: normalized, revokedSessions: Number(result.changes) };
  }

  listActive({ employeeId, limit = 100 } = {}) {
    const normalizedLimit = Math.max(1, Math.min(200, Number(limit) || 100));
    const currentTime = new Date(this.now()).toISOString();
    const normalizedEmployeeId = employeeId === undefined ? null : String(employeeId).trim();
    if (normalizedEmployeeId !== null && (!normalizedEmployeeId || normalizedEmployeeId.length > 128)) throw new AppError("INVALID_EMPLOYEE_ID", "员工编号无效", 400);
    const rows = normalizedEmployeeId
      ? this.db.prepare(`
          SELECT employee_id, department_id, department_ids_json, employee_name, COUNT(*) AS active_sessions,
            MIN(created_at) AS first_created_at, MAX(created_at) AS latest_created_at, MAX(expires_at) AS latest_expires_at
          FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ? AND employee_id = ?
          GROUP BY employee_id, department_id, department_ids_json, employee_name ORDER BY latest_created_at DESC LIMIT ?
        `).all(currentTime, normalizedEmployeeId, normalizedLimit)
      : this.db.prepare(`
          SELECT employee_id, department_id, department_ids_json, employee_name, COUNT(*) AS active_sessions,
            MIN(created_at) AS first_created_at, MAX(created_at) AS latest_created_at, MAX(expires_at) AS latest_expires_at
          FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ?
          GROUP BY employee_id, department_id, department_ids_json, employee_name ORDER BY latest_created_at DESC LIMIT ?
        `).all(currentTime, normalizedLimit);
    return rows.map((row) => ({
      employeeId: row.employee_id,
      departmentId: row.department_id,
      departmentIds: (() => { try { const value = JSON.parse(row.department_ids_json ?? "[]"); return Array.isArray(value) && value.length ? value : [row.department_id]; } catch { return [row.department_id]; } })(),
      name: row.employee_name,
      activeSessions: Number(row.active_sessions),
      firstCreatedAt: row.first_created_at,
      latestCreatedAt: row.latest_created_at,
      latestExpiresAt: row.latest_expires_at,
    }));
  }

  cookie(token) {
    return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${this.ttlSeconds}${this.cookieSecure ? "; Secure" : ""}`;
  }

  clearCookie() {
    return `${this.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.cookieSecure ? "; Secure" : ""}`;
  }
}
