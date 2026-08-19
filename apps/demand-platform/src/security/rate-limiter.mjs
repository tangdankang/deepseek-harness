import crypto from "node:crypto";

export class FixedWindowRateLimiter {
  constructor({ secret, windowSeconds = 60, maxEntries = 50000, now = () => Date.now() }) {
    if (typeof secret !== "string" || secret.length < 16) throw new Error("限流摘要密钥长度不足");
    if (!Number.isInteger(windowSeconds) || windowSeconds < 1) throw new Error("限流窗口无效");
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("限流最大条目数无效");
    this.secret = secret;
    this.windowMs = windowSeconds * 1000;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
    this.operations = 0;
    this.capacityRejectionRecordedUntil = 0;
    this.rejections = new Map();
  }

  recordRejection(scope, overloaded) {
    const key = `${scope}\0${overloaded ? "true" : "false"}`;
    this.rejections.set(key, (this.rejections.get(key) ?? 0) + 1);
  }

  digest(scope, subject) {
    return crypto.createHmac("sha256", this.secret).update(`${scope}\0${subject}`).digest("hex").toUpperCase();
  }

  cleanup(nowMs) {
    for (const [key, entry] of this.entries) {
      if (entry.resetAtMs <= nowMs) this.entries.delete(key);
    }
  }

  consume({ scope, subject, limit }) {
    if (typeof scope !== "string" || !/^[a-z][a-z0-9_-]{1,30}$/.test(scope)) throw new Error("限流范围无效");
    if (typeof subject !== "string" || subject.length === 0 || subject.length > 500) throw new Error("限流主体无效");
    if (!Number.isInteger(limit) || limit < 1) throw new Error("限流阈值无效");
    const nowMs = Number(this.now());
    if (!Number.isFinite(nowMs)) throw new Error("限流时钟无效");
    this.operations += 1;
    if (this.operations % 1000 === 0) this.cleanup(nowMs);
    const subjectHash = this.digest(scope, subject);
    const key = `${scope}:${subjectHash}`;
    let entry = this.entries.get(key);
    if (entry && entry.resetAtMs <= nowMs) {
      this.entries.delete(key);
      entry = null;
    }
    if (!entry) {
      if (this.entries.size >= this.maxEntries) this.cleanup(nowMs);
      if (this.entries.size >= this.maxEntries) {
        this.recordRejection(scope, true);
        const firstRejected = nowMs >= this.capacityRejectionRecordedUntil;
        if (firstRejected) this.capacityRejectionRecordedUntil = nowMs + this.windowMs;
        return { allowed: false, overloaded: true, scope, subjectHash, limit, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(this.windowMs / 1000)), firstRejected };
      }
      const resetAtMs = Math.floor(nowMs / this.windowMs) * this.windowMs + this.windowMs;
      entry = { count: 0, resetAtMs, rejectionRecorded: false };
      this.entries.set(key, entry);
    }
    if (entry.count >= limit) {
      this.recordRejection(scope, false);
      const firstRejected = !entry.rejectionRecorded;
      entry.rejectionRecorded = true;
      return {
        allowed: false,
        overloaded: false,
        scope,
        subjectHash,
        limit,
        remaining: 0,
        resetAt: new Date(entry.resetAtMs).toISOString(),
        retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAtMs - nowMs) / 1000)),
        firstRejected,
      };
    }
    entry.count += 1;
    return {
      allowed: true,
      overloaded: false,
      scope,
      subjectHash,
      limit,
      remaining: Math.max(0, limit - entry.count),
      resetAt: new Date(entry.resetAtMs).toISOString(),
      retryAfterSeconds: 0,
      firstRejected: false,
    };
  }

  status() {
    const nowMs = Number(this.now());
    this.cleanup(nowMs);
    return { activeSubjects: this.entries.size, maxEntries: this.maxEntries, windowSeconds: this.windowMs / 1000 };
  }

  rejectionCounts() {
    return [...this.rejections.entries()].map(([key, count]) => {
      const [scope, overloaded] = key.split("\0");
      return { scope, overloaded: overloaded === "true", count };
    }).sort((a, b) => a.scope.localeCompare(b.scope) || Number(a.overloaded) - Number(b.overloaded));
  }

  clear() {
    this.entries.clear();
    this.capacityRejectionRecordedUntil = 0;
    this.rejections.clear();
  }
}
