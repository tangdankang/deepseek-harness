import path from "node:path";
import { loadConnectorConfiguration, validateConnectorConfiguration } from "../src/connectors/http-json-connector.mjs";

function value(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

try {
  const file = value("--file");
  if (!file) throw new Error("必须提供--file");
  const report = validateConnectorConfiguration(loadConnectorConfiguration(path.resolve(file)), { productionMode: process.argv.includes("--production") });
  console.log(JSON.stringify({ file: path.resolve(file), mode: process.argv.includes("--production") ? "production" : "development", ...report }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: { code: error.code ?? "CONNECTOR_CONFIG_INVALID", message: error.message, details: error.details } }, null, 2));
  process.exitCode = 1;
}
