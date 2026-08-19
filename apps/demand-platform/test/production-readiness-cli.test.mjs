import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("空白生产就绪示例由CLI明确返回NOT_READY退出码3", () => {
  const result = spawnSync(process.execPath, [
    "scripts/evaluate-production-readiness.mjs",
    "--manifest", "config/production-readiness-manifest.example.json",
  ], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(result.status, 3);
  const report = JSON.parse(result.stdout);
  assert.equal(report.decision, "NOT_READY");
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.missing, 17);
});
