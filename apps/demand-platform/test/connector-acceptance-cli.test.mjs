import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const baseArgs = [
  "scripts/run-connector-acceptance.mjs",
  "--config", "deploy/connectors.production.example.json",
  "--fixture", "config/connector-acceptance-fixture.example.json",
];

test("连接器CLI只读检查返回NOT_READY且无需凭据", () => {
  const result = spawnSync(process.execPath, baseArgs, { cwd: projectRoot, encoding: "utf8", env: {} });
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stdout);
  assert.equal(report.outcome, "NOT_READY");
  assert.equal(report.security.explicitWriteAuthorization, false);
});

test("连接器CLI拒绝仅凭单开关写入远程系统", () => {
  const result = spawnSync(process.execPath, [...baseArgs, "--allow-write"], { cwd: projectRoot, encoding: "utf8", env: {} });
  assert.equal(result.status, 1);
  const failure = JSON.parse(result.stderr);
  assert.match(failure.error.message, /--allow-remote-write/);
});
