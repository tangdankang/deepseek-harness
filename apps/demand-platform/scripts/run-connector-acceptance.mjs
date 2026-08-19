import fs from "node:fs";
import path from "node:path";
import { loadConnectorConfiguration } from "../src/connectors/http-json-connector.mjs";
import { connectorAcceptanceMarkdown, runConnectorAcceptance } from "../src/conformance/connector-acceptance.mjs";

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
  const configPath = option("--config");
  const fixturePath = option("--fixture");
  if (!configPath || !fixturePath) throw new Error("必须提供--config和--fixture");
  const configuration = loadConnectorConfiguration(path.resolve(configPath));
  const fixture = JSON.parse(fs.readFileSync(path.resolve(fixturePath), "utf8"));
  const allowWrite = process.argv.includes("--allow-write");
  if (allowWrite) {
    const definition = configuration.connectors.find((item) => item.systemCode === fixture.systemCode);
    if (!definition) throw new Error("找不到夹具指定的连接器");
    const target = new URL(definition.baseUrl);
    const remote = !["127.0.0.1", "localhost", "::1", "[::1]"].includes(target.hostname);
    if (remote && !process.argv.includes("--allow-remote-write")) throw new Error("远程测试环境写入必须同时提供--allow-remote-write");
    if (target.protocol !== "https:" && remote) throw new Error("远程验收仅允许HTTPS");
  }
  const report = await runConnectorAcceptance({
    configuration,
    fixture,
    env: process.env,
    allowWrite,
    productionMode: !process.argv.includes("--non-production"),
  });
  const outputJson = option("--output-json");
  const outputMarkdown = option("--output-markdown");
  if (outputJson) writeNew(outputJson, `${JSON.stringify(report, null, 2)}\n`);
  if (outputMarkdown) writeNew(outputMarkdown, connectorAcceptanceMarkdown(report));
  console.log(JSON.stringify(report, null, 2));
  if (report.outcome === "FAIL") process.exitCode = 1;
  if (report.outcome === "NOT_READY") process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ error: { code: error.code ?? "CONNECTOR_ACCEPTANCE_FAILED", message: error.message } }, null, 2));
  process.exitCode = 1;
}
