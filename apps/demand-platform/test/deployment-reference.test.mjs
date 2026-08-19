import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateDeploymentReference } from "../src/ops/deployment-reference.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("单机试点部署参考满足最小安全与持久化约束", () => {
  const result = validateDeploymentReference({ projectRoot });
  assert.equal(result.valid, true, JSON.stringify(result.findings));
  assert.equal(result.scope, "static-reference-invariants");
  assert.ok(result.checks >= 20);
});

test("部署参考校验会拒绝对外暴露的试点端口", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "deployment-reference-"));
  fs.mkdirSync(path.join(temporary, "deploy"));
  fs.copyFileSync(path.join(projectRoot, "Containerfile"), path.join(temporary, "Containerfile"));
  fs.copyFileSync(path.join(projectRoot, ".dockerignore"), path.join(temporary, ".dockerignore"));
  fs.copyFileSync(path.join(projectRoot, "deploy", ".env.production.example"), path.join(temporary, "deploy", ".env.production.example"));
  fs.copyFileSync(path.join(projectRoot, "deploy", "connectors.production.example.json"), path.join(temporary, "deploy", "connectors.production.example.json"));
  fs.copyFileSync(path.join(projectRoot, "deploy", "prometheus-alerts.example.yml"), path.join(temporary, "deploy", "prometheus-alerts.example.yml"));
  const compose = fs.readFileSync(path.join(projectRoot, "deploy", "compose.pilot.example.yml"), "utf8")
    .replace("127.0.0.1:8787:8787", "0.0.0.0:8787:8787");
  fs.writeFileSync(path.join(temporary, "deploy", "compose.pilot.example.yml"), compose);

  try {
    const result = validateDeploymentReference({ projectRoot: temporary });
    assert.equal(result.valid, false);
    assert.ok(result.findings.some((finding) => finding.includes("回环地址")));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
