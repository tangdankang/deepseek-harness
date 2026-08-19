import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateProductionReadiness } from "../src/release/production-readiness.mjs";

const NOW = new Date("2026-08-17T08:00:00.000Z");

function writeEvidence(root, name, document) {
  const file = `${name}.json`;
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(root, file), bytes);
  return {
    artifact: file,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase(),
    capturedAt: "2026-08-16T08:00:00.000Z",
    result: "PASS",
    environment: "PRODUCTION",
  };
}

function validManifest(root) {
  const manual = (name) => writeEvidence(root, name, {
    reportType: "PRODUCTION_MANUAL_ATTESTATION",
    result: "PASS",
    controlOwnerHash: crypto.createHash("sha256").update(`owner:${name}`).digest("hex").toUpperCase(),
    summary: `已完成${name}控制验证并关闭全部阻断项。`,
  });
  const evidence = {
    releaseVerification: writeEvidence(root, "release", { releaseVerification: "PASS", syntaxFiles: 100, automatedTests: 80, runtimeSecretFindings: 0 }),
    runtimeTopology: writeEvidence(root, "runtime-topology", {
      reportType: "AI_DEMAND_PLATFORM_RUNTIME_TOPOLOGY_ACCEPTANCE", outcome: "PASS", executionMode: "READ_ONLY_REMOTE_HEALTH_SAMPLING",
      targetClass: "REMOTE", deploymentModel: "HIGH_AVAILABILITY", runtimeProfile: "PRODUCTION_HIGH_AVAILABILITY", storageBackends: ["POSTGRESQL"],
      samplesRequested: 20, samplesCompleted: 20, observedInstanceCount: 2,
      observedInstanceHashes: [crypto.createHash("sha256").update("instance-1").digest("hex").toUpperCase(), crypto.createHash("sha256").update("instance-2").digest("hex").toUpperCase()],
      capabilities: { sharedSessionState: true, distributedRateLimit: true, sharedIntegrationCoordination: true },
      checks: Array.from({ length: 6 }, (_, index) => ({ id: `CHECK-${index}`, passed: true })), summary: { passed: 6, failed: 0 },
    }),
    deapConformance: writeEvidence(root, "deap", { outcome: "PASS", mode: "FULL_WRITE", targetClass: "REMOTE", missingOperations: [] }),
    identityLifecycleConformance: writeEvidence(root, "identity-lifecycle", {
      reportType: "AI_DEMAND_PLATFORM_IDENTITY_LIFECYCLE_CONFORMANCE", outcome: "PASS", mode: "FULL_WRITE", targetClass: "REMOTE", summary: { failed: 0 },
      scenariosCovered: ["INVALID_SIGNATURE_REJECTED", "SESSION_REVOKED", "BROWSER_BLOCKED", "DEAP_TOOL_BLOCKED", "DUPLICATE_IDEMPOTENT", "OUT_OF_ORDER_REJECTED", "ACCESS_RESTORED"],
      safety: { testEmployeeConfirmed: true, containsRawEmployeeId: false, containsSecret: false },
    }),
    connectorAcceptance: writeEvidence(root, "connector", { reportType: "BUSINESS_SYSTEM_CONNECTOR_ACCEPTANCE", outcome: "PASS", mode: "WRITE_ACCEPTANCE", targetClass: "REMOTE", summary: { failed: 0, skipped: 0 } }),
    realEmployeePilot: writeEvidence(root, "pilot", { decision: "GO", evidenceClass: "REAL_EMPLOYEE", summary: { failed: 0, missing: 0 } }),
    remoteCapacity: writeEvidence(root, "capacity", { reportType: "AI_DEMAND_PLATFORM_CAPACITY_TEST", outcome: "PASS", targetClass: "REMOTE", executionTopology: "DISTRIBUTED_LOAD_GENERATOR", profile: { arrivalModel: "OPEN_LOOP_SCHEDULED_RATE" }, safety: { businessWritesGenerated: false } }),
    securityAssessment: manual("security"),
    backupRestore: manual("backup"),
    disasterRecovery: manual("dr"),
    monitoringAlerting: manual("monitoring"),
    dataGovernance: manual("governance"),
    changeRollback: manual("change"),
  };
  const approval = (role, index) => ({
    approved: true,
    approverHash: crypto.createHash("sha256").update(`approver:${role}:${index}`).digest("hex").toUpperCase(),
    approvedAt: "2026-08-17T07:00:00.000Z",
    changeRef: "CHG-2026-0001",
  });
  return {
    schemaVersion: 1,
    releaseVersion: "1.8.0",
    targetEnvironment: "PRODUCTION",
    deploymentModel: "HIGH_AVAILABILITY",
    changeRef: "CHG-2026-0001",
    evidence,
    approvals: {
      business: approval("business", 1),
      security: approval("security", 2),
      operations: approval("operations", 3),
      dataProtection: approval("data", 4),
    },
  };
}

test("完整、近期、远程且职责分离的生产证据才返回GO", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "production-gate-go-"));
  const manifest = validManifest(root);
  const result = evaluateProductionReadiness({ manifest, manifestPath: path.join(root, "manifest.json"), expectedReleaseVersion: "1.8.0", now: NOW });
  assert.equal(result.decision, "GO");
  assert.equal(result.summary.failed, 0);
  assert.equal(result.summary.missing, 0);
});

