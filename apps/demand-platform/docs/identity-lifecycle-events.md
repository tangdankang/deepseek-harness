# 身份生命周期事件桥接

## 目的与边界

钉钉通讯录、HR 或公司 IAM 不直接修改平台数据库。身份网关把源系统事件映射为本契约，并以独立密钥签名后调用：

```text
POST /api/v1/webhooks/identity/events
Content-Type: application/json
X-Identity-Event-Signature: <HMAC-SHA256 hex>
```

签名正文是实际发送的原始 UTF-8 JSON 字节，算法与业务 Webhook 相同，但必须使用独立的 `IDENTITY_EVENT_SECRET`。登录身份签名、一次性票据、业务 Webhook 和身份事件不得复用密钥。

## 统一事件契约

```json
{
  "schemaVersion": 1,
  "eventId": "IAM-20260817-000001",
  "sourceSystem": "company-identity-gateway",
  "employeeId": "E10001",
  "sequence": 42,
  "eventType": "ACCESS_SUSPENDED",
  "occurredAt": "2026-08-17T08:30:00.000Z",
  "reasonCode": "SECURITY_EVENT"
}
```

字段约束见 `config/identity-lifecycle-event.schema.json`。`sequence` 必须是同一员工在可信来源内严格递增的正整数；网关应使用源系统版本号，若源系统没有版本号，则由持久化事件适配器分配，不能使用进程内计数器。

| 事件类型 | 平台动作 | 访问状态 |
|---|---|---|
| `ACCESS_SUSPENDED` | 撤销全部有效会话 | 阻断 |
| `EMPLOYMENT_TERMINATED` | 撤销全部有效会话 | 阻断 |
| `ACCESS_RESTORED` | 撤销旧会话，要求重新登录 | 开放 |
| `MEMBERSHIP_CHANGED` | 撤销旧会话，重新获取部门关系 | 保持原状态 |
| `IDENTITY_PROFILE_CHANGED` | 撤销旧会话，重新获取姓名等资料 | 保持原状态 |

资料或成员关系变化不能解除已停用状态；只有更高序号的 `ACCESS_RESTORED` 可以恢复访问。阻断状态会在浏览器会话、签名身份头、一次性票据兑换和 DEAP 工具调用前统一检查。

## 防重放与顺序

- `(sourceSystem, eventId)` 唯一；相同正文重放返回 `duplicate: true`，不重复审计或撤销。
- 相同事件 ID 携带不同正文返回 `409 IDENTITY_EVENT_ID_REUSE`。
- 不高于员工最后序号的新事件返回 `409 IDENTITY_EVENT_OUT_OF_ORDER`。
- 默认拒绝超过 24 小时或领先平台时间 5 分钟以上的事件；接收时效由 `IDENTITY_EVENT_MAX_AGE_SECONDS` 配置，范围为 300–604800 秒。
- 已接收事件为不可修改、不可删除记录；每次首次应用都写入 HMAC 防篡改审计链。

## 钉钉/公司 IAM 映射

适配层只负责验证钉钉或 IAM 原始回调、归一化员工编号和事件类型、分配单调序号，再调用本入口。平台不假定钉钉租户的专有回调字段，也不把姓名、手机号、邮箱或完整通讯录复制进事件表。

推荐映射：

- 离职/删除成员 → `EMPLOYMENT_TERMINATED`
- 账号冻结/安全停用 → `ACCESS_SUSPENDED`
- 解冻/重新入职 → `ACCESS_RESTORED`
- 主部门、兼职或矩阵部门改变 → `MEMBERSHIP_CHANGED`
- 姓名等身份展示信息改变 → `IDENTITY_PROFILE_CHANGED`

网关收到源事件后应先持久化，再按员工顺序投递；平台返回 5xx 时重试同一 `eventId` 和完全相同正文。4xx 表示契约、签名、时效或顺序问题，应进入死信队列人工处理，不能自动生成新事件 ID 绕过。

## 生产配置与验收

```text
IDENTITY_EVENT_SECRET=<至少32位独立随机值>
IDENTITY_EVENT_SOURCE=company-identity-gateway
IDENTITY_EVENT_MAX_AGE_SECONDS=86400
```

联调至少验证停用、恢复、调岗、重复投递、乱序投递、签名篡改、停用后浏览器请求、停用后 DEAP 工具调用和审计记录。生产部署还需在公司 API 网关限制来源网络，并把拒绝率接入监控。

使用专用测试员工执行自动联调：

```powershell
$env:IDENTITY_EVENT_SECRET='<从密钥系统注入>'
$env:IDENTITY_HMAC_SECRET='<从密钥系统注入>'
$env:TOOL_API_KEY='<从密钥系统注入>'
node scripts/run-identity-lifecycle-conformance.mjs `
  --base-url https://approved-test.example `
  --allow-write --allow-remote-write --confirm-test-employee `
  --test-employee-id E-IAM-CONFORMANCE `
  --starting-sequence 1000 `
  --output-json work/identity-lifecycle-conformance.json
```

`--starting-sequence` 必须高于该测试员工在平台已经处理的序号。执行器无论中途是否失败都会尽力投递预生成的恢复事件，并在报告的 `recovery` 字段记录清理结果；`recovery.outcome` 不是 `PASS` 时必须立即由 IAM 负责人确认测试账号状态。
