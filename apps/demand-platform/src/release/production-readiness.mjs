import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REQUIRED_EVIDENCE = Object.freeze({
  releaseVerification: { label: "发布包自动验证", maxAgeDays: 7, validator: validateReleaseVerification },
  runtimeTopology: { label: "生产高可用运行拓扑验收", maxAgeDays: 30, validator: validateRuntimeTopology },
  deapConformance: { label: "真实DEAP全写工具联调", maxAgeDays: 30, validator: validateDeapConformance },
  identityLifecycleConformance: { label: "真实身份生命周期事件联调", maxAgeDays: 30, validator: validateIdentityLifecycleConformance },
  connectorAcceptance: { label: "真实业务系统连接器验收", maxAgeDays: 30, validator: validateConnectorAcceptance },
  realEmployeePilot: { label: "真实员工试点Go/No-Go", maxAgeDays: 14, validator: validateRealPilot },
  remoteCapacity: { label: "等价环境远程容量验证", maxAgeDays: 30, validator: validateRemoteCapacity },
  securityAssessment: { label: "安全评估与高危缺陷关闭", maxAgeDays: 90, validator: validateManualAttestation },
  backupRestore: { label: "备份恢复演练", maxAgeDays: 30, validator: validateManualAttestation },
  disasterRecovery: { label: "灾备与故障切换演练", maxAgeDays: 180, validator: validateManualAttestation },
  monitoringAlerting: { label: "监控告警与值班验收", maxAgeDays: 90, validator: validateManualAttestation },
  dataGovernance: { label: "数据分类、保留与隐私审批", maxAgeDays: 365, validator: validateManualAttestation },
  changeRollback: { label: "上线变更与回退方案审批", maxAgeDays: 30, validator: validateManualAttestation },
});

const REQUIRED_APPROVALS = Object.freeze({
  business: "业务负责人放行",
  security: "信息安全负责人放行",
  operations: "运维负责人放行",
  dataProtection: "数据保护负责人放行",
});

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

function validDate(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function targetClass(value) {
  if (!value || value === "REDACTED_TARGET") return null;
  if (/^LOCAL[_-]/i.test(value)) return "LOOPBACK";
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" ? "LOOPBACK" : "REMOTE";
  } catch {
    return null;
  }
}

function passed(...conditions) {
  return conditions.every(Boolean);
}

function validateReleaseVerification(report) {
  return passed(
    report?.releaseVerification === "PASS",
    Number.isInteger(report?.syntaxFiles) && report.syntaxFiles > 0,
    Number.isInteger(report?.automatedTests) && report.automatedTests > 0,
    report?.runtimeSecretFindings === 0,
  );
}

function validateRuntimeTopology(report) {
  return passed(
    report?.reportType === "AI_DEMAND_PLATFORM_RUNTIME_TOPOLOGY_ACCEPTANCE",
    report?.outcome === "PASS",
    report?.executionMode === "READ_ONLY_REMOTE_HEALTH_SAMPLING",
    report?.targetClass === "REMOTE",
    report?.deploymentModel === "HIGH_AVAILABILITY",
    report?.runtimeProfile === "PRODUCTION_HIGH_AVAILABILITY",
    Array.isArray(report?.storageBackends) && report.storageBackends.length === 1 && ["POSTGRESQL", "MYSQL"].includes(report.storageBackends[0]),
    Number.isInteger(report?.samplesRequested) && report.samplesRequested >= 20,
    report?.samplesCompleted === report?.samplesRequested,
    Number.isInteger(report?.observedInstanceCount) && report.observedInstanceCount >= 2,
    Array.isArray(report?.observedInstanceHashes) && report.observedInstanceHashes.length >= 2 && report.observedInstanceHashes.every((value) => /^[A-F0-9]{64}$/.test(value)),
    report?.capabilities?.sharedSessionState === true,
    report?.capabilities?.distributedRateLimit === true,
    report?.capabilities?.sharedIntegrationCoordination === true,
    report?.summary?.failed === 0,
    Array.isArray(report?.checks) && report.checks.length >= 6 && report.checks.every((item) => item?.passed === true),
  );
}

function validateDeapConformance(report) {
  const classification = report?.targetClass ?? targetClass(report?.target);
  return passed(report?.outcome === "PASS", report?.mode === "FULL_WRITE", classification === "REMOTE", report?.missingOperations?.length === 0);
}

function validateIdentityLifecycleConformance(report) {
  const required = new Set(["INVALID_SIGNATURE_REJECTED", "SESSION_REVOKED", "BROWSER_BLOCKED", "DEAP_TOOL_BLOCKED", "DUPLICATE_IDEMPOTENT", "OUT_OF_ORDER_REJECTED", "ACCESS_RESTORED"]);
  const covered = new Set(Array.isArray(report?.scenariosCovered) ? report.scenariosCovered : []);
  return passed(
    report?.reportType === "AI_DEMAND_PLATFORM_IDENTITY_LIFECYCLE_CONFORMANCE",
    report?.outcome === "PASS",
    report?.mode === "FULL_WRITE",
    report?.targetClass === "REMOTE",
    report?.summary?.failed === 0,
    [...required].every((item) => covered.has(item)),
    report?.safety?.testEmployeeConfirmed === true,
    report?.safety?.containsRawEmployeeId === false,
    report?.safety?.containsSecret === false,
  );
}

