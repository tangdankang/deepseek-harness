import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { openDatabase } from "../src/db.mjs";
import { CatalogService } from "../src/services/catalog-service.mjs";

function definition(version = 1) {
  return {
    serviceCode: "TB_DATA_ISSUE",
    serviceName: "TB数据问题报修",
    domainCode: "ORG_TB",
    ownerTeam: "TB支持组",
    description: "收集TB数据异常并生成处理单。",
    targetSystem: "TB",
    targetTicketType: "DATA_ISSUE",
    riskLevel: "LOW",
    aiPolicy: { answer: true, collect: true, submit: true },
    keywords: ["TB", "报表", "数据异常"],
    schema: {
      version,
      fields: [
        { name: "reportName", label: "报表名称", type: "string", required: true, minLength: 2, maxLength: 120 },
        ...(version >= 2 ? [{ name: "description", label: "问题描述", type: "textarea", required: true, minLength: 4, maxLength: 1000 }] : []),
      ],
    },
  };
}

function publish(catalog, definitions, changeRef = "CHG-CATALOG-TEST-001") {
  return catalog.importDefinitions(definitions, { importedBy: "CATALOG-TEST", changeRef });
}

test("服务目录可配置化导入、幂等重放并保留历史Schema版本", (t) => {
  const db = openDatabase(":memory:", { seedDemo: false });
  t.after(() => db.close());
  const catalog = new CatalogService(db);

  const dryRun = catalog.importDefinitions([definition(1)], { dryRun: true });
  assert.equal(dryRun.operations[0].action, "CREATE");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM service_items").get().count, 0);

  const created = publish(catalog, [definition(1)]);
  assert.equal(created.operations[0].schemaAction, "INSERT");
  assert.equal(catalog.search("TB报表数据异常")[0].serviceCode, "TB_DATA_ISSUE");
  assert.equal(catalog.getSchema("TB_DATA_ISSUE").version, 1);

  const replay = publish(catalog, [{ ...definition(1), ownerTeam: "TB平台组" }], "CHG-CATALOG-TEST-002");
  assert.equal(replay.operations[0].schemaAction, "UNCHANGED");
  assert.equal(catalog.get("TB_DATA_ISSUE").ownerTeam, "TB平台组");

  const upgraded = publish(catalog, [definition(2)], "CHG-CATALOG-TEST-003");
  assert.equal(upgraded.operations[0].schemaVersion, 2);
  assert.equal(catalog.getSchema("TB_DATA_ISSUE").version, 2);
  assert.equal(catalog.getSchema("TB_DATA_ISSUE", 1).fields.length, 1);
  assert.equal(catalog.getSchema("TB_DATA_ISSUE", 2).fields.length, 2);
});

test("服务目录拒绝静默覆盖、跳版本和无效字段定义", (t) => {
  const db = openDatabase(":memory:", { seedDemo: false });
  t.after(() => db.close());
  const catalog = new CatalogService(db);
  publish(catalog, [definition(1)]);

  const changedWithoutVersion = definition(1);
  changedWithoutVersion.schema.fields.push({ name: "description", label: "问题描述", type: "textarea", required: true });
  assert.throws(() => publish(catalog, [changedWithoutVersion]), (error) => error.code === "SCHEMA_VERSION_CONFLICT");
  assert.throws(() => publish(catalog, [definition(3)]), (error) => error.code === "SCHEMA_VERSION_SEQUENCE_INVALID");

  const rerouted = definition(2);
  rerouted.targetSystem = "ERP";
  assert.throws(() => publish(catalog, [rerouted]), (error) => error.code === "IMMUTABLE_SERVICE_ROUTING");

  const invalid = definition(2);
  invalid.schema.fields[0].type = "password";
  assert.throws(() => publish(catalog, [invalid]), (error) => error.code === "INVALID_SERVICE_DEFINITION");
  assert.equal(catalog.getSchema("TB_DATA_ISSUE").version, 1);
});

test("服务目录批次在写入前整体校验，避免部分成功", (t) => {
  const db = openDatabase(":memory:", { seedDemo: false });
  t.after(() => db.close());
  const catalog = new CatalogService(db);
  const invalid = { ...definition(1), serviceCode: "SECOND_SERVICE", keywords: [] };
  assert.throws(() => publish(catalog, [definition(1), invalid]), (error) => error.code === "INVALID_SERVICE_DEFINITION");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM service_items").get().count, 0);
});

test("服务目录受众策略在搜索、详情和Schema读取时执行服务端授权", (t) => {
  const db = openDatabase(":memory:", { seedDemo: false });
  t.after(() => db.close());
  const catalog = new CatalogService(db);
  publish(catalog, [{ ...definition(1), audiencePolicy: { visibility: "DEPARTMENTS", departmentIds: ["D-BI"] } }]);

  const allowed = { employeeId: "E-BI", departmentId: "D-BI" };
  const denied = { employeeId: "E-OTHER", departmentId: "D-OTHER" };
  assert.equal(catalog.search("TB", allowed).length, 1);
  assert.equal(catalog.search("TB", denied).length, 0);
  assert.equal(catalog.get("TB_DATA_ISSUE", allowed).serviceCode, "TB_DATA_ISSUE");
  assert.throws(() => catalog.get("TB_DATA_ISSUE", denied), (error) => error.code === "SERVICE_NOT_FOUND" && error.status === 404);
  assert.throws(() => catalog.getSchema("TB_DATA_ISSUE", undefined, denied), (error) => error.code === "SERVICE_NOT_FOUND");

  const invalid = { ...definition(1), serviceCode: "TB_INVALID_AUDIENCE", audiencePolicy: { visibility: "DEPARTMENTS", departmentIds: [] } };
  assert.throws(() => publish(catalog, [invalid]), (error) => error.code === "INVALID_SERVICE_DEFINITION");
});

