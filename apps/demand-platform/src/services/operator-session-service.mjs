import crypto from "node:crypto";
import { AppError } from "../domain/errors.mjs";
import { normalizeOperatorRoles, permissionsForRoles, requireOperatorPermission } from "../domain/operator-signature.mjs";

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

function normalizeOperator(operator) {
  const operatorId = String(operator?.operatorId ?? "").trim();
  const name = String(operator?.name ?? "").trim();
  if (!operatorId || operatorId.length > 128 || !name || name.length > 200) throw new AppError("INVALID_OPERATOR_CONTEXT", "运营人员身份无效", 401);
  const roles = normalizeOperatorRoles(operator.roles);
  return { operatorId, name, roles, permissions: permissionsForRoles(roles) };
}

export class OperatorSessionService {
  constructor({ db, ttlSeconds = 1800, maxSessionsPerOperator = 5, cookieSecure = false, cookieName, now = () => Date.now() }) {
    this.db = db;
    this.ttlSeconds = ttlSeconds;
    this.maxSessionsPerOperator = maxSessionsPerOperator;
    this.cookieSecure = cookieSecure;
    this.cookieName = cookieName ?? (cookieSecure ? "__Host-ai_demand_operator" : "ai_demand_operator");
    this.now = now;
  }

  create(input) {
    const operator = normalizeOperator(input);
    const currentTime = new Date(this.now()).toISOString();
    this.db.prepare("DELETE FROM operator_sessions WHERE expires_at <= ?").run(currentTime);
    const active = this.db.prepare(`
      SELECT session_id_hash FROM operator_sessions
      WHERE operator_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC, rowid DESC
    `).all(operator.operatorId, currentTime);
    for (const row of active.slice(Math.max(0, this.maxSessionsPerOperator - 1))) {
      this.db.prepare("UPDATE operator_sessions SET revoked_at = ? WHERE session_id_hash = ?").run(currentTime, row.session_id_hash);
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const csrfToken = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.now() + this.ttlSeconds * 1000).toISOString();
    const sessionHash = digest(token);
    this.db.prepare(`
      INSERT INTO operator_sessions
      (session_id_hash, operator_id, operator_name, roles_json, csrf_token, created_at, expires_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(sessionHash, operator.operatorId, operator.name, JSON.stringify(operator.roles), csrfToken, currentTime, expiresAt);
    return { operator, token, csrfToken, expiresAt, sessionHash, setCookie: this.cookie(token) };
  }

  tokenFromRequest(req) {
    return parseCookies(req?.headers?.cookie).get(this.cookieName) ?? null;
  }

  authenticate(req, { requireCsrf = false } = {}) {
    const token = this.tokenFromRequest(req);
    if (!token) return null;
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) throw new AppError("INVALID_OPERATOR_SESSION", "运营会话凭据无效", 401);
    const sessionHash = digest(token);
    const row = this.db.prepare("SELECT * FROM operator_sessions WHERE session_id_hash = ?").get(sessionHash);
    if (!row || row.revoked_at) throw new AppError("INVALID_OPERATOR_SESSION", "运营会话不存在或已退出", 401);
    if (new Date(row.expires_at).getTime() <= this.now()) throw new AppError("OPERATOR_SESSION_EXPIRED", "运营会话已过期，请重新登录", 401);
    if (requireCsrf) {
      const csrf = String(req.headers["x-csrf-token"] ?? "");
      if (!csrf) throw new AppError("CSRF_REQUIRED", "写操作缺少CSRF令牌", 403);
      if (!secureEqual(csrf, row.csrf_token)) throw new AppError("INVALID_CSRF", "CSRF令牌无效", 403);
    }
    const roles = normalizeOperatorRoles(JSON.parse(row.roles_json));
    return {
      sessionHash,
      operatorId: row.operator_id,
      name: row.operator_name,
      roles,
      permissions: permissionsForRoles(roles),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      csrfToken: row.csrf_token,
    };
  }

  authorize(req, permission, { requireCsrf = false } = {}) {
    const session = this.authenticate(req, { requireCsrf });
    if (!session) return null;
    return requireOperatorPermission(session, permission);
  }

  revoke(session) {
    this.db.prepare("UPDATE operator_sessions SET revoked_at = ? WHERE session_id_hash = ? AND revoked_at IS NULL")
      .run(new Date(this.now()).toISOString(), session.sessionHash);
  }

  cookie(token) {
    return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${this.ttlSeconds}${this.cookieSecure ? "; Secure" : ""}`;
  }

  clearCookie() {
    return `${this.cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.cookieSecure ? "; Secure" : ""}`;
  }
}
