import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateDeploymentReference } from "../src/ops/deployment-reference.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = validateDeploymentReference({ projectRoot });

console.log(JSON.stringify(result, null, 2));
if (!result.valid) process.exitCode = 1;
