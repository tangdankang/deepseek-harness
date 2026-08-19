# DEAP 工具链联调验收

公开资料不足以证明公司租户当前使用的 DEAP/AI 助理版本、Response API 或技能回调协议，因此平台不实现猜测性的消息适配器。稳定边界是 `docs/openapi.json` 中的 13 个工具；租户或公司技能网关只需完成该 OpenAPI 契约的映射。

## 两种模式

只读模式不会创建需求、工单、人工事项或反馈，验证：

- 缺少 Tool Key 时拒绝；
- 伪造员工签名时拒绝；
- 工具调用编号重放时拒绝；
- 员工上下文、服务检索、Schema、知识检索和草稿校验；
- 响应状态、调用编号和 Trace ID。

```powershell
$env:TOOL_API_KEY='<通过公司安全通道注入>'
$env:IDENTITY_HMAC_SECRET='<通过公司安全通道注入>'
node scripts\run-deap-tool-conformance.mjs `
  --base-url https://test-ai-demand.example.internal `
  --output-json work\deap-readonly-report.json `
  --output-markdown work\deap-readonly-report.md
```

全量模式覆盖 13 个工具，并真实创建测试需求、验证引导式填单不会自动提交、创建下游工单、人工事项和结构化反馈。必须显式提供 `--allow-write`、服务编号和经过 Owner 批准的脱敏字段文件；目标不是 localhost 时还必须增加 `--allow-remote-write`。

```powershell
node scripts\run-deap-tool-conformance.mjs `
  --base-url https://test-ai-demand.example.internal `
  --allow-write --allow-remote-write `
  --service-code CRM_ACCOUNT_CHANGE `
  --fields-file config\deap-conformance-fields.example.json `
  --employee-id E-DEAP-CONFORMANCE `
  --department-id D-ORG `
  --output-json work\deap-full-report.json `
  --output-markdown work\deap-full-report.md
```

命令行参数只接受环境变量名称，不接受密钥值。凭据不能写入命令历史、报告、字段文件或截图。

## 调用追踪

技能网关应为每个 HTTP 尝试生成唯一 `X-Tool-Invocation-Id`。重复编号会在业务执行前返回 `409 TOOL_INVOCATION_REPLAY`；写工具仍需传业务幂等键，以处理“下游成功但响应未知”等情况。

平台只保存：调用编号、operationId、不可逆员工摘要、部门、结果、HTTP 状态、错误码、耗时、Trace ID 和时间。不保存工具请求/响应正文、员工编号、确认令牌或业务字段。运营人员可在 `/admin` 的“Agent调用”页查询；记录保留期由 `TOOL_INVOCATION_RETENTION_DAYS` 控制。

## 验收证据

真实 DEAP 联调通过必须同时具备：

1. 联调器 `PASS` JSON/Markdown 报告；
2. DEAP 租户侧同一调用编号的技能执行日志；
3. 平台“Agent调用”页或 API 的对应记录；
4. 下游系统中同一测试需求的工单或对账证据；
5. 缺凭据、伪造身份、重放、跨员工查询和未确认提交的负向证据；
6. 租户管理员、平台 Owner 和首个系统 Owner 的联调确认。

本地联调器通过只能证明平台边界，不证明公司租户已经完成接入。