function validateConnectorAcceptance(report) {
  return passed(
    report?.reportType === "BUSINESS_SYSTEM_CONNECTOR_ACCEPTANCE",
    report?.outcome === "PASS",
    report?.mode === "WRITE_ACCEPTANCE",
    report?.targetClass === "REMOTE",
    report?.summary?.failed === 0,
    report?.summary?.skipped === 0,
  );
}

function validateRealPilot(report) {
  return passed(report?.decision === "GO", report?.evidenceClass === "REAL_EMPLOYEE", report?.summary?.failed === 0, report?.summary?.missing === 0);
}

function validateRemoteCapacity(report) {
  return passed(
    report?.reportType === "AI_DEMAND_PLATFORM_CAPACITY_TEST",
    report?.outcome === "PASS",
    report?.targetClass === "REMOTE",
    report?.executionTopology !== "LOCAL_COMBINED_PROCESS",
    report?.profile?.arrivalModel === "OPEN_LOOP_SCHEDULED_RATE",
    report?.safety?.businessWritesGenerated === false,
  );
}

function validateManualAttestation(report) {
  return passed(
    report?.reportType === "PRODUCTION_MANUAL_ATTESTATION",
    report?.result === "PASS",
    typeof report?.controlOwnerHash === "string",
    /^[A-F0-9]{64}$/.test(report.controlOwnerHash),
    typeof report?.summary === "string" && report.summary.trim().length >= 10,
  );
}

function safeArtifact(root, relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim() === "" || path.isAbsolute(relativePath)) throw new Error("证据路径必须是清单目录内的相对路径");
  const rootReal = fs.realpathSync(root);
  const resolved = path.resolve(rootReal, relativePath);
  if (resolved !== rootReal && !resolved.startsWith(`${rootReal}${path.sep}`)) throw new Error("证据路径越出清单目录");
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error("证据文件不存在或不是普通文件");
  const artifactReal = fs.realpathSync(resolved);
  if (artifactReal !== rootReal && !artifactReal.startsWith(`${rootReal}${path.sep}`)) throw new Error("证据符号链接越出清单目录");
  return artifactReal;
}

function evidenceRule(id, specification, descriptor, context) {
  const base = { id, label: specification.label, category: "evidence", maxAgeDays: specification.maxAgeDays };
  if (descriptor === null || descriptor === undefined) return { ...base, status: "MISSING", finding: "未提供证据" };
  try {
    if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) throw new Error("证据描述必须是对象");
    if (descriptor.result !== "PASS") throw new Error(descriptor.result === "FAIL" ? "证据结论为FAIL" : "证据结论不是PASS");
    if (descriptor.environment !== context.targetEnvironment) throw new Error("证据环境与放行目标不一致");
    const capturedAt = validDate(descriptor.capturedAt);
    if (capturedAt === null) throw new Error("证据时间无效");
    const ageMs = context.nowMs - capturedAt;
    if (ageMs < -5 * 60 * 1000) throw new Error("证据时间位于未来");
    if (ageMs > specification.maxAgeDays * 86400_000) throw new Error("证据已超过允许时效");
    const artifactPath = safeArtifact(context.manifestDirectory, descriptor.artifact);
    const bytes = fs.readFileSync(artifactPath);
    const actualHash = sha256(bytes);
    if (!/^[A-Fa-f0-9]{64}$/.test(descriptor.sha256 ?? "") || actualHash !== descriptor.sha256.toUpperCase()) throw new Error("证据SHA-256不一致");
    let report;
    try { report = JSON.parse(bytes.toString("utf8")); }
    catch { throw new Error("证据必须是UTF-8 JSON"); }
    if (!specification.validator(report)) throw new Error("证据内容不满足该类别的生产范围约束");
    return { ...base, status: "PASS", finding: null, capturedAt: new Date(capturedAt).toISOString(), artifactSha256: actualHash };
  } catch (error) {
    return { ...base, status: "FAIL", finding: error.message };
  }
}

function approvalRule(id, label, approval, context) {
  const base = { id, label, category: "approval" };
  if (approval === null || approval === undefined) return { ...base, status: "MISSING", finding: "未提供审批" };
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) return { ...base, status: "FAIL", finding: "审批必须是对象" };
  if (approval.approved === null || approval.approved === undefined) return { ...base, status: "MISSING", finding: "审批结论未填写" };
  if (approval.approved !== true) return { ...base, status: "FAIL", finding: "审批明确拒绝放行" };
  if (!/^[A-Fa-f0-9]{64}$/.test(approval.approverHash ?? "")) return { ...base, status: "FAIL", finding: "审批人哈希无效" };
  const approvedAt = validDate(approval.approvedAt);
  if (approvedAt === null || approvedAt > context.nowMs + 5 * 60 * 1000) return { ...base, status: "FAIL", finding: "审批时间无效" };
  if (approval.changeRef !== context.changeRef) return { ...base, status: "FAIL", finding: "审批变更单号不一致" };
  return { ...base, status: "PASS", finding: null, approvedAt: new Date(approvedAt).toISOString(), approverHash: approval.approverHash.toUpperCase() };
}

