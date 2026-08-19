# API 调用示例

以下示例假设服务运行于 `http://127.0.0.1:8787`。

生产浏览器先通过身份网关获得一次性票据，再由平台创建会话：

```powershell
$exchangeBody = @{ exchangeTicket = '<由公司身份网关签发的短期单次票据>' } | ConvertTo-Json
Invoke-WebRequest -Method Post -ContentType 'application/json' -SessionVariable employeeSession `
  -Uri 'http://127.0.0.1:8787/api/v1/auth/session' -Body $exchangeBody
```

票据属于一次性认证凭据，不得放入命令历史、截图、源码或工单；上例仅展示请求结构。

## 1. 查询服务目录

```powershell
$headers = @{
  'X-Employee-Id'='E10001'
  'X-Department-Id'='D-ORG'
  'X-Employee-Name'='演示员工'
}
Invoke-RestMethod -Headers $headers -Uri 'http://127.0.0.1:8787/api/v1/services?query=CRM'
```

## 2. 创建草稿

```powershell
$body = @{
  serviceCode = 'CRM_ACCOUNT_CHANGE'
  fields = @{
    customerCode = 'C000123'
    newOwnerEmployeeId = 'E20002'
  }
} | ConvertTo-Json -Depth 5

$draft = Invoke-RestMethod -Method Post -Headers $headers -ContentType 'application/json' `
  -Uri 'http://127.0.0.1:8787/api/v1/cases/drafts' -Body $body
$draft
```

返回结果会包含 `missingFields`，状态为 `WAITING_INFORMATION`。

## 3. 补齐字段

```powershell
$patchBody = @{
  expectedVersion = $draft.case.version
  fields = @{
    reason = '区域职责调整'
    effectiveDate = '2026-08-20'
  }
} | ConvertTo-Json -Depth 5

$updated = Invoke-RestMethod -Method Patch -Headers $headers -ContentType 'application/json' `
  -Uri "http://127.0.0.1:8787/api/v1/cases/$($draft.case.globalRequestNo)/draft" -Body $patchBody
```

## 4. 生成预览与确认令牌

```powershell
$confirmation = Invoke-RestMethod -Method Post -Headers $headers -ContentType 'application/json' `
  -Uri "http://127.0.0.1:8787/api/v1/cases/$($draft.case.globalRequestNo)/prepare-confirmation" -Body '{}'
```

## 5. 幂等提交

```powershell
$submitBody = @{
  draftVersion = $confirmation.case.version
  confirmationToken = $confirmation.confirmationToken
  idempotencyKey = "$($draft.case.globalRequestNo)-v$($confirmation.case.version)-submit"
} | ConvertTo-Json

$submitted = Invoke-RestMethod -Method Post -Headers $headers -ContentType 'application/json' `
  -Uri "http://127.0.0.1:8787/api/v1/cases/$($draft.case.globalRequestNo)/submit" -Body $submitBody
```

重复执行同一个提交请求会返回相同下游工单，不会创建第二张工单。

员工网页使用同一服务端引导能力：`POST /api/v1/guided-intake/turn`。该接口使用员工会话或可信身份上下文，不接受DEAP工具密钥；请求阶段与 `guided_request_turn` 相同。`COLLECT`只更新草稿，`CONFIRM_SUBMIT`必须包含 `employeeConfirmed: true`。

## 6. 模拟下游状态回传

Webhook 需要对原始 JSON 字符串计算 HMAC-SHA256：

```powershell
$event = @{
  eventId = 'evt-demo-001'
  ticketNo = $submitted.externalTickets[0].ticketNo
  rawStatus = 'RESOLVED'
  occurredAt = (Get-Date).ToString('o')
} | ConvertTo-Json -Compress

# 签名请由下游或联调脚本按 MOCK_WEBHOOK_SECRET 对原始 UTF-8 body 计算。
```

## DEAP 工具映射

| Agent技能 | HTTP端点 |
|---|---|
| `search_service_catalog` | `POST /api/v1/tools/search-service-catalog` |
| `get_service_form_schema` | `POST /api/v1/tools/get-service-form-schema` |
| `validate_request_draft` | `POST /api/v1/tools/validate-request-draft` |
| `guided_request_turn` | `POST /api/v1/tools/guided-request-turn` |
| `prepare_confirmation` | `POST /api/v1/tools/prepare-confirmation` |
| `submit_request` | `POST /api/v1/tools/submit-request` |
| `get_request_status` | `POST /api/v1/tools/get-request-status` |

工具网关必须使用服务端员工安全上下文；模型提供的员工编号不得作为授权依据。

每次工具 HTTP 尝试建议携带唯一的 `X-Tool-Invocation-Id`（8–128 位受限字符）。平台会在成功或已完成身份鉴权的失败响应中原样返回该编号；重复编号返回 `409 TOOL_INVOCATION_REPLAY`。未携带时平台自动生成。该编号用于追踪和请求防重放，不能替代 `submit_request`、`handoff_to_human` 等写工具的业务幂等键。

## 员工生命周期事件

IAM/HR/钉钉适配器使用独立事件密钥调用 `POST /api/v1/webhooks/identity/events`。签名是对原始 JSON 正文计算的 HMAC-SHA256 十六进制结果，并放入 `X-Identity-Event-Signature`：

```json
{
  "schemaVersion": 1,
  "eventId": "IAM-20260817-000001",
  "sourceSystem": "company-identity-gateway",
  "employeeId": "E10001",
  "sequence": 42,
  "eventType": "EMPLOYMENT_TERMINATED",
  "occurredAt": "2026-08-17T08:30:00.000Z",
  "reasonCode": "EMPLOYEE_LEFT"
}
```

完整的事件映射、重试和顺序规则见 `identity-lifecycle-events.md`。管理接口 `/api/v1/admin/auth-sessions/revoke` 继续用于人工应急撤销，但不会建立持续阻断状态。

多部门员工由身份网关增加 `X-Identity-Version=v2` 与 `X-Department-Ids=D-ORG,D-PROJECT`，并按 `session-auth.md` 将规范化部门数组和员工姓名一起签名。不得在客户端自行追加该头。

实际事件密钥和 `X-Admin-Key` 只能由密钥管理系统注入，不得写入脚本或资料包。
