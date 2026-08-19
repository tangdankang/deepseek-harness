# 可配置 HTTP JSON 连接器

该连接器用于把统一需求平台的已确认需求映射为公司业务系统的 JSON 建单请求。它不是“万能 API 猜测器”：只有取得下游正式字段、鉴权、幂等、状态和错误码后，才能形成真实连接器配置。

## 当前能力

- 异步 HTTP `POST`/`PUT` 建单和可选 `GET` 查单；
- 按服务项配置请求字段映射和常量；
- Bearer Token 或自定义请求头鉴权，配置文件只引用环境变量名；
- 统一幂等请求头；
- 下游响应字段与状态映射；
- 超时、限流、鉴权、业务拒绝、幂等冲突、5xx、重定向和契约错误分类；
- 响应体大小上限、HTTPS 生产门禁、同源固定路径和禁止危险请求头；
- 与持久化 Outbox、指数退避、死信、运营重试和员工“已安全受理”语义集成。

状态更新支持两条路径：下游调用平台现有签名 Webhook，或配置 `getTicket` 后由受控对账任务主动查询。附件、评论和取消仍需根据首个真实系统接口扩展，不能在配置中伪造为已支持。

## 配置校验

参考文件：`deploy/connectors.production.example.json`

```powershell
node scripts/validate-connector-config.mjs `
  --file deploy/connectors.production.example.json `
  --production
```

校验只检查结构和安全约束，不读取或验证真实凭据，也不会调用下游。运行应用时才从 `auth.envVar` 指定的环境变量读取凭据；变量缺失时拒绝启动连接器。

## 请求映射

每个服务项单独配置 `requestMapping`：目标路径在左，受控请求上下文在右。

```json
{
  "global_request_no": "case.globalRequestNo",
  "ticket_type": { "value": "ACCOUNT_CHANGE" },
  "requester.employee_id": "requester.employeeId",
  "payload.customer_no": "fields.customerCode",
  "payload.note": {
    "from": "fields.note",
    "required": false,
    "default": ""
  }
}
```

允许读取的根对象只有：

- `case`：统一需求编号、服务编码和需求状态等；
- `service`：已发布服务目录定义；
- `fields`：经服务 Schema 校验的员工确认字段；
- `requester`：由可信身份链路生成的员工上下文。

映射不执行表达式、脚本或任意模板，不允许访问环境变量、文件、原型链或未受控对象。员工 ID 到下游账号的真实映射应由受控主数据服务处理，不应只相信员工输入字段。

## 响应与状态映射

下游成功响应必须为 JSON 对象，并通过 `responseMapping` 提取：

```json
{
  "ticketNo": "data.ticket_no",
  "rawStatus": "data.status",
  "ticketUrl": "data.ticket_url"
}
```

`ticketNo` 和 `rawStatus` 必填；`ticketUrl` 可选，只允许 HTTP(S)，生产只允许 HTTPS。原始状态由显式 `statusMapping` 转换为平台统一状态；未知状态按 `unknownStatus` 处理并应配置告警。

## 错误策略

| 下游结果 | 平台错误码 | 自动重试 |
|---|---|---|
| 超时且结果未知 | `DOWNSTREAM_TIMEOUT_UNKNOWN_RESULT` | 是；必须依赖下游幂等键 |
| 网络错误/5xx | `DOWNSTREAM_UNAVAILABLE` | 是 |
| 429 | `DOWNSTREAM_RATE_LIMITED` | 是 |
| 401/403 | `DOWNSTREAM_AUTHORIZATION_ERROR` | 否；告警凭据/权限负责人 |
| 400/404/422 | `DOWNSTREAM_BUSINESS_ERROR` | 否；修正字段或规则 |
| 409 | `IDEMPOTENCY_CONFLICT` | 否；人工对账 |
| 3xx | `DOWNSTREAM_REDIRECT_REJECTED` | 否；禁止跟随到未审计目标 |
| 非 JSON、缺少编号/状态、响应过大 | `DOWNSTREAM_CONTRACT_ERROR` | 否；熔断并处理契约变化 |

连接器不会把下游响应正文、Token 或请求字段值写入员工错误信息。运营端可查看安全错误码和 HTTP 状态，敏感诊断仍应进入公司受控日志平台。

## 主动查单与对账

下游没有 Webhook，或需要每日兜底对账时，可在连接器中配置：

```json
{
  "getTicket": {
    "pathTemplate": "/api/v1/tickets/{ticketNo}",
    "method": "GET",
    "headers": { "X-Client-System": "AI_DEMAND_PLATFORM" },
    "responseMapping": {
      "ticketNo": "data.ticket_no",
      "rawStatus": "data.status",
      "ticketUrl": "data.ticket_url"
    }
  }
}
```

一次对账：

```powershell
node scripts/reconcile-external-tickets.mjs `
  --database data/demand-platform.db `
  --connector-config deploy/connectors.production.json `
  --system CRM `
  --limit 20
```

也可由受独立管理密钥保护的接口触发：

```text
POST /api/v1/admin/external-tickets/reconcile
```

对账只选择未关闭/未拒绝/未取消的本地工单，串行调用下游查单；状态变化在同一事务中更新外部工单和统一需求，并写审计。单张查询失败不会阻断本批其他工单，结果只返回安全错误码。生产建议由公司调度平台定时执行，避免在 API 进程内建立不可控定时器。

## 生产门禁

- `NODE_ENV=production` 时没有真实连接器配置会拒绝启动，不能隐式使用 Mock 连接器；
- 生产只允许 HTTPS 和受支持的鉴权方式；
- 配置文件出现未知项（例如直接写 `token`、`password`）会拒绝；
- `Host`、`Content-Length`、转发头等危险请求头不能配置；
- 重定向不会自动跟随；
- `deploy/.env.production` 和 `deploy/connectors.production.json` 已加入 Git/Docker 忽略列表；
- 只有示例文件可进入源码包，真实配置和凭据必须由公司配置中心/KMS挂载。

## 首个系统联调步骤

1. 从接口文档确定建单 URL、方法、鉴权、幂等头、请求/响应和错误码。
2. 为 3–5 个 PoC 服务项逐字段形成映射表，业务 Owner 签字。
3. 复制示例为 `deploy/connectors.production.json`，只填写测试地址和环境变量名。
4. 运行结构校验，保存输出。
5. 通过公司密钥系统注入测试凭据，不写入文件或聊天。
6. 先使用脱敏测试数据执行创建、重复提交、同键冲突、业务拒绝、限流、5xx 和超时用例。
7. 验证签名 Webhook；没有 Webhook 时配置 `getTicket`，运行 `reconcile-external-tickets.mjs` 完成查询和每日对账。
8. 完成业务、技术、安全和运维证据后，才允许进入小范围灰度。