export function evaluateProductionReadiness({ manifest, manifestPath, expectedReleaseVersion, now = new Date() }) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("生产就绪清单必须是对象");
  const manifestDirectory = path.dirname(path.resolve(manifestPath));
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("评估时间无效");
  const rules = [];
  const topRule = (id, label, ok, finding) => rules.push({ id, label, category: "manifest", status: ok ? "PASS" : "FAIL", finding: ok ? null : finding });
  topRule("SCHEMA_VERSION", "清单Schema版本", manifest.schemaVersion === 1, "仅支持schemaVersion=1");
  topRule("RELEASE_VERSION", "待发布版本", typeof manifest.releaseVersion === "string" && manifest.releaseVersion === expectedReleaseVersion, "清单版本与当前源码版本不一致");
  topRule("TARGET_ENVIRONMENT", "目标环境", manifest.targetEnvironment === "PRODUCTION", "生产放行只接受PRODUCTION目标");
  topRule("DEPLOYMENT_MODEL", "部署模型", manifest.deploymentModel === "HIGH_AVAILABILITY", "全员生产必须使用HIGH_AVAILABILITY部署模型");
  topRule("CHANGE_REFERENCE", "变更单号", typeof manifest.changeRef === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{5,79}$/.test(manifest.changeRef), "变更单号格式无效");
  const artifactNames = Object.values(manifest.evidence ?? {}).filter(Boolean).map((item) => item.artifact).filter(Boolean);
  topRule("EVIDENCE_UNIQUENESS", "证据文件独立性", new Set(artifactNames).size === artifactNames.length, "不同控制项不得复用同一证据文件");
  const approverHashes = Object.values(manifest.approvals ?? {}).filter((item) => item?.approved === true).map((item) => item.approverHash?.toUpperCase()).filter(Boolean);
  topRule("APPROVAL_SEPARATION", "审批职责分离", new Set(approverHashes).size === approverHashes.length, "业务、安全、运维和数据保护审批人必须相互独立");

  const context = { manifestDirectory, nowMs, targetEnvironment: manifest.targetEnvironment, changeRef: manifest.changeRef };
  for (const [id, specification] of Object.entries(REQUIRED_EVIDENCE)) rules.push(evidenceRule(id, specification, manifest.evidence?.[id], context));
  for (const [id, label] of Object.entries(REQUIRED_APPROVALS)) rules.push(approvalRule(id, label, manifest.approvals?.[id], context));

  const failed = rules.filter((item) => item.status === "FAIL");
  const missing = rules.filter((item) => item.status === "MISSING");
  const decision = failed.length > 0 ? "NO_GO" : missing.length > 0 ? "NOT_READY" : "GO";
  return {
    reportType: "AI_DEMAND_PLATFORM_PRODUCTION_READINESS",
    reportVersion: 1,
    decision,
    releaseVersion: manifest.releaseVersion ?? null,
    targetEnvironment: manifest.targetEnvironment ?? null,
    deploymentModel: manifest.deploymentModel ?? null,
    changeRef: manifest.changeRef ?? null,
    evaluatedAt: now.toISOString(),
    summary: { total: rules.length, passed: rules.filter((item) => item.status === "PASS").length, failed: failed.length, missing: missing.length },
    rules,
    warning: "GO仅表示所提供证据满足本门禁；仍须通过公司正式变更系统在批准窗口执行。",
  };
}

function displayFinding(rule) {
  return rule.finding ? rule.finding.replaceAll("|", "／").replaceAll("\n", " ") : "—";
}

export function productionReadinessMarkdown(report) {
  return `# AI统一需求平台生产就绪总门禁报告

- 结论：**${report.decision}**
- 发布版本：\`${report.releaseVersion ?? "未填写"}\`
- 目标环境：\`${report.targetEnvironment ?? "未填写"}\`
- 部署模型：\`${report.deploymentModel ?? "未填写"}\`
- 变更单号：\`${report.changeRef ?? "未填写"}\`
- 评估时间：${report.evaluatedAt}

| 检查项 | 类别 | 状态 | 说明 |
|---|---|---|---|
${report.rules.map((item) => `| ${item.label} | ${item.category} | ${item.status} | ${displayFinding(item)} |`).join("\n")}

汇总：通过 ${report.summary.passed}，失败 ${report.summary.failed}，缺证据 ${report.summary.missing}。

${report.warning}
`;
}

export { REQUIRED_APPROVALS, REQUIRED_EVIDENCE };
