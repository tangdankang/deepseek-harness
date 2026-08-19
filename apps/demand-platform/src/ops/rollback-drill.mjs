import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApplication } from "../server.mjs";
import { getDatabaseSchemaInfo } from "../db.mjs";
import { backupDatabase, restoreDatabaseBackup, verifyDatabaseBackup } from "./database-backup.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

async function probe(endpoint, pathname, options = {}) {
  const startedAt = performance.now();
  const response = await fetch(`${endpoint}${pathname}`, options);
  const body = await response.json();
  return {
    path: pathname,
    status: response.status,
    ok: response.ok,
    durationMs: Math.round(performance.now() - startedAt),
    applicationStatus: body.status ?? null,
    readiness: body.readiness ?? null,
    serviceCount: Array.isArray(body.services) ? body.services.length : null,
  };
}

function inspectRestoredDatabase(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]);
    const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
    return {
      integrity,
      foreignKeyViolations: foreignKeyViolations.length,
      schema: getDatabaseSchemaInfo(db),
    };
  } finally {
    db.close();
  }
}

export async function runRollbackDrill({ databasePath, drillDirectory }) {
  if (!databasePath || !drillDirectory) throw new Error("databasePath和drillDirectory为必填项");
  const source = path.resolve(databasePath);
  const directory = path.resolve(drillDirectory);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error("演练源数据库不存在或不是文件");
  if (fs.existsSync(directory)) throw new Error("演练目录已存在，拒绝覆盖");
  fs.mkdirSync(directory, { recursive: false });

  const snapshotPath = path.join(directory, "snapshot.db");
  const restoredPath = path.join(directory, "restored.db");
  const startedAt = new Date();
  const snapshotStarted = performance.now();
  const created = backupDatabase({ databasePath: source, outputPath: snapshotPath });
  const verified = verifyDatabaseBackup({ backupPath: snapshotPath });
  const snapshotDurationMs = Math.round(performance.now() - snapshotStarted);

  const recoveryStarted = performance.now();
  const restored = restoreDatabaseBackup({ backupPath: snapshotPath, targetPath: restoredPath });
  const inspection = inspectRestoredDatabase(restoredPath);
  const app = createApplication({
    databasePath: restoredPath,
    productionMode: false,
    identityHmacSecret: "",
    operatorHmacSecret: "",
    toolApiKey: "",
    adminApiKey: "",
    sessionCookieSecure: false,
  });
  let probes;
  try {
    const address = await listen(app.server);
    const endpoint = `http://127.0.0.1:${address.port}`;
    probes = [
      await probe(endpoint, "/health/ready"),
      await probe(endpoint, "/api/v1/services", {
        headers: {
          "x-employee-id": "ROLLBACK-DRILL",
          "x-department-id": "DRILL",
          "x-employee-name": encodeURIComponent("回滚演练"),
        },
      }),
    ];
  } finally {
    await app.close();
  }
  const recoveryDurationMs = Math.round(performance.now() - recoveryStarted);
  const finishedAt = new Date();
  const countsMatch = JSON.stringify(created.metadata.tableCounts) === JSON.stringify(restored.tableCounts);
  const passed = verified.valid
    && countsMatch
    && inspection.integrity.length === 1
    && inspection.integrity[0] === "ok"
    && inspection.foreignKeyViolations === 0
    && inspection.schema.compatible
    && probes.every((item) => item.ok);
  return {
    reportType: "AI_DEMAND_PLATFORM_DATABASE_ROLLBACK_DRILL",
    reportVersion: "1.0",
    result: passed ? "PASS" : "FAIL",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    snapshotDurationMs,
    recoveryDurationMs,
    totalDurationMs: finishedAt.getTime() - startedAt.getTime(),
    backup: {
      format: created.metadata.format,
      bytes: verified.bytes,
      sha256: verified.sha256,
      verified: verified.valid,
    },
    database: {
      schema: inspection.schema,
      integrity: inspection.integrity,
      foreignKeyViolations: inspection.foreignKeyViolations,
      tableCounts: restored.tableCounts,
      tableCountsMatch: countsMatch,
    },
    probes,
    safety: {
      sourceModified: false,
      overwriteAllowed: false,
      reportContainsFilesystemPaths: false,
      runtimeMode: "isolated-local-mock-connectors",
    },
  };
}

export function formatRollbackDrillMarkdown(report) {
  const rows = Object.entries(report.database.tableCounts)
    .map(([name, count]) => `| ${name} | ${count} |`)
    .join("\n");
  const probes = report.probes
    .map((item) => `| ${item.path} | ${item.status} | ${item.ok ? "通过" : "失败"} | ${item.durationMs} ms |`)
    .join("\n");
  return `# AI统一需求平台数据库回滚演练报告

- 演练结果：**${report.result}**
- 开始时间：${report.startedAt}
- 完成时间：${report.finishedAt}
- 快照生成与校验：${report.snapshotDurationMs} ms
- 恢复并完成应用探针（RTO演练值）：${report.recoveryDurationMs} ms
- 总耗时：${report.totalDurationMs} ms
- 备份格式：${report.backup.format}
- 备份大小：${report.backup.bytes} bytes
- SHA-256：${report.backup.sha256}
- Schema版本：${report.database.schema.currentVersion}
- Schema兼容：${report.database.schema.compatible ? "是" : "否"}
- 完整性检查：${report.database.integrity.join(", ")}
- 外键违规：${report.database.foreignKeyViolations}
- 表计数一致：${report.database.tableCountsMatch ? "是" : "否"}

## 应用可用性探针

| 路径 | HTTP状态 | 结果 | 耗时 |
|---|---:|---|---:|
${probes}

## 恢复后表计数

| 表 | 记录数 |
|---|---:|
${rows}

## 安全边界

- 源数据库未被修改；恢复到全新的隔离目录。
- 演练拒绝覆盖已存在目录和数据库文件。
- 应用探针使用本地随机端口、模拟连接器和专用演练身份。
- 报告不包含数据库绝对路径、密钥、令牌或员工信息。
`;
}
