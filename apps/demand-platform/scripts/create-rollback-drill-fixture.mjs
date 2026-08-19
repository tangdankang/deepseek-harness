import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "../src/db.mjs";

const argv = process.argv.slice(2);
if (argv.length !== 2 || argv[0] !== "--output") throw new Error("用法：node scripts/create-rollback-drill-fixture.mjs --output <新数据库路径>");
const output = path.resolve(argv[1]);
if (fs.existsSync(output)) throw new Error("输出数据库已存在，拒绝覆盖");
const db = openDatabase(output);
try {
  db.prepare("INSERT INTO audit_events (case_id, actor_type, actor_id, action, outcome, details_json, trace_id, created_at) VALUES (NULL, 'SYSTEM', 'RELEASE_V09', 'PRE_RELEASE_SNAPSHOT', 'SUCCESS', '{}', NULL, ?)")
    .run(new Date().toISOString());
} finally {
  db.close();
}
console.log(JSON.stringify({ created: true, database: path.basename(output), containsSecrets: false }, null, 2));
