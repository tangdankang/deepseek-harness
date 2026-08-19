import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { openDatabase } from "../src/db.mjs";
import { CatalogService } from "../src/services/catalog-service.mjs";
import { OrganizationDirectoryService } from "../src/services/organization-directory-service.mjs";
import { createApplication } from "../src/server.mjs";

const NOW = Date.parse("2026-08-17T08:00:00.000Z");

function snapshot(version = 1, overrides = {}) {
  return {
    version,
    sourceSystem: "DINGTALK",
    generatedAt: "2026-08-17T03:00:00.000Z",
    expiresAt: "2026-09-16T03:00:00.000Z",
    departments: [
      { departmentId: "D-COMPANY", name: "公司", parentDepartmentId: null },
      { departmentId: "D-ORG", name: "组织中心", parentDepartmentId: "D-COMPANY" },
      { departmentId: "D-CRM", name: "CRM组", parentDepartmentId: "D-ORG" },
      { departmentId: "D-CRM-EAST", name: "CRM华东", parentDepartmentId: "D-CRM" },
    ],
    ...overrides,
  };
}

function definition(audiencePolicy) {
  return {
    serviceCode: "CRM_TREE_ACCESS",
    serviceName: "CRM层级服务",
    domainCode: "ORG_CRM",
    ownerTeam: "CRM组",
    description: "验证组织层级受众授权。",
    targetSystem: "CRM",
    targetTicketType: "TREE_ACCESS",
    riskLevel: "LOW",
    aiPolicy: { answer: true, collect: true, submit: true, directBusinessMutation: false },
    audiencePolicy,
    keywords: ["CRM", "层级"],
    schema: { version: 1, fields: [{ name: "description", label: "描述", type: "textarea", required: true }] },
  };
}

function publishDirectory(directory, value, changeRef = "CHG-ORG-001") {
  return directory.importSnapshot(value, { importedBy: "ORG-SYNC", changeRef });
}

test("组织目录整包校验、连续版本、幂等重放和不可变历史", () => {
  const db = openDatabase(":memory:", { seedDemo: false });
  const directory = new OrganizationDirectoryService(db, { now: () => NOW });
  const first = publishDirectory(directory, snapshot());
  assert.equal(first.action, "CREATE");
  assert.equal(publishDirectory(directory, snapshot()).action, "REPLAY");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM organization_snapshots").get().count), 1);
  assert.throws(() => publishDirectory(directory, snapshot(1, { sourceSystem: "HR" })), (error) => error.code === "ORGANIZATION_VERSION_CONFLICT");
  assert.throws(() => publishDirectory(directory, snapshot(3)), (error) => error.code === "ORGANIZATION_VERSION_SEQUENCE_INVALID");
  assert.equal(publishDirectory(directory, snapshot(2), "CHG-ORG-002").action, "UPDATE");
  assert.throws(() => db.prepare("UPDATE organization_snapshots SET source_system = 'TAMPERED' WHERE version = 1").run(), /immutable/);
  assert.throws(() => db.prepare("DELETE FROM organization_snapshots WHERE version = 1").run(), /immutable/);
});

