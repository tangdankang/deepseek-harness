import path from "node:path";
import { createApplication } from "../src/server.mjs";

function value(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

let app;
try {
  const database = value("--database") ?? process.env.DATABASE_PATH;
  const connectorConfig = value("--connector-config") ?? process.env.CONNECTOR_CONFIG_PATH;
  if (!database || !connectorConfig) throw new Error("必须提供--database和--connector-config，或设置对应环境变量");
  app = createApplication({ databasePath: path.resolve(database), connectorConfigPath: path.resolve(connectorConfig) });
  const result = await app.services.demands.reconcileExternalTickets({ limit: Number(value("--limit") ?? 20), systemCode: value("--system") });
  console.log(JSON.stringify({ time: new Date().toISOString(), database: path.resolve(database), ...result }, null, 2));
  if (result.failed > 0) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ error: { code: error.code ?? "RECONCILIATION_FAILED", message: error.message, details: error.details } }, null, 2));
  process.exitCode = 1;
} finally {
  await app?.close();
}
