import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createApplication } from "../src/server.mjs";
import { parseEvalJsonl, runAgentEvals } from "../src/evals/agent-eval-runner.mjs";

test("Agent评测器可执行MVP冒烟集并产出确定性报告", async (t) => {
  const app = createApplication({
    databasePath: ":memory:",
    confirmationSecret: "test-eval-confirmation-secret",
    webhookSecret: "test-eval-webhook-secret",
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.db.close();
  });
  const cases = parseEvalJsonl(fs.readFileSync(new URL("../evals/mvp-smoke.jsonl", import.meta.url), "utf8"));
  const address = app.server.address();
  const report = await runAgentEvals(cases, {
    endpoint: `http://127.0.0.1:${address.port}/api/v1/assistant/messages`,
    headers: { "X-Employee-Id": "E-EVAL", "X-Department-Id": "D-ORG" },
  });
  assert.deepEqual(report.summary, { total: 3, PASS: 3, FAIL: 0, PARTIAL: 0, SKIP: 0, ERROR: 0 });
});

test("Agent评测器拒绝重复ID和相互冲突的断言", () => {
  const duplicate = [
    { id: "CASE-001", category: "x", severity: "normal", input: "a", expected: { type: "ANSWER" } },
    { id: "CASE-001", category: "x", severity: "normal", input: "b", expected: { type: "ANSWER" } },
  ].map(JSON.stringify).join("\n");
  assert.throws(() => parseEvalJsonl(duplicate), (error) => error.code === "INVALID_EVAL_SET");

  const conflict = JSON.stringify({ id: "CASE-002", category: "x", severity: "high", input: "a", expected: { mustContain: ["x"], mustNotContain: ["x"] } });
  assert.throws(() => parseEvalJsonl(conflict), (error) => error.code === "INVALID_EVAL_SET");
});
