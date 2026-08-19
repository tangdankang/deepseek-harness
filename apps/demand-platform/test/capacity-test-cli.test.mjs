import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("远程容量测试必须同时声明负载许可和已批准窗口", () => {
  const result = spawnSync(process.execPath, ["scripts/run-capacity-test.mjs", "--base-url", "https://capacity.example.internal", "--allow-remote-load"], { cwd: projectRoot, encoding: "utf8", env: {} });
  assert.equal(result.status, 1);
  const failure = JSON.parse(result.stderr);
  assert.match(failure.error.message, /--confirm-approved-window/);
});
