import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const python = process.env.PYTHON ?? "python";
const options = { encoding: "utf8" };

test("Python白名单知识草稿生成器覆盖Office读取、安全拒绝和人工审阅门禁", () => {
  const result = spawnSync(python, ["tools/build_knowledge_draft.py", "--self-test"], options);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    selfTest: "PASS",
    formats: [".txt", ".docx", ".xlsx", ".pptx"],
    reviewRequired: true,
    secretRedaction: 1,
    lockedRejected: true,
    privateKeyRejected: true,
    sensitiveUrlRejected: true,
    tamperRejected: true,
  });
});

test("知识草稿只在显式确认受控输出后写入，报告不泄露绝对路径或疑似密钥", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-draft-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "guide.txt");
  const output = path.join(root, "draft.json");
  fs.writeFileSync(source, "系统权限说明\napi_key: ABCDEFGHIJKLMNOP\n必须走原审批流程", "utf8");
  const base = [
    "tools/build_knowledge_draft.py", "--source", source, "--output", output,
    "--source-url", "https://intranet.example.invalid/access-guide",
    "--owner-team", "权限服务组", "--allowed-department", "D-ORG",
    "--classification", "INTERNAL", "--prepared-by", "E-KB-ADMIN", "--intake-ref", "KB-INTAKE-001",
  ];
  const rejected = spawnSync(python, base, options);
  assert.equal(rejected.status, 1);
  assert.equal(fs.existsSync(output), false);

  const accepted = spawnSync(python, [...base, "--allow-write-extracted-content"], options);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout.includes(root), false);
  const verification = spawnSync(python, ["tools/build_knowledge_draft.py", "--verify-draft", output], options);
  assert.equal(verification.status, 0, verification.stderr);
  const report = JSON.parse(verification.stdout);
  assert.equal(report.status, "REVIEW_REQUIRED");
  assert.equal(report.publishable, false);
  assert.equal(report.unredactedSecretFindings, 0);
  assert.equal(verification.stdout.includes(root), false);

  const overwrite = spawnSync(python, [...base, "--allow-write-extracted-content"], options);
  assert.equal(overwrite.status, 1);
  assert.match(JSON.parse(overwrite.stderr).error.message, /已存在/);
});

test("SafeNet知识目录由Python逻辑读取后只通过内存管道交给Node校验", () => {
  const result = spawnSync(python, ["tools/import_knowledge_catalog.py", "--self-test"], options);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    selfTest: "PASS",
    pythonLogicalRead: true,
    nodeStdinBridge: true,
    plaintextCopyPersisted: false,
  });
});