test("空白正式清单明确返回NOT_READY而不误判上线", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "production-gate-empty-"));
  const manifest = validManifest(root);
  for (const key of Object.keys(manifest.evidence)) manifest.evidence[key] = null;
  for (const key of Object.keys(manifest.approvals)) manifest.approvals[key] = null;
  const result = evaluateProductionReadiness({ manifest, manifestPath: path.join(root, "manifest.json"), expectedReleaseVersion: "1.8.0", now: NOW });
  assert.equal(result.decision, "NOT_READY");
  assert.equal(result.summary.missing, 17);
});

test("本地DEAP、连接器、合成试点和回环容量报告不能充当生产证据", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "production-gate-local-"));
  const manifest = validManifest(root);
  manifest.evidence.deapConformance = writeEvidence(root, "deap-local", { outcome: "PASS", mode: "FULL_WRITE", targetClass: "LOOPBACK", missingOperations: [] });
  manifest.evidence.connectorAcceptance = writeEvidence(root, "connector-local", { reportType: "BUSINESS_SYSTEM_CONNECTOR_ACCEPTANCE", outcome: "PASS", mode: "WRITE_ACCEPTANCE", targetClass: "LOOPBACK", summary: { failed: 0, skipped: 0 } });
  manifest.evidence.realEmployeePilot = writeEvidence(root, "pilot-synthetic", { decision: "GO", evidenceClass: "SYNTHETIC", summary: { failed: 0, missing: 0 } });
  manifest.evidence.remoteCapacity = writeEvidence(root, "capacity-local", { reportType: "AI_DEMAND_PLATFORM_CAPACITY_TEST", outcome: "PASS", targetClass: "LOOPBACK", executionTopology: "LOCAL_COMBINED_PROCESS", profile: { arrivalModel: "OPEN_LOOP_SCHEDULED_RATE" }, safety: { businessWritesGenerated: false } });
  const result = evaluateProductionReadiness({ manifest, manifestPath: path.join(root, "manifest.json"), expectedReleaseVersion: "1.8.0", now: NOW });
  assert.equal(result.decision, "NO_GO");
  for (const id of ["deapConformance", "connectorAcceptance", "realEmployeePilot", "remoteCapacity"]) {
    assert.equal(result.rules.find((item) => item.id === id).status, "FAIL");
  }
});

test("单实例SQLite运行报告不能充当生产高可用拓扑证据", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "production-gate-topology-"));
  const manifest = validManifest(root);
  manifest.evidence.runtimeTopology = writeEvidence(root, "runtime-topology-pilot", {
    reportType: "AI_DEMAND_PLATFORM_RUNTIME_TOPOLOGY_ACCEPTANCE", outcome: "PASS", executionMode: "READ_ONLY_REMOTE_HEALTH_SAMPLING",
    targetClass: "REMOTE", deploymentModel: "SINGLE_NODE_PILOT", runtimeProfile: "PILOT_SINGLE_NODE_SQLITE", storageBackends: ["SQLITE"],
    samplesRequested: 20, samplesCompleted: 20, observedInstanceCount: 1,
    observedInstanceHashes: [crypto.createHash("sha256").update("one-instance").digest("hex").toUpperCase()],
    capabilities: { sharedSessionState: false, distributedRateLimit: false, sharedIntegrationCoordination: false },
    checks: Array.from({ length: 6 }, (_, index) => ({ id: `CHECK-${index}`, passed: index === 0 })), summary: { passed: 1, failed: 5 },
  });
  const result = evaluateProductionReadiness({ manifest, manifestPath: path.join(root, "manifest.json"), expectedReleaseVersion: "1.8.0", now: NOW });
  assert.equal(result.decision, "NO_GO");
  assert.equal(result.rules.find((item) => item.id === "runtimeTopology").status, "FAIL");
});

test("篡改、过期、路径越界、复用证据和复用审批人均被拒绝", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "production-gate-negative-"));
  const manifest = validManifest(root);
  fs.appendFileSync(path.join(root, manifest.evidence.releaseVerification.artifact), "tampered");
  manifest.evidence.deapConformance.capturedAt = "2020-01-01T00:00:00.000Z";
  manifest.evidence.connectorAcceptance.artifact = "../outside.json";
  manifest.evidence.backupRestore.artifact = manifest.evidence.securityAssessment.artifact;
  manifest.approvals.operations.approverHash = manifest.approvals.security.approverHash;
  const result = evaluateProductionReadiness({ manifest, manifestPath: path.join(root, "manifest.json"), expectedReleaseVersion: "1.8.0", now: NOW });
  assert.equal(result.decision, "NO_GO");
  assert.equal(result.rules.find((item) => item.id === "releaseVerification").status, "FAIL");
  assert.equal(result.rules.find((item) => item.id === "deapConformance").status, "FAIL");
  assert.equal(result.rules.find((item) => item.id === "connectorAcceptance").status, "FAIL");
  assert.equal(result.rules.find((item) => item.id === "EVIDENCE_UNIQUENESS").status, "FAIL");
  assert.equal(result.rules.find((item) => item.id === "APPROVAL_SEPARATION").status, "FAIL");
});