test("服务目录修订历史不可变，幂等重放不制造审计噪音", (t) => {
  const db = openDatabase(":memory:", { seedDemo: false });
  t.after(() => db.close());
  const catalog = new CatalogService(db);
  assert.throws(() => catalog.importDefinitions([definition(1)]), (error) => error.code === "INVALID_SERVICE_IMPORT_ACTOR");
  assert.throws(() => catalog.importDefinitions([definition(1)], { importedBy: "CATALOG-ADMIN" }), (error) => error.code === "INVALID_SERVICE_CHANGE_REF");

  const created = publish(catalog, [definition(1)], "CHG-CATALOG-GOV-001");
  assert.equal(created.operations[0].revision, 1);
  const replay = publish(catalog, [definition(1)], "CHG-CATALOG-GOV-REPLAY");
  assert.equal(replay.operations[0].action, "REPLAY");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM service_revisions").get().count), 1);

  const changed = publish(catalog, [{ ...definition(1), audiencePolicy: { visibility: "DEPARTMENTS", departmentIds: ["D-BI"] } }], "CHG-CATALOG-GOV-002");
  assert.equal(changed.operations[0].action, "UPDATE_METADATA");
  assert.equal(changed.operations[0].revision, 2);
  const revisions = db.prepare("SELECT revision, change_ref, imported_by, definition_sha256 FROM service_revisions ORDER BY revision").all();
  assert.deepEqual(revisions.map((row) => Number(row.revision)), [1, 2]);
  assert.ok(revisions.every((row) => /^[A-F0-9]{64}$/.test(row.definition_sha256)));
  assert.throws(() => db.prepare("UPDATE service_revisions SET change_ref = 'TAMPERED' WHERE revision = 1").run());
  assert.throws(() => db.prepare("DELETE FROM service_revisions WHERE revision = 1").run());
  db.prepare("UPDATE service_items SET owner_team = '数据库旁路篡改' WHERE service_code = 'TB_DATA_ISSUE'").run();
  assert.throws(() => publish(catalog, [{ ...definition(1), audiencePolicy: { visibility: "DEPARTMENTS", departmentIds: ["D-BI"] } }]), (error) => error.code === "SERVICE_CURRENT_STATE_TAMPERED");
});

test("旧服务首次正式导入建立治理基线，不能同时静默升级Schema", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const catalog = new CatalogService(db);
  const row = db.prepare("SELECT * FROM service_items WHERE service_code = 'CRM_ACCOUNT_CHANGE'").get();
  const schema = JSON.parse(db.prepare("SELECT schema_json FROM service_schemas WHERE service_code = ? AND version = 1").get(row.service_code).schema_json);
  const legacy = {
    serviceCode: row.service_code, serviceName: row.service_name, domainCode: row.domain_code, ownerTeam: row.owner_team,
    description: row.description, targetSystem: row.target_system, targetTicketType: row.target_ticket_type,
    riskLevel: row.risk_level, aiPolicy: JSON.parse(row.ai_policy_json), audiencePolicy: JSON.parse(row.audience_policy_json),
    keywords: JSON.parse(row.keywords_json), enabled: Boolean(row.enabled), schema,
  };
  const invalidUpgrade = { ...legacy, schema: { ...schema, version: 2, fields: [...schema.fields, { name: "extraInfo", label: "补充信息", type: "string", required: false }] } };
  assert.throws(() => publish(catalog, [invalidUpgrade]), (error) => error.code === "LEGACY_SERVICE_REQUIRES_BASELINE");
  const adopted = publish(catalog, [legacy], "CHG-CATALOG-ADOPT-001");
  assert.equal(adopted.operations[0].action, "ADOPT_LEGACY");
  assert.equal(Number(db.prepare("SELECT current_revision FROM service_items WHERE service_code = ?").get(row.service_code).current_revision), 1);
});

test("服务目录CLI正式写入强制操作人和变更单", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "service-catalog-cli-"));
  const file = path.join(root, "catalog.json");
  const database = path.join(root, "catalog.db");
  fs.writeFileSync(file, `${JSON.stringify({ services: [definition(1)] })}\n`, "utf8");
  const run = (...extra) => spawnSync(process.execPath, ["scripts/import-service-catalog.mjs", "--file", file, "--database", database, ...extra], { cwd: path.resolve("."), encoding: "utf8" });
  const missingActor = run();
  assert.equal(missingActor.status, 1);
  assert.match(missingActor.stderr, /INVALID_SERVICE_IMPORT_ACTOR/);
  const missingChange = run("--imported-by", "CATALOG-ADMIN");
  assert.equal(missingChange.status, 1);
  assert.match(missingChange.stderr, /INVALID_SERVICE_CHANGE_REF/);
  const success = run("--imported-by", "CATALOG-ADMIN", "--change-ref", "CHG-CATALOG-CLI-001");
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /"revision": 1/);
  assert.ok(!success.stdout.includes(database));
});
