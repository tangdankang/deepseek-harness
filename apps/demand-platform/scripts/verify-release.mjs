import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEvalJsonl } from "../src/evals/agent-eval-runner.mjs";
import { validateDeploymentReference } from "../src/ops/deployment-reference.mjs";
import { loadConnectorConfiguration, validateConnectorConfiguration } from "../src/connectors/http-json-connector.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputIndex = process.argv.indexOf("--output-json");
const outputJson = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
if (outputIndex >= 0 && !outputJson) throw new Error("--output-json缺少路径");

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: projectRoot, encoding: "utf8" });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`命令失败：node ${args.join(" ")}`);
  return result.stdout ?? "";
}

function runPython(args) {
  const executable = process.env.PYTHON ?? "python";
  const result = spawnSync(executable, args, { cwd: projectRoot, encoding: "utf8" });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`Python命令失败：${args.join(" ")}`);
  return result.stdout ?? "";
}

const codeFiles = ["src", "scripts", "public", "test"]
  .flatMap((directory) => walk(path.join(projectRoot, directory)))
  .filter((file) => [".js", ".mjs"].includes(path.extname(file)));
for (const file of codeFiles) run(["--check", file]);

const openapi = JSON.parse(fs.readFileSync(path.join(projectRoot, "docs", "openapi.json"), "utf8"));
const operationIds = Object.values(openapi.paths).flatMap((item) => Object.values(item).map((operation) => operation.operationId));
const invocationTrackedOperations = Object.values(openapi.paths).flatMap((item) => Object.values(item))
  .filter((operation) => operation.parameters?.some((parameter) => parameter.$ref === "#/components/parameters/ToolInvocationId"));
if (invocationTrackedOperations.length !== operationIds.length) throw new Error("OpenAPI tools must all declare ToolInvocationId correlation");
if (operationIds.some((id) => !id) || new Set(operationIds).size !== operationIds.length) throw new Error("OpenAPI operationId缺失或重复");

const localEvals = parseEvalJsonl(fs.readFileSync(path.join(projectRoot, "evals", "mvp-smoke.jsonl"), "utf8"));
const fullEvalPath = path.resolve(projectRoot, "..", "DEAP组织中心Agent-评测集-v0.1.jsonl");
const fullEvals = fs.existsSync(fullEvalPath) ? parseEvalJsonl(fs.readFileSync(fullEvalPath, "utf8")) : [];

const runtimeFiles = ["src", "public"].flatMap((directory) => walk(path.join(projectRoot, directory)));
const suspicious = [];
const secretPattern = /(api[_-]?key|secret|token|password)\s*[:=]\s*["'][A-Za-z0-9_-]{20,}/gi;
for (const file of runtimeFiles) {
  const content = fs.readFileSync(file, "utf8");
  for (const match of content.matchAll(secretPattern)) {
    if (!/dev-only|replace-with|test-/i.test(match[0])) suspicious.push({ file: path.relative(projectRoot, file), sample: match[0].slice(0, 40) });
  }
}
if (suspicious.length > 0) throw new Error(`运行源码疑似包含硬编码密钥：${JSON.stringify(suspicious)}`);

const deploymentReference = validateDeploymentReference({ projectRoot });
if (!deploymentReference.valid) throw new Error(`部署参考校验失败：${JSON.stringify(deploymentReference.findings)}`);
const connectorConfiguration = validateConnectorConfiguration(
  loadConnectorConfiguration(path.join(projectRoot, "deploy", "connectors.production.example.json")),
  { productionMode: true },
);

run(["scripts/import-service-catalog.mjs", "--file", "config/service-catalog.example.json", "--dry-run"]);
run(["scripts/import-organization-directory.mjs", "--file", "config/organization-directory.example.json", "--dry-run"]);
run(["scripts/import-knowledge-catalog.mjs", "--file", "config/knowledge-catalog.example.json", "--dry-run"]);
runPython(["tools/build_knowledge_draft.py", "--self-test"]);
runPython(["tools/import_knowledge_catalog.py", "--self-test"]);
runPython(["tools/audit_p0_intake.py", "--self-test"]);
run(["scripts/run-agent-evals.mjs", "--file", "evals/mvp-smoke.jsonl", "--validate-only"]);
if (fullEvals.length > 0) run(["scripts/run-agent-evals.mjs", "--file", fullEvalPath, "--validate-only"]);
const testFiles = walk(path.join(projectRoot, "test")).filter((file) => file.endsWith(".test.mjs"));
const testOutput = run(["--test", "--test-concurrency=1", ...testFiles]);
const testCountMatch = [...testOutput.matchAll(/(?:^|\n)ℹ tests (\d+)/g)].at(-1);
if (!testCountMatch) throw new Error("无法从测试运行输出提取自动化测试总数");
const automatedTests = Number(testCountMatch[1]);

const report = {
  releaseVerification: "PASS",
  reportType: "AI_DEMAND_PLATFORM_RELEASE_VERIFICATION",
  reportVersion: 1,
  releaseVersion: JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")).version,
  generatedAt: new Date().toISOString(),
  syntaxFiles: codeFiles.length,
  automatedTests,
  openapiOperations: operationIds.length,
  openapiInvocationTrackedOperations: invocationTrackedOperations.length,
  localEvalCases: localEvals.length,
  fullEvalCases: fullEvals.length,
  pythonKnowledgePipelineSelfTests: 2,
  pythonIntakeSelfTests: 1,
  runtimeSecretFindings: suspicious.length,
  deploymentReferenceChecks: deploymentReference.checks,
  connectorConfigSystems: connectorConfiguration.systems,
  connectorServiceMappings: connectorConfiguration.serviceMappings,
};
if (outputJson) {
  const resolved = path.resolve(outputJson);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}
console.log(JSON.stringify(report, null, 2));
