import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.mjs";
import { OrganizationDirectoryService } from "../src/services/organization-directory-service.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, "..");

function usage() {
  return [
    "用法：node scripts/import-organization-directory.mjs --file <organization.json> [--database <db>] [--dry-run] [--imported-by <operator>] [--change-ref <change>]",
    "",
    "默认数据库：./data/demand-platform.db；正式写入必须提供操作人和变更单。",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") result.dryRun = true;
    else if (["--file", "--database", "--imported-by", "--change-ref"].includes(argument)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} 缺少参数`);
      result[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
    } else if (["--help", "-h"].includes(argument)) result.help = true;
    else throw new Error(`未知参数：${argument}`);
  }
  return result;
}

let db;
try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) console.log(usage());
  else {
    if (!args.file) throw new Error("必须提供 --file");
    const filePath = path.resolve(process.cwd(), args.file);
    const requestedDatabasePath = path.resolve(process.cwd(), args.database ?? path.join(projectRoot, "data", "demand-platform.db"));
    const databasePath = args.dryRun && !fs.existsSync(requestedDatabasePath) ? ":memory:" : requestedDatabasePath;
    db = openDatabase(databasePath, { seedDemo: false });
    const directory = new OrganizationDirectoryService(db);
    const result = directory.importSnapshot(JSON.parse(fs.readFileSync(filePath, "utf8")), {
      dryRun: args.dryRun,
      importedBy: args.importedBy ?? process.env.ORGANIZATION_IMPORT_ACTOR,
      changeRef: args.changeRef ?? process.env.ORGANIZATION_CHANGE_REF,
    });
    console.log(JSON.stringify({ file: path.basename(filePath), database: databasePath === ":memory:" ? ":memory:" : "REDACTED_DATABASE", ...result }, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({ error: { code: error.code ?? "ORGANIZATION_IMPORT_FAILED", message: error.message, details: error.details } }, null, 2));
  process.exitCode = 1;
} finally {
  db?.close();
}
