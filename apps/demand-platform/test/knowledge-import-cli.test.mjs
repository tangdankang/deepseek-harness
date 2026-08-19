import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("知识目录CLI默认可安全dry-run，正式写入要求操作人且不泄露数据库路径", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const database = path.join(root, "knowledge.db");
  const fixture = path.resolve("config/knowledge-catalog.example.json");
  const options = { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } };

  const preview = spawnSync(process.execPath, ["scripts/import-knowledge-catalog.mjs", "--file", fixture, "--database", database, "--dry-run"], options);
  assert.equal(preview.status, 0, preview.stderr);
  const previewPayload = JSON.parse(preview.stdout);
  assert.equal(previewPayload.dryRun, true);
  assert.equal(previewPayload.database, ":memory:");
  assert.equal(fs.existsSync(database), false);

  const rejected = spawnSync(process.execPath, ["scripts/import-knowledge-catalog.mjs", "--file", fixture, "--database", database], options);
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stderr).error.code, "INVALID_KNOWLEDGE_IMPORT_ACTOR");

  const imported = spawnSync(process.execPath, ["scripts/import-knowledge-catalog.mjs", "--file", fixture, "--database", database, "--imported-by", "E-KB-ADMIN"], options);
  assert.equal(imported.status, 0, imported.stderr);
  const importedPayload = JSON.parse(imported.stdout);
  assert.equal(importedPayload.database, "REDACTED_DATABASE");
  assert.equal(importedPayload.operations[0].action, "CREATE");
  assert.equal(imported.stdout.includes(root), false);
});
