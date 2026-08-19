import path from "node:path";
import { openDatabase } from "../src/db.mjs";
import { createDataRetentionHold, hashLifecycleActor, releaseDataRetentionHold } from "../src/ops/data-lifecycle.mjs";

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

try {
  if (!process.argv.includes("--allow-hold-change")) throw new Error("保留冻结变更必须提供--allow-hold-change");
  const database = option("--database");
  const action = option("--action");
  const actorId = option("--actor-id");
  if (!database || !["create", "release"].includes(action) || !actorId) throw new Error("必须提供--database、--action create|release和--actor-id");
  const actorHash = hashLifecycleActor(actorId, process.env[option("--actor-hash-secret-env", "LIFECYCLE_HASH_SECRET")]);
  const db = openDatabase(path.resolve(database), { seedDemo: false });
  let result;
  try {
    result = action === "create"
      ? createDataRetentionHold({ db, scope: option("--scope"), reasonCode: option("--reason-code"), changeRef: option("--change-ref"), actorHash })
      : releaseDataRetentionHold({ db, holdId: option("--hold-id"), changeRef: option("--change-ref"), actorHash });
  } finally { db.close(); }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: { code: error.code ?? "RETENTION_HOLD_CHANGE_FAILED", message: error.message } }, null, 2));
  process.exitCode = 1;
}
