import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db.mjs";
import { KnowledgeService } from "../src/services/knowledge-service.mjs";
import { createApplication } from "../src/server.mjs";
import { MockConnector } from "../src/connectors/mock-connector.mjs";

const HASH_A = "A".repeat(64);
const HASH_B = "B".repeat(64);

function definition(version = 1, overrides = {}) {
  return {
    knowledgeId: "KB-ERP-001",
    version,
    title: "ERP主数据常见问题",
    patterns: ["ERP物料报错", "主数据异常"],
    answer: version === 1 ? "请先核对物料编号和报错时间。" : "请核对物料编号、组织范围和报错时间。",
    ownerTeam: "ERP支持组",
    changeRef: `KB-CHANGE-20260817-00${version}`,
    source: {
      title: "ERP主数据支持手册",
      url: "https://intranet.example.invalid/erp-master-data",
      contentSha256: version === 1 ? HASH_A : HASH_B,
      reviewedAt: "2026-08-17T00:00:00.000Z",
    },
    allowedDepartments: ["D-ERP"],
    enabled: true,
    expiresAt: "2027-08-17T00:00:00.000Z",
    ...overrides,
  };
}

test("知识目录支持dry-run、版本发布、幂等重放和不可变历史", (t) => {
  const db = openDatabase(":memory:", { seedDemo: false });
  t.after(() => db.close());
  const knowledge = new KnowledgeService(db, { now: () => new Date("2026-08-18T00:00:00.000Z") });

  const preview = knowledge.importDefinitions([definition()], { dryRun: true });
  assert.equal(preview.operations[0].action, "CREATE");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM knowledge_items").get().count, 0);

  const created = knowledge.importDefinitions([definition()], { importedBy: "E-KB-ADMIN" });
  assert.equal(created.operations[0].action, "CREATE");
  assert.equal(knowledge.search("ERP物料报错", { departmentId: "d-erp" }).version, 1);
  assert.equal(knowledge.search("ERP物料报错", { departmentId: "D-HR" }), null);
  assert.equal(knowledge.search("ERP物料报错", { departmentId: "D-HR", departmentIds: ["D-HR", "D-ERP"] }).version, 1);

  const replay = knowledge.importDefinitions([definition()], { importedBy: "E-KB-ADMIN" });
  assert.equal(replay.operations[0].action, "REPLAY");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM knowledge_revisions").get().count, 1);

  const upgraded = knowledge.importDefinitions([definition(2)], { importedBy: "E-KB-ADMIN" });
  assert.equal(upgraded.operations[0].action, "UPDATE");
  assert.equal(knowledge.search("主数据异常", { departmentId: "D-ERP" }).version, 2);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM knowledge_revisions").get().count, 2);
  assert.throws(() => db.prepare("UPDATE knowledge_revisions SET change_ref = 'MUTATED' WHERE knowledge_id = ?").run("KB-ERP-001"), /immutable/);
  assert.throws(() => db.prepare("DELETE FROM knowledge_revisions WHERE knowledge_id = ?").run("KB-ERP-001"), /immutable/);
});

