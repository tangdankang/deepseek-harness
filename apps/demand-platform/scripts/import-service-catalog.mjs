import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.mjs";
import { CatalogService } from "../src/services/catalog-service.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, "..");

function usage() {
  return [
    "用法：node scripts/import-service-catalog.mjs --file <catalog.json> [--database <db>] [--dry-run] [--imported-by <operator>] [--change-ref <change>] [--with-demo-seed]",
    "",
    "默认数据库：./data/demand-platform.db",
    "默认不写入演示服务；--dry-run 只校验版本和内容，不修改数据库。",
    "正式写入必须提供 --imported-by 和 --change-ref，或对应安全环境变量。",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { dryRun: false, withDemoSeed: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") result.dryRun = true;
    else if (argument === "--with-demo-seed") result.withDemoSeed = true;
    else if (["--file", "--database", "--imported-by", "--change-ref"].includes(argument)) {
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
    process.exitCode = 0;
  } else {
    if (!args.file) throw new Error("必须提供 --file");
    const filePath = path.resolve(process.cwd(), args.file);
    const requestedDatabasePath = path.resolve(process.cwd(), args.database ?? path.join(projectRoot, "data", "demand-platform.db"));
    const databasePath = args.dryRun && !fs.existsSync(requestedDatabasePath) ? ":memory:" : requestedDatabasePath;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const definitions = Array.isArray(parsed) ? parsed : parsed.services;
    db = openDatabase(databasePath, { seedDemo: args.withDemoSeed });
    const catalog = new CatalogService(db);
    const result = catalog.importDefinitions(definitions, {
      dryRun: args.dryRun,
      importedBy: args.importedBy ?? process.env.SERVICE_CATALOG_IMPORT_ACTOR,
      changeRef: args.changeRef ?? process.env.SERVICE_CATALOG_CHANGE_REF,
    });
    console.log(JSON.stringify({ file: path.basename(filePath), database: databasePath === ":memory:" ? ":memory:" : "REDACTED_DATABASE", ...result }, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({
    error: {
      code: error.code ?? "CATALOG_IMPORT_FAILED",
      message: error.message,
      details: error.details,
    },
  }, null, 2));
  process.exitCode = 1;
} finally {
  db?.close();
}
