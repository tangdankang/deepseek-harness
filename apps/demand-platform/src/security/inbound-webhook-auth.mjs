import { AppError } from "../domain/errors.mjs";

const SYSTEM = /^[A-Z][A-Z0-9_-]{1,31}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,127}$/;

function strong(value) {
  return typeof value === "string" && value.length >= 32 && !value.startsWith("dev-only") && !value.startsWith("replace-with");
}

export function resolveInboundWebhookSecrets({ systemCodes, productionMode, fallbackSecret, secretEnvBySystem = {}, env = {}, injectedSecrets, reservedSecrets = [] }) {
  const systems = [...new Set((systemCodes ?? []).map((value) => String(value).trim().toUpperCase()))].sort();
  if (!systems.length || systems.some((value) => !SYSTEM.test(value))) throw new AppError("INVALID_WEBHOOK_CONFIGURATION", "入站Webhook系统编码无效", 500);
  const injected = injectedSecrets && typeof injectedSecrets === "object" && !Array.isArray(injectedSecrets) ? injectedSecrets : {};
  const mapping = secretEnvBySystem && typeof secretEnvBySystem === "object" && !Array.isArray(secretEnvBySystem) ? secretEnvBySystem : {};
  const result = new Map();
  for (const system of systems) {
    const direct = injected[system] ?? injected[system.toLowerCase()];
    const envName = mapping[system] ?? mapping[system.toLowerCase()];
    if (envName !== undefined && (typeof envName !== "string" || !ENV_NAME.test(envName))) {
      throw new AppError("INVALID_WEBHOOK_CONFIGURATION", `系统${system}的Webhook密钥环境变量名无效`, 500);
    }
    const secret = direct ?? (envName ? env[envName] : undefined) ?? (!productionMode ? fallbackSecret : undefined);
    if (productionMode && !strong(secret)) throw new AppError("INSECURE_PRODUCTION_CONFIGURATION", `系统${system}必须配置独立的强入站Webhook密钥`, 500, { systemCode: system });
    if (typeof secret !== "string" || !secret) throw new AppError("INVALID_WEBHOOK_CONFIGURATION", `系统${system}缺少入站Webhook密钥`, 500, { systemCode: system });
    result.set(system, secret);
  }
  if (productionMode) {
    const values = [...result.values()];
    if (new Set(values).size !== values.length) throw new AppError("INSECURE_PRODUCTION_CONFIGURATION", "不同业务系统不得复用入站Webhook密钥", 500);
    const reserved = new Set(reservedSecrets.filter((value) => typeof value === "string" && value));
    if (values.some((value) => reserved.has(value))) throw new AppError("INSECURE_PRODUCTION_CONFIGURATION", "入站Webhook密钥不得与平台其他用途密钥复用", 500);
  }
  return result;
}
