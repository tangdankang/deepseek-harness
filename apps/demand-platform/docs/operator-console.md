# 统一运营管理工作台

v0.6 在 `/admin` 提供独立的运营入口。工作台与员工门户使用不同 Cookie、不同身份签名和不同会话表，不接受员工会话越权访问。

## 功能范围

- 运营总览：统一需求、人工接管、集成任务、活动会话、审计失败和连接器状态；
- 人工队列：筛选、接单、分派、处理、解决或关闭；
- 需求列表：仅返回运营所需的脱敏摘要，不返回完整动态字段；
- 集成运营：查看 Outbox、执行到期任务、主动对账和死信重试；
- 会话安全：按员工查看活动会话聚合并即时撤销；
- 审计查询：按动作、结果和主体类型过滤。
- Agent 调用：按工具和结果查询调用编号、部门、耗时、错误码及 Trace ID，不展示业务正文或员工编号。

## 角色与权限

| 角色 | 读取总览 | 人工队列 | 集成任务 | 需求摘要 | 审计 | 员工会话撤销 |
|---|---:|---:|---:|---:|---:|---:|
| `OPS_VIEWER` | 是 | 只读 | 只读 | 是 | 是 | 否 |
| `HANDOFF_OPERATOR` | 是 | 可管理 | 否 | 是 | 否 | 否 |
| `INTEGRATION_OPERATOR` | 是 | 否 | 可管理 | 是 | 否 | 否 |
| `SECURITY_ADMIN` | 是 | 否 | 否 | 否 | 是 | 是 |
| `PLATFORM_ADMIN` | 是 | 可管理 | 可管理 | 是 | 是 | 是 |

多个角色的权限取并集。角色由可信身份网关签发，浏览器不能自行选择或覆盖。

## 生产登录链路

1. 运营人员从公司管理入口完成 SSO；
2. 反向代理校验身份源返回结果，并向 `POST /api/v1/operator/auth/session` 注入运营身份头；
3. 平台校验 HMAC、时间窗与角色后签发独立 HttpOnly Cookie 和 CSRF Token；
4. 浏览器调用 `/api/v1/operator/auth/me` 获取可显示的角色、权限与会话到期时间；
5. 所有管理接口在服务端再次执行 RBAC，写操作同时校验 CSRF；
6. 退出调用 `/api/v1/operator/auth/logout`，数据库立即撤销会话并清除 Cookie。

生产签名请求头：

```text
X-Operator-Id
X-Operator-Name
X-Operator-Roles
X-Operator-Timestamp
X-Operator-Signature
```

角色先转大写、去重并按字典序排列；签名正文为：

```text
operatorId + "\n" + name + "\n" + roles.join(",") + "\n" + timestamp
```

开发环境可在显式设置 `OPERATOR_BOOTSTRAP_ENABLED=true` 时用 Admin Key 引导 `PLATFORM_ADMIN` 会话。该入口只用于本地验证：前端在登录返回后立即清空输入值，数据库只保存会话 Token 摘要，不保存 Admin Key。生产配置若启用该入口会拒绝启动。

## 运营接口

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/api/v1/admin/overview` | `VIEW_OVERVIEW` |
| GET | `/api/v1/admin/handoffs` | `VIEW_HANDOFFS` |
| PATCH | `/api/v1/admin/handoffs/:handoffNo` | `MANAGE_HANDOFFS` |
| GET | `/api/v1/admin/cases` | `VIEW_CASES` |
| GET | `/api/v1/admin/integration-tasks` | `VIEW_INTEGRATIONS` |
| POST | `/api/v1/admin/integration-tasks/run` | `MANAGE_INTEGRATIONS` |
| POST | `/api/v1/admin/integration-tasks/:taskId/retry` | `MANAGE_INTEGRATIONS` |
| POST | `/api/v1/admin/external-tickets/reconcile` | `MANAGE_INTEGRATIONS` |
| GET | `/api/v1/admin/auth-sessions` | `MANAGE_SESSIONS` |
| POST | `/api/v1/admin/auth-sessions/revoke` | `MANAGE_SESSIONS` |
| GET | `/api/v1/admin/audit-events` | `VIEW_AUDIT` |
| GET | `/api/v1/admin/audit-integrity` | `VIEW_AUDIT` |
| GET | `/api/v1/admin/tool-invocations` | `VIEW_AUDIT` |

遗留自动化可继续使用 `X-Admin-Key`，在服务端等价于 `PLATFORM_ADMIN`；应逐步迁移到公司服务身份或 API 网关，不应把该凭据交给浏览器。

## 数据与安全边界

- Cookie 使用 `HttpOnly; SameSite=Strict`；生产为 `Secure` 且采用 `__Host-` 名称；
- 运营会话为绝对超时，默认 30 分钟；同一运营人员默认最多 5 个有效会话；
- 服务端数据库只保存会话 Token 的 SHA-256 摘要；
- 列表端点有数量上限，需求页不返回完整业务字段；
- 登录成功、登录失败、查看队列、接管、集成运行、会话撤销和退出均留审计事件；
- 该 MVP 仍需接入公司 WAF、集中审计、SIEM、统一限流、密钥管理和高可用会话存储后才能生产上线。
