import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Python白名单资料检查器区分READY、NOT_READY和REJECTED", () => {
  const result = spawnSync(process.env.PYTHON ?? "python", ["tools/audit_p0_intake.py", "--self-test"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload, {
    selfTest: "PASS",
    businessReady: "READY",
    deapReady: "READY",
    organizationReady: "READY",
    infrastructureReady: "READY",
    rejected: "REJECTED",
    notReady: "NOT_READY",
    officeContainers: "PASS",
    lockedRejected: true,
  });
});
