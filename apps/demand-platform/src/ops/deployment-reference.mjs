import fs from "node:fs";
import path from "node:path";

function requirePattern(content, pattern, message, findings) {
  if (!pattern.test(content)) findings.push(message);
}

export function validateDeploymentReference({ projectRoot }) {
  const root = path.resolve(projectRoot);
  const containerPath = path.join(root, "Containerfile");
  const composePath = path.join(root, "deploy", "compose.pilot.example.yml");
  const envPath = path.join(root, "deploy", ".env.production.example");
  const connectorExamplePath = path.join(root, "deploy", "connectors.production.example.json");
  const alertRulesPath = path.join(root, "deploy", "prometheus-alerts.example.yml");
  const dockerIgnorePath = path.join(root, ".dockerignore");
  const findings = [];

  for (const file of [containerPath, composePath, envPath, connectorExamplePath, alertRulesPath, dockerIgnorePath]) {
    if (!fs.existsSync(file)) findings.push(`缺少部署参考文件：${path.relative(root, file)}`);
  }
  if (findings.length > 0) return { valid: false, checks: 0, findings };

  const container = fs.readFileSync(containerPath, "utf8");
  const compose = fs.readFileSync(composePath, "utf8");
  const env = fs.readFileSync(envPath, "utf8");
  const connectorExample = fs.readFileSync(connectorExamplePath, "utf8");
  const alertRules = fs.readFileSync(alertRulesPath, "utf8");
  const dockerIgnore = fs.readFileSync(dockerIgnorePath, "utf8");
  const checks = [
    [container, /^FROM \$\{NODE_IMAGE\}$/m, "Containerfile 未通过构建参数选择基础镜像"],
    [container, /^USER node$/m, "Containerfile 未使用非 root 用户"],
    [container, /^HEALTHCHECK .*scripts\/healthcheck\.mjs.*$/m, "Containerfile 缺少就绪健康检查"],
    [container, /^CMD \["node", "src\/server\.mjs"\]$/m, "Containerfile 启动命令不符合预期"],
    [compose, /^services:\s*$/m, "Compose 缺少 services"],
    [compose, /^  api:\s*$/m, "Compose 缺少 API 服务"],
    [compose, /^  worker:\s*$/m, "Compose 缺少 Outbox 工作进程"],
    [compose, /127\.0\.0\.1:8787:8787/, "试点 API 端口未限制在本机回环地址"],
    [compose, /^  read_only: true$/m, "容器根文件系统未配置只读"],
    [compose, /^  cap_drop:\s*[\s\S]*?^    - ALL$/m, "容器未移除 Linux capabilities"],
    [compose, /no-new-privileges:true/, "容器未禁止获取新权限"],
    [compose, /run-integration-worker\.mjs.*--watch.*--interval-ms/, "工作进程未配置持续轮询"],
    [compose, /^volumes:\s*[\s\S]*?^  demand-data:\s*$/m, "Compose 缺少本地持久卷定义"],
    [compose, /connectors\.production\.json:\/run\/config\/connectors\.json:ro/, "Compose 未只读挂载连接器配置"],
    [env, /^CONNECTOR_CONFIG_PATH=\/run\/config\/connectors\.json$/m, "生产环境模板缺少连接器配置路径"],
    [env, /^INBOUND_WEBHOOK_SECRET_ENVS=\{.+\}$/m, "生产环境模板缺少按系统入站Webhook密钥映射"],
    [env, /^BUSINESS_WEBHOOK_MAX_AGE_SECONDS=\d+$/m, "生产环境模板缺少业务Webhook接收时效"],
    [env, /^RUNTIME_PROFILE=PILOT_SINGLE_NODE_SQLITE$/m, "单机试点模板必须显式声明SQLite运行档位"],
    [env, /^SESSION_TTL_SECONDS=\d+$/m, "生产环境模板缺少会话有效期"],
    [env, /^SESSION_MAX_PER_EMPLOYEE=\d+$/m, "生产环境模板缺少单员工会话上限"],
    [env, /^SESSION_COOKIE_SECURE=true$/m, "生产环境会话Cookie未强制Secure"],
    [env, /^IDENTITY_EXCHANGE_MODE=both$/m, "生产环境模板未同时启用请求头和一次性票据交换"],
    [env, /^IDENTITY_EXCHANGE_ISSUER=[A-Za-z0-9._:/-]+$/m, "生产环境模板缺少身份票据签发方"],
    [env, /^IDENTITY_EXCHANGE_AUDIENCE=[A-Za-z0-9._:/-]+$/m, "生产环境模板缺少身份票据受众"],
    [env, /^IDENTITY_EXCHANGE_TTL_SECONDS=\d+$/m, "生产环境模板缺少身份票据有效期"],
    [env, /^IDENTITY_EVENT_SOURCE=[A-Za-z0-9._:/-]+$/m, "生产环境模板缺少身份事件可信来源"],
    [env, /^IDENTITY_EVENT_MAX_AGE_SECONDS=\d+$/m, "生产环境模板缺少身份事件接收时效"],
    [env, /^OPERATOR_IDENTITY_TTL_SECONDS=\d+$/m, "生产环境模板缺少运营身份签名有效期"],
    [env, /^OPERATOR_SESSION_TTL_SECONDS=\d+$/m, "生产环境模板缺少运营会话有效期"],
    [env, /^OPERATOR_SESSION_MAX_PER_OPERATOR=\d+$/m, "生产环境模板缺少单运营人员会话上限"],
    [env, /^OPERATOR_BOOTSTRAP_ENABLED=false$/m, "生产环境不得启用运营Admin Key引导"],
    [env, /^TOOL_INVOCATION_RETENTION_DAYS=\d+$/m, "生产环境模板缺少工具调用记录保留期"],
    [env, /^RATE_LIMIT_ENABLED=true$/m, "生产环境不得关闭平台侧限流"],
    [env, /^RATE_LIMIT_WINDOW_SECONDS=\d+$/m, "生产环境模板缺少限流窗口"],
    [env, /^EMPLOYEE_RATE_LIMIT=\d+$/m, "生产环境模板缺少员工限流阈值"],
    [env, /^TOOL_RATE_LIMIT=\d+$/m, "生产环境模板缺少DEAP工具限流阈值"],
    [env, /^AUTH_RATE_LIMIT=\d+$/m, "生产环境模板缺少认证限流阈值"],
    [env, /^ADMIN_RATE_LIMIT=\d+$/m, "生产环境模板缺少运营接口限流阈值"],
    [env, /^WEBHOOK_RATE_LIMIT=\d+$/m, "生产环境模板缺少Webhook限流阈值"],
    [env, /^RATE_LIMIT_MAX_ENTRIES=\d+$/m, "生产环境模板缺少限流状态容量"],
    [env, /^AUDIT_CHAIN_KEY_VERSION=\d+$/m, "生产环境模板缺少审计链密钥版本"],
    [env, /^AUDIT_CHAIN_ALLOW_LEGACY_BACKFILL=false$/m, "生产环境不得长期允许旧审计记录自动锚定"],
    [alertRules, /alert:\s*AIDemandPlatformUnavailable/, "告警规则缺少平台不可用告警"],
    [alertRules, /ai_demand_http_requests_total\{status_class="5xx"\}/, "告警规则缺少5xx比例监控"],
    [alertRules, /ai_demand_http_request_duration_seconds_bucket/, "告警规则缺少延迟直方图监控"],
    [alertRules, /ai_demand_integration_tasks\{status="DEAD"\}/, "告警规则缺少集成死信监控"],
    [alertRules, /ai_demand_audit_chain_startup_valid/, "告警规则缺少审计链异常监控"],
    [alertRules, /ai_demand_rate_limit_rejections_total/, "告警规则缺少限流拒绝监控"],
    [alertRules, /AIDemandPlatformIdentityEventFailures/, "告警规则缺少身份事件失败监控"],
    [alertRules, /AIDemandPlatformOrganizationDirectoryUnavailable/, "告警规则缺少组织目录不可用监控"],
    [alertRules, /ai_demand_organization_directory_seconds_until_expiry/, "告警规则缺少组织目录到期监控"],
    [dockerIgnore, /^deploy\/\.env\.production$/m, "容器构建上下文未排除生产环境变量文件"],
    [dockerIgnore, /^deploy\/connectors\.production\.json$/m, "容器构建上下文未排除实际连接器配置"],
  ];

  for (const [content, pattern, message] of checks) requirePattern(content, pattern, message, findings);
  if (/image:\s*\S*:latest\b/.test(compose)) findings.push("Compose 不得使用 latest 镜像标签");

  const requiredSecrets = [
    "CONFIRMATION_SECRET",
    "MOCK_WEBHOOK_SECRET",
    "TOOL_API_KEY",
    "ADMIN_API_KEY",
    "METRICS_API_KEY",
    "IDENTITY_HMAC_SECRET",
    "IDENTITY_EVENT_SECRET",
    "OPERATOR_HMAC_SECRET",
    "IDENTITY_EXCHANGE_SECRET",
    "ANALYTICS_HASH_SECRET",
    "AUDIT_CHAIN_SECRET",
  ];
  for (const name of requiredSecrets) {
    requirePattern(env, new RegExp(`^${name}=.+$`, "m"), `生产环境模板缺少 ${name}`, findings);
  }
  let parsedConnectorExample;
  try { parsedConnectorExample = JSON.parse(connectorExample); }
  catch { findings.push("连接器生产示例不是有效JSON"); }
  if (parsedConnectorExample?.version !== 1 || !Array.isArray(parsedConnectorExample?.connectors) || parsedConnectorExample.connectors.length === 0) findings.push("连接器生产示例缺少version或connectors");

  return {
    valid: findings.length === 0,
    checks: checks.length + requiredSecrets.length + 2,
    findings,
    scope: "static-reference-invariants",
  };
}
