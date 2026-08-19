import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.mjs";
import { KnowledgeService } from "../src/services/knowledge-service.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, "..");
const MAX_CATALOG_BYTES = 20 * 1024 * 1024;

function usage() {
  return [
    "用法：node scripts/import-knowledge-catalog.mjs (--file <knowledge.json> | --stdin) [--source-name <name>] [--database <db>] [--dry-run] [--imported-by <operator>] [--with-demo-seed]",
    "",
    "正式写入必须提供 --imported-by 或 KNOWLEDGE_IMPORT_ACTOR；--dry-run 不修改数据库。",
    "来源文件的SHA-256应使用Python白名单读取到的逻辑内容计算，凭据不得写入知识目录。",
    "SafeNet环境请优先使用tools/import_knowledge_catalog.py，它通过内存管道调用本命令的--stdin模式。",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { dryRun: false, withDemoSeed: false, stdin: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") result.dryRun = true;
    else if (argument === "--with-demo-seed") result.withDemoSeed = true;
    else if (argument === "--stdin") result.stdin = true;
    else if (["--file", "--database", "--imported-by", "--source-name"].includes(argument)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} 缺少参数`);
      result[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
    } else if (argument === "--help" || argument === "-h") result.help = true;
    else throw new Error(`未知参数：${argument}`);
  }
  return result;
}

let db;
try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
  } else {
    if (Boolean(args.file) === Boolean(args.stdin)) throw new Error("必须且只能选择 --file 或 --stdin");
    const filePath = args.file ? path.resolve(process.cwd(), args.file) : null;
    const requestedDatabasePath = path.resolve(process.cwd(), args.database ?? path.join(projectRoot, "data", "demand-platform.db"));
    const databasePath = args.dryRun && !fs.existsSync(requestedDatabasePath) ? ":memory:" : requestedDatabasePath;
    if (filePath && fs.statSync(filePath).size > MAX_CATALOG_BYTES) throw new Error("知识目录超过20MB上限");
    const rawCatalog = args.stdin ? fs.readFileSync(0, "utf8") : fs.readFileSync(filePath, "utf8");
    if (Buffer.byteLength(rawCatalog) > MAX_CATALOG_BYTES) throw new Error("知识目录逻辑内容超过20MB上限");
    const parsed = JSON.parse(rawCatalog);
    const definitions = Array.isArray(parsed) ? parsed : parsed.knowledge;
    db = openDatabase(databasePath, { seedDemo: args.withDemoSeed });
    const knowledge = new KnowledgeService(db);
    const result = knowledge.importDefinitions(definitions, {
      dryRun: args.dryRun,
      importedBy: args.importedBy ?? process.env.KNOWLEDGE_IMPORT_ACTOR,
    });
    const sourceName = args.stdin ? path.basename(args.sourceName ?? "PYTHON_STDIN") : path.basename(filePath);
    console.log(JSON.stringify({ file: sourceName, database: databasePath === ":memory:" ? ":memory:" : "REDACTED_DATABASE", ...result }, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({ error: { code: error.code ?? "KNOWLEDGE_IMPORT_FAILED", message: error.message, details: error.details } }, null, 2));
  process.exitCode = 1;
} finally {
  db?.close();
}
