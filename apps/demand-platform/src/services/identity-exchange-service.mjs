import crypto from "node:crypto";
import { AppError } from "../domain/errors.mjs";
import { verifyIdentityExchangeTicket } from "../domain/identity-exchange-ticket.mjs";

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("base64url");
}

export class IdentityExchangeService {
  constructor({ db, secret = "", issuer = "company-identity-gateway", audience = "ai-demand-platform", ttlSeconds = 90, enabled = false, now = () => Date.now() }) {
    this.db = db;
    this.secret = secret;
    this.issuer = issuer;
    this.audience = audience;
    this.ttlSeconds = ttlSeconds;
    this.enabled = enabled;
    this.now = now;
  }

  consume(ticket) {
    if (!this.enabled) throw new AppError("IDENTITY_EXCHANGE_DISABLED", "一次性身份交换未启用", 401);
    const verified = verifyIdentityExchangeTicket({
      ticket,
      issuer: this.issuer,
      audience: this.audience,
      secret: this.secret,
      maxTtlSeconds: this.ttlSeconds,
      now: this.now(),
    });
    const ticketIdHash = digest(verified.ticketId);
    const consumedAt = new Date(this.now()).toISOString();
    this.db.prepare("DELETE FROM identity_ticket_uses WHERE expires_at <= ?").run(consumedAt);
    try {
      this.db.prepare(`
        INSERT INTO identity_ticket_uses
        (ticket_id_hash, employee_id, issuer, audience, expires_at, consumed_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(ticketIdHash, verified.employee.employeeId, verified.issuer, verified.audience, verified.expiresAt, consumedAt);
    } catch (error) {
      if (String(error?.message ?? "").includes("UNIQUE constraint failed: identity_ticket_uses.ticket_id_hash")) {
        throw new AppError("IDENTITY_TICKET_REPLAYED", "身份交换票据已使用", 401);
      }
      throw error;
    }
    return { ...verified, ticketIdHash };
  }
}