test("组织目录拒绝孤儿、循环、过期和未来快照", () => {
  const db = openDatabase(":memory:", { seedDemo: false });
  const directory = new OrganizationDirectoryService(db, { now: () => NOW });
  assert.throws(() => publishDirectory(directory, snapshot(1, { departments: [{ departmentId: "D1", name: "D1", parentDepartmentId: "MISSING" }] })), (error) => error.code === "INVALID_ORGANIZATION_SNAPSHOT");
  assert.throws(() => publishDirectory(directory, snapshot(1, { departments: [{ departmentId: "D1", name: "D1", parentDepartmentId: "D2" }, { departmentId: "D2", name: "D2", parentDepartmentId: "D1" }] })), (error) => error.code === "INVALID_ORGANIZATION_SNAPSHOT");
  assert.throws(() => publishDirectory(directory, snapshot(1, { generatedAt: "2026-06-01T00:00:00.000Z", expiresAt: "2026-06-30T00:00:00.000Z" })), (error) => error.code === "ORGANIZATION_SNAPSHOT_STALE");
  assert.throws(() => publishDirectory(directory, snapshot(1, { generatedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-09-17T00:00:00.000Z" })), (error) => error.code === "ORGANIZATION_GENERATED_AT_INVALID");
});

test("部门子树与人员例外按排除优先执行，未知员工和过期目录默认拒绝", () => {
  const db = openDatabase(":memory:", { seedDemo: false });
  let now = NOW;
  const directory = new OrganizationDirectoryService(db, { now: () => now });
  publishDirectory(directory, snapshot());
  const catalog = new CatalogService(db, { organizationDirectory: directory });
  catalog.importDefinitions([definition({
    visibility: "DEPARTMENTS", departmentIds: ["D-CRM"], includeDescendants: true,
    includeEmployeeIds: ["E-SPECIAL"], excludeEmployeeIds: ["E-BLOCKED"],
  })], { importedBy: "CATALOG-ADMIN", changeRef: "CHG-CATALOG-TREE-001" });
  const visible = (employeeId, departmentId) => catalog.search("层级", { employeeId, departmentId }).length;
  assert.equal(visible("E-ROOT", "D-CRM"), 1);
  assert.equal(visible("E-CHILD", "D-CRM-EAST"), 1);
  assert.equal(visible("E-SPECIAL", "D-OTHER"), 1);
  assert.equal(visible("E-BLOCKED", "D-CRM"), 0);
  assert.equal(visible("E-UNKNOWN", "D-NOT-IN-SNAPSHOT"), 0);
  assert.equal(directory.status().readiness, "ready");
  now = Date.parse("2026-09-17T00:00:00.000Z");
  assert.equal(visible("E-CHILD", "D-CRM-EAST"), 0);
  assert.equal(visible("E-ROOT", "D-CRM"), 1);
  assert.equal(visible("E-SPECIAL", "D-OTHER"), 1);
  assert.equal(directory.status().readiness, "not_ready");
});

test("部门子树服务发布要求新鲜组织目录且根部门必须存在", () => {
  const db = openDatabase(":memory:", { seedDemo: false });
  const directory = new OrganizationDirectoryService(db, { now: () => NOW });
  const catalog = new CatalogService(db, { organizationDirectory: directory });
  assert.throws(() => catalog.importDefinitions([definition({ visibility: "DEPARTMENTS", departmentIds: ["D-CRM"], includeDescendants: true })], { dryRun: true }), (error) => error.code === "ORGANIZATION_DIRECTORY_UNAVAILABLE");
  publishDirectory(directory, snapshot());
  assert.throws(() => catalog.importDefinitions([definition({ visibility: "DEPARTMENTS", departmentIds: ["D-NOT-FOUND"], includeDescendants: true })], { dryRun: true }), (error) => error.code === "UNKNOWN_AUDIENCE_DEPARTMENT");
});

test("组织目录CLI正式写入强制操作人和变更单且输出脱敏", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "organization-cli-"));
  const file = path.join(root, "organization.json");
  const database = path.join(root, "organization.db");
  fs.writeFileSync(file, `${JSON.stringify(snapshot())}\n`, "utf8");
  const run = (...extra) => spawnSync(process.execPath, ["scripts/import-organization-directory.mjs", "--file", file, "--database", database, ...extra], { cwd: path.resolve("."), encoding: "utf8" });
  assert.match(run().stderr, /INVALID_ORGANIZATION_IMPORT_ACTOR/);
  assert.match(run("--imported-by", "ORG-SYNC").stderr, /INVALID_ORGANIZATION_CHANGE_REF/);
  const success = run("--imported-by", "ORG-SYNC", "--change-ref", "CHG-ORG-CLI-001");
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /"action": "CREATE"/);
  assert.ok(!success.stdout.includes(database));
});

test("被服务依赖的组织目录缺失时就绪探针返回503", async (t) => {
  const app = createApplication({ databasePath: ":memory:", confirmationSecret: "organization-health-confirmation-secret", webhookSecret: "organization-health-webhook-secret" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => app.close());
  app.db.prepare("UPDATE service_items SET audience_policy_json = ? WHERE service_code = 'CRM_ACCOUNT_CHANGE'")
    .run(JSON.stringify({ visibility: "DEPARTMENTS", departmentIds: ["D-ORG"], includeDescendants: true, includeEmployeeIds: [], excludeEmployeeIds: [] }));
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/health/ready`);
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.error.code, "READINESS_FAILED");
  assert.equal(body.error.details.organization.state, "UNAVAILABLE");
});
