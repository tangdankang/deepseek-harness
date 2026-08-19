# 生产安全配置

设置 `NODE_ENV=production` 后，应用会拒绝以下不安全启动方式：

- 默认、示例或少于 32 位的确认/Webhook/工具/运营管理/员工身份/身份事件/运营身份/票据/分析/审计完整性密钥；
- 默认、示例或与其他用途复用的监控采集密钥；
- 不同用途复用同一密钥；
- 使用 `:memory:` 数据库；
- 确认或身份时间窗口不在允许范围。

生产必需环境变量：

```text
NODE_ENV=production
DATABASE_PATH=<持久化数据库路径>
CONFIRMATION_SECRET=<独立随机值>
MOCK_WEBHOOK_SECRET=<MVP统一回调密钥；真实连接器应按系统独立管理>
TOOL_API_KEY=<DEAP技能网关专用随机值>
ADMIN_API_KEY=<运营管理接口专用随机值>
IDENTITY_HMAC_SECRET=<可信身份网关签名随机值>
IDENTITY_EVENT_SECRET=<身份生命周期事件专用随机值>
IDENTITY_EVENT_SOURCE=company-identity-gateway
IDENTITY_EVENT_MAX_AGE_SECONDS=86400
IDENTITY_EXCHANGE_MODE=both
IDENTITY_EXCHANGE_SECRET=<一次性票据专用随机值>
IDENTITY_EXCHANGE_ISSUER=company-identity-gateway
IDENTITY_EXCHANGE_AUDIENCE=ai-demand-platform
IDENTITY_EXCHANGE_TTL_SECONDS=90
ANALYTICS_HASH_SECRET=<交互统计去标识专用随机值>
AUDIT_CHAIN_SECRET=<审计完整性专用随机值>
AUDIT_CHAIN_KEY_VERSION=1
AUDIT_CHAIN_ALLOW_LEGACY_BACKFILL=false
CONFIRMATION_TTL_SECONDS=600
IDENTITY_TTL_SECONDS=300
OPERATOR_HMAC_SECRET=<运营身份网关专用随机值>
OPERATOR_IDENTITY_TTL_SECONDS=300
OPERATOR_SESSION_TTL_SECONDS=1800
OPERATOR_SESSION_MAX_PER_OPERATOR=5
OPERATOR_BOOTSTRAP_ENABLED=false
TOOL_INVOCATION_RETENTION_DAYS=90
```

员工身份请求头只适用于本地演示。配置 `IDENTITY_HMAC_SECRET` 后，可信网关还必须注入：

```text
X-Employee-Id
X-Department-Id
X-Identity-Timestamp
X-Identity-Signature
```

签名内容为 `employeeId + "\n" + departmentId + "\n" + Unix秒时间戳` 的 HMAC-SHA256 十六进制结果。终端浏览器、员工消息和模型都不能自行生成或覆盖这些请求头。

若网关不能在同一反向代理请求中注入身份头，应由身份网关签发一次性票据并让浏览器调用 `/api/v1/auth/session`。票据专用密钥不能与身份头、Webhook、确认或分析密钥复用；票据不能写入 URL、访问日志、本地存储或业务数据库。真实钉钉免登接入后，资源级授权仍必须保留。

离职、停用、调岗和安全事件由 IAM/HR/钉钉适配器签名调用 `/api/v1/webhooks/identity/events`。平台记录员工级单调序号并即时撤销全部会话；停用状态还会拒绝新的身份头、票据兑换与 DEAP 工具调用。身份网关仍必须停止为停用员工签发新的上下文或票据。人工应急接口 `/api/v1/admin/auth-sessions/revoke` 只撤销当前会话，不建立持续阻断状态。详细契约见 `identity-lifecycle-events.md`。

运营浏览器必须从公司管理入口进入，由网关注入签名后的 `X-Operator-Id`、`X-Operator-Name`、`X-Operator-Roles`、`X-Operator-Timestamp` 和 `X-Operator-Signature`。签名正文为 `operatorId + "\\n" + name + "\\n" + 排序去重后的逗号分隔角色 + "\\n" + Unix秒时间戳`，算法为 HMAC-SHA256 十六进制。平台完成验证后创建独立的 HttpOnly、SameSite=Strict 运营会话；写操作还必须携带服务端签发的 CSRF Token。

生产必须设置 `OPERATOR_BOOTSTRAP_ENABLED=false`，不允许浏览器提交 Admin Key。`ADMIN_API_KEY` 仅作为后台自动化和兼容脚本的服务端通道，不能暴露给员工门户、运营浏览器或 DEAP Agent。运营身份密钥、员工身份密钥与所有业务密钥不得复用。角色和权限矩阵见 `docs/operator-console.md`。

分析密钥仅用于生成不可逆员工统计标识，不与身份签名或审计完整性密钥复用。审计完整性密钥由公司密钥系统注入，不写入数据库、日志、报告或备份清单。

DEAP 技能网关应为每次 HTTP 尝试生成唯一 `X-Tool-Invocation-Id`。平台拒绝重复编号，并只记录工具名、员工不可逆摘要、部门、结果、HTTP 状态、错误码、耗时和 Trace ID；不记录请求正文、确认令牌或业务字段。记录默认保留 90 天，可配置为 7–365 天。业务写操作仍必须使用各自的幂等键，调用编号不能替代业务幂等。

MVP 已提供单进程纵深限流和数据库内HMAC审计链，但不内置生产密钥存储、跨实例聚合WAF/限流、集中会话、病毒扫描、WORM外部审计锚定和SIEM；这些应接入公司现有平台，并通过安全评审后上线。
