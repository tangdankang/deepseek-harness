# 员工身份与服务端会话

## 目标链路

```text
钉钉客户端/H5
  → 钉钉免登临时凭证
  → 公司身份网关（调用钉钉服务端接口并校验员工、组织、应用）
  → HMAC 签名身份头，或30–300秒一次性身份票据
  → POST /api/v1/auth/session
  → HttpOnly 服务端会话 Cookie
  → 统一需求平台员工 API
```

平台不直接信任浏览器传入的员工编号、部门或姓名。生产环境可以使用三种配置：

1. `header`：反向代理在同一请求链上注入由 `IDENTITY_HMAC_SECRET` 签名的员工上下文；
2. `ticket`：身份网关签发一个极短期、单次使用的票据，浏览器把票据提交给平台，平台直接设置自身 Cookie；
3. `both`：兼容两种方式，便于网关迁移。生产部署参考默认使用该模式。

## 会话模型

- 使用 32 字节加密随机 Token；浏览器仅通过 HttpOnly Cookie 持有原始值。
- 数据库只保存 Token 的 SHA-256 Base64URL 摘要，不保存原始会话 Token。
- 会话采用绝对有效期，默认 3600 秒，不因访问而自动续期。
- 默认每位员工最多 10 个有效会话，超过上限时撤销最旧会话。
- 浏览器写操作要求 `X-CSRF-Token`，该 Token 与会话绑定；跨标签页调用 `/api/v1/auth/me` 可取得同一值。
- 注销会将当前会话标记为已撤销并返回清除 Cookie 的响应。
- 生产 Cookie 名为 `__Host-ai_demand_session`，包含 `Secure; HttpOnly; SameSite=Lax; Path=/`，且不设置 Domain。

CSRF Token 存在服务端数据库中，但它不是身份认证凭据；获得 CSRF Token 不能代替 HttpOnly 会话 Cookie。

## API

### 创建会话

`POST /api/v1/auth/session`

单部门请求头模式必须携带可信网关签名的 `X-Employee-Id`、`X-Department-Id`、`X-Employee-Name`、`X-Identity-Timestamp` 和 `X-Identity-Signature`，继续使用兼容v1规范。

员工有多个正式组织成员关系时使用v2：

```http
X-Employee-Id: E10001
X-Department-Id: D-ORG
X-Department-Ids: D-ORG,D-PROJECT,D-REGION
X-Employee-Name: %E5%91%98%E5%B7%A5%E5%90%8D
X-Identity-Version: v2
X-Identity-Timestamp: 1786940000
X-Identity-Signature: <hex-hmac-sha256>
```

`X-Department-Ids`包含1至20个不重复部门且必须包含主部门。平台规范化为“主部门在首位、其余按编码排序”。v2 HMAC输入为：

```text
v2\n<employeeId>\n<primaryDepartmentId>\n<规范化部门数组JSON>\n<URL解码后的姓名>\n<timestamp>
```

多部门头缺少v2版本、主部门不在集合、重复部门、姓名或部门被篡改时均返回401。代理必须先删除外部同名头，再注入整组签名身份。

票据模式请求正文：

```json
{
  "exchangeTicket": "v1.<base64url-json>.<base64url-hmac>"
}
```

票据不是通用 JWT。它是平台与公司身份网关约定的固定 v1 契约，包含 `iss`、`aud`、`sub`、`dept`、可选 `depts`、`name`、`iat`、`exp`、`jti`，使用独立 HMAC-SHA256 密钥签名。`depts`遵循相同的1至20个部门、无重复和包含主部门规则。平台验证签发方、受众、最长有效期、时钟偏差和签名，然后把 `jti` 摘要写入唯一键表；并发提交同一票据时只有一个请求成功。票据消费、会话创建和成功审计在同一数据库事务内完成。

两种方式成功后都返回员工信息（含规范化 `departmentIds`）、`csrfToken`、绝对过期时间和 `identitySource`，并设置会话 Cookie。会话数据库保存部门数组JSON；旧单部门会话迁移后按主部门恢复。

### 读取会话

`GET /api/v1/auth/me`

仅接受有效会话 Cookie，返回当前员工、CSRF Token 和过期时间。前端启动时先调用该端点；开发模式 401 时才回退到演示请求头。

### 注销

`POST /api/v1/auth/logout`

要求有效会话 Cookie 和 `X-CSRF-Token`。成功后服务端撤销会话并清除 Cookie。

### 员工全会话撤销

`POST /api/v1/admin/auth-sessions/revoke`

仅管理通道可调用。正文包含 `employeeId` 和固定原因码：`EMPLOYEE_DISABLED`、`EMPLOYEE_LEFT`、`SECURITY_EVENT`、`ROLE_CHANGE`、`ADMIN_REQUEST`。操作会在一个事务中撤销该员工所有未过期会话并写入审计；重复调用返回撤销数 0，不影响其他员工。

## 与 DEAP 工具调用的隔离

`/api/v1/tools/*` 不接受浏览器会话 Cookie。DEAP/Agent 工具调用仍必须同时提供平台专用 `X-Tool-Key` 和可信签名员工身份，避免员工浏览器会话被横向复用为机器调用凭据。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `SESSION_TTL_SECONDS` | 3600 | 绝对会话有效期，允许 300–28800 秒 |
| `SESSION_MAX_PER_EMPLOYEE` | 10 | 单员工有效会话上限，允许 1–20 |
| `SESSION_COOKIE_SECURE` | 开发 false / 生产 true | 生产必须为 true |
| `IDENTITY_TTL_SECONDS` | 300 | 网关身份签名时间窗 |
| `IDENTITY_HMAC_SECRET` | 无 | 生产必填，至少 32 位随机值 |
| `IDENTITY_EXCHANGE_MODE` | header | `header`、`ticket` 或 `both` |
| `IDENTITY_EXCHANGE_SECRET` | 无 | ticket/both 必填，不能与其他密钥复用 |
| `IDENTITY_EXCHANGE_ISSUER` | company-identity-gateway | 票据签发方精确匹配值 |
| `IDENTITY_EXCHANGE_AUDIENCE` | ai-demand-platform | 票据受众精确匹配值 |
| `IDENTITY_EXCHANGE_TTL_SECONDS` | 90 | 票据最长有效期，允许 30–300 秒 |

## 当前边界

- 当前 SQLite 方案适合单机试点；多实例生产需把会话存储迁移到共享数据库或 Redis，并对并发会话上限做事务化约束。
- 当前为绝对超时，不含刷新 Token；如需无感续期，应新增独立、可撤销且带风险控制的刷新流程。
- 钉钉免登凭证校验由身份网关负责，平台不硬编码尚未核实的 DEAP/钉钉接口路径和字段。
- 平台已提供全会话撤销接口；正式环境仍需由 IAM/HR/钉钉目录在停用、离职、组织变更时触发，并在身份源阻止重新签发票据。
- 成员部门在会话创建时固化，组织或矩阵成员关系变化后，IAM必须以 `ROLE_CHANGE` 撤销该员工全部会话；否则旧成员关系最长保留到绝对会话到期。
