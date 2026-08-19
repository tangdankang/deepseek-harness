import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("生命周期CLI拒绝仅凭execute单开关删除", () => {
  const result = spawnSync(process.execPath, ["scripts/run-data-lifecycle.mjs", "--database", "work/unused-lifecycle.db", "--actor-id", "TEST-ACTOR", "--execute"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { LIFECYCLE_HASH_SECRET: "lifecycle-cli-test-secret-long-enough" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--allow-delete/);
});

test("保留冻结CLI默认拒绝任何状态变更", () => {
  const result = spawnSync(process.execPath, ["scripts/manage-data-retention-hold.mjs", "--database", "work/unused-lifecycle.db", "--action", "create", "--actor-id", "TEST-ACTOR"], { cwd: projectRoot, encoding: "utf8", env: {} });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--allow-hold-change/);
});