test("知识发布拒绝静默覆盖、跳版本、无操作人和不安全来源", (t) => {
  const db = openDatabase(":memory:", { seedDemo: false });
  t.after(() => db.close());
  const knowledge = new KnowledgeService(db);
  assert.throws(() => knowledge.importDefinitions([definition()]), (error) => error.code === "INVALID_KNOWLEDGE_IMPORT_ACTOR");
  knowledge.importDefinitions([definition()], { importedBy: "E-KB-ADMIN" });
  assert.throws(() => knowledge.importDefinitions([definition(1, { answer: "被静默修改" })], { importedBy: "E-KB-ADMIN" }), (error) => error.code === "KNOWLEDGE_VERSION_CONFLICT");
  assert.throws(() => knowledge.importDefinitions([definition(3)], { importedBy: "E-KB-ADMIN" }), (error) => error.code === "KNOWLEDGE_VERSION_SEQUENCE_INVALID");
  const unsafe = definition(2);
  unsafe.source.url = "https://user:password@intranet.example.invalid/doc";
  assert.throws(() => knowledge.importDefinitions([unsafe], { dryRun: true }), (error) => error.code === "INVALID_KNOWLEDGE_DEFINITION");
  const sensitiveQuery = definition(2);
  sensitiveQuery.source.url = "https://intranet.example.invalid/doc?access_token=secret";
  assert.throws(() => knowledge.importDefinitions([sensitiveQuery], { dryRun: true }), (error) => error.code === "INVALID_KNOWLEDGE_DEFINITION");
  const futureReview = definition(2);
  futureReview.source.reviewedAt = "2099-01-01T00:00:00.000Z";
  futureReview.expiresAt = "2100-01-01T00:00:00.000Z";
  assert.throws(() => knowledge.importDefinitions([futureReview], { dryRun: true }), (error) => error.code === "KNOWLEDGE_REVIEW_TIME_IN_FUTURE");
  assert.equal(db.prepare("SELECT current_version FROM knowledge_items WHERE knowledge_id = ?").get("KB-ERP-001").current_version, 1);
});

test("过期、停用和批次失败的知识不会进入回答", (t) => {
  const db = openDatabase(":memory:", { seedDemo: false });
  t.after(() => db.close());
  const knowledge = new KnowledgeService(db, { now: () => new Date("2028-01-01T00:00:00.000Z") });
  knowledge.importDefinitions([definition()], { importedBy: "E-KB-ADMIN" });
  assert.equal(knowledge.search("ERP物料报错", { departmentId: "D-ERP" }), null);

  const valid = definition(2, { expiresAt: "2029-01-01T00:00:00.000Z" });
  const invalid = { ...definition(1), knowledgeId: "KB-BAD-001", patterns: [] };
  assert.throws(() => knowledge.importDefinitions([valid, invalid], { importedBy: "E-KB-ADMIN" }), (error) => error.code === "INVALID_KNOWLEDGE_DEFINITION");
  assert.equal(db.prepare("SELECT current_version FROM knowledge_items WHERE knowledge_id = ?").get("KB-ERP-001").current_version, 1);
});

test("旧演示知识首次治理必须显式递增版本", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const knowledge = new KnowledgeService(db);
  const legacy = definition(1, { knowledgeId: "KB-DEMO-001" });
  assert.throws(() => knowledge.importDefinitions([legacy], { importedBy: "E-KB-ADMIN" }), (error) => error.code === "LEGACY_KNOWLEDGE_REQUIRES_VERSION_BUMP");
  const upgraded = definition(2, { knowledgeId: "KB-DEMO-001" });
  assert.equal(knowledge.importDefinitions([upgraded], { importedBy: "E-KB-ADMIN" }).operations[0].action, "UPDATE");
});

test("生产环境空库不会注入演示服务或演示知识", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "production-empty-catalog-"));
  const app = createApplication({
    productionMode: true,
    databasePath: path.join(root, "production.db"),
    connectors: [new MockConnector("CRM")],
    webhookSecrets: { CRM: "r".repeat(40) },
    confirmationSecret: "c".repeat(40),
    webhookSecret: "w".repeat(40),
    toolApiKey: "t".repeat(40),
    adminApiKey: "a".repeat(40),
    metricsApiKey: "m".repeat(40),
    identityHmacSecret: "i".repeat(40),
    identityEventSecret: "v".repeat(40),
    operatorHmacSecret: "o".repeat(40),
    analyticsHashSecret: "h".repeat(40),
    auditChainSecret: "u".repeat(40),
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.deepEqual(app.services.catalog.search(""), []);
  assert.equal(app.services.knowledge.search("申请系统权限", { departmentId: "D-ORG" }), null);
});
