import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateProductionReadiness, productionReadinessMarkdown } from "../src/release/production-readiness.mjs";

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function writeNew(target, content) {
  const resolved = path.resolve(target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, { encoding: "utf8", flag: "wx" });
}

try {
  const manifestArgument = option("--manifest");
  if (!manifestArgument) throw new Error("必须提供--manifest");
  const manifestPath = path.resolve(manifestArgument);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const packageDocument = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const report = evaluateProductionReadiness({ manifest, manifestPath, expectedReleaseVersion: packageDocument.version });
  const outputJson = option("--output-json");
  const outputMarkdown = option("--output-markdown");
  if (outputJson) writeNew(outputJson, `${JSON.stringify(report, null, 2)}\n`);
  if (outputMarkdown) writeNew(outputMarkdown, productionReadinessMarkdown(report));
  console.log(JSON.stringify(report, null, 2));
  if (report.decision !== "GO") process.exitCode = report.decision === "NO_GO" ? 2 : 3;
} catch (error) {
  console.error(JSON.stringify({ error: { code: "PRODUCTION_READINESS_FAILED", message: error.message } }, null, 2));
  process.exitCode = 1;
}
