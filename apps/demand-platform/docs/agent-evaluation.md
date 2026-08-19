# Agent 评测执行

## 结构校验

```powershell
node scripts/run-agent-evals.mjs `
  --file ..\DEAP组织中心Agent-评测集-v0.1.jsonl `
  --validate-only
```

校验内容包括必填键、ID 唯一性、严重级别、输入、预期断言以及 `mustContain`/`mustNotContain` 冲突。

## 调用 Agent 端点

```powershell
node scripts/run-agent-evals.mjs `
  --file evals/mvp-smoke.jsonl `
  --endpoint http://127.0.0.1:8787/api/v1/assistant/messages `
  --employee-id E-EVAL `
  --department-id D-ORG `
  --strict
```

结果状态：

- `PASS`：所有可自动判定的断言通过，且没有未实现断言；
- `FAIL`：至少一个确定性断言失败；
- `PARTIAL`：可自动断言通过，但仍有需要模型裁判或人工复核的预期项；
- `SKIP`：用例需要预置知识、身份或工具条件，当前未启用；
- `ERROR`：端点或响应处理失败。

评测器不会把无法确定的“事实正确性、是否编造、知识冲突”等项目假装为自动通过。真实 DEAP 环境需要预置 `preconditions` 后使用 `--include-preconditions`，并为 `PARTIAL` 用例增加人工或经批准的模型裁判。

`evals/mvp-smoke.jsonl` 是本地演示回归集；公司级 27 条评测集位于输出目录，真实 Prompt、知识或工具每次发布前均应执行。
