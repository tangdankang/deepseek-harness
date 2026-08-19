import crypto from "node:crypto";
import { AppError } from "./errors.mjs";

function encode(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sign(encoded, secret) {
  return crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
}

export function issueConfirmationToken({ globalRequestNo, draftVersion, employeeId, ttlSeconds, secret, now = Date.now() }) {
  const payload = {
    globalRequestNo,
    draftVersion,
    employeeId,
    issuedAt: Math.floor(now / 1000),
    expiresAt: Math.floor(now / 1000) + ttlSeconds,
    nonce: crypto.randomBytes(12).toString("base64url"),
  };
  const encoded = encode(payload);
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifyConfirmationToken(token, { secret, globalRequestNo, draftVersion, employeeId, now = Date.now() }) {
  if (typeof token !== "string" || !token.includes(".")) throw new AppError("INVALID_CONFIRMATION", "确认令牌无效", 400);
  const [encoded, signature] = token.split(".");
  const expected = sign(encoded, secret);
  const actualBuffer = Buffer.from(signature ?? "", "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new AppError("INVALID_CONFIRMATION", "确认令牌签名无效", 400);
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new AppError("INVALID_CONFIRMATION", "确认令牌内容无效", 400);
  }
  if (payload.expiresAt < Math.floor(now / 1000)) throw new AppError("CONFIRMATION_EXPIRED", "确认已过期，请重新检查预览", 409);
  if (payload.globalRequestNo !== globalRequestNo || payload.draftVersion !== draftVersion || payload.employeeId !== employeeId) {
    throw new AppError("CONFIRMATION_MISMATCH", "确认内容与当前需求版本或员工不匹配", 409);
  }
  return payload;
}

export function signWebhook(rawBody, secret) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyWebhookSignature(rawBody, signature, secret) {
  const expected = signWebhook(rawBody, secret);
  const actualBuffer = Buffer.from(signature ?? "", "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}
