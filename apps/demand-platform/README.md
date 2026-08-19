# Unified AI Demand Platform MVP v1.17

English | [中文](README.zh.md)

This application is maintained as the private `demand-platform` workspace member of the DeepSeek Harness monorepo. It owns the business records for enterprise demands, confirmations, connectors, and audits. Harness agents call the application through controlled APIs and tools instead of replacing those records.

Run these commands from the repository root:

```powershell
pnpm --filter demand-platform test
pnpm --filter demand-platform start
```

This technical skeleton uses no third-party packages and runs directly to validate:

- A unified service catalog and dynamic field schemas.
- Employee identity isolation and "my requests."
- Demand drafts, missing-field follow-up, preview confirmation, and version control.
- Short-lived confirmation tokens that prevent unconfirmed or post-confirmation changes.
- Idempotent submission that prevents duplicate downstream tickets.
- Mock CRM, OA, ERP, and TB connectors with status callbacks.
- Webhook signatures, replay prevention, unified status mapping, and auditing.
- First-question FAQ answers, knowledge sources, and service recommendations.
- Fine-grained tool APIs for DEAP.
- JSON-configured service catalog imports, schema revision history, and publication conflict protection.
- A unified connector contract with idempotency conformance tests.
- Agent JSONL evaluation validation and an endpoint runner.
- Production startup checks, a DEAP tool key, and signed employee identity from a trusted gateway.
- Employee-confirmed human handoff queues, processing states, and employee-owned queries.
- Interaction analytics without original questions, protected pilot metrics, and weekly report generation.
- A durable downstream-submission outbox, exponential backoff, dead letters, cross-process recovery, and operator retry.
- Explicit employee ratings, ownership validation, structured feedback, and a strict Go/No-Go pilot decision.
- Configurable asynchronous HTTP JSON create/query connectors, field mapping, error classification, and proactive status reconciliation.
- Production connector checks, health probes, graceful shutdown, database backup and restore, and a single-node pilot deployment reference.
- Trusted-gateway identity exchange, tamper-resistant server sessions, HttpOnly cookies, CSRF protection, absolute expiry, and immediate logout revocation.
- Isolation between browser employee sessions and DEAP tool identity channels so browser cookies cannot serve as agent tool credentials.
- Company identity gateway one-time exchange tickets with issuer, audience, time-window, atomic-consumption, and concurrent replay checks.
- Full session revocation and auditing for employee suspension, departure, or security events.
- A Python allowlisted P0 intake checker for SafeNet Office readability, evidence completeness, hashes, and credential declarations.
- Independent operator identity sessions, role permissions, CSRF protection, and production identity-gateway signatures.
- A unified operator console for overview, handoff queues, demands, integration tasks, employee sessions, and audits.
- DEAP tool invocation identifiers, replay prevention, payload-free invocation traces, and operator queries.
- A thirteen-tool DEAP conformance runner for read-only or explicitly authorized writes against real HTTP endpoints.
- An employee web entry that collects up to three schema fields per chat message or switches to a complete form, with preview and explicit confirmation before submission.
- `ALL_EMPLOYEES` and `DEPARTMENTS` service-audience policies enforced server-side across search, schema, draft, confirmation, and submission.
- Governed service publication that requires an operator and change ticket and stores consecutive, hashed, immutable full-definition revisions.
- Whole-directory organization publication, immutable snapshots, department-tree authorization, employee include/exclude exceptions, and deny-by-default expiry.
- Runtime-profile and high-availability topology evidence: single-node SQLite cannot claim production HA, and remote acceptance must observe multiple instances, an HA database, and distributed-state capabilities.
- Python allowlisted P0 intake checks for business systems, DEAP tenants, organization directories, and HA infrastructure packages.
- Trusted multi-department identity: v2 signed headers and one-time tickets bind the primary department, matrix departments, and name for shared session, service, and knowledge authorization.
- Unified identity lifecycle events: company IAM signs suspension, departure, recovery, membership, and profile updates; the platform prevents replay, rejects out-of-order events, revokes sessions immediately, and applies suspension to browser and DEAP tool paths.
- Concurrent synthetic pilots across employees and departments that validate latency, error rate, employee isolation, duplicate submissions, and duplicate downstream tickets.
- Structural validation of synthetic pilot reports for the formal Go/No-Go decision without replacing human pilots and three-party approval.
- Allowlisted data-lifecycle policies, dry-run defaults, backup-age checks, dual deletion authorization, and de-identified execution evidence.
- Legal, investigation, audit, incident, and business retention holds; demands, tickets, audits, and other core records remain outside automatic deletion.
- A production-readiness decision that verifies real DEAP, real connectors, human pilots, remote capacity, security, and three-party approvals while rejecting local or synthetic evidence as production acceptance.
- Platform rate limiting and overload protection with separate employee, DEAP tool, authentication, operator, and webhook scopes, returning 429/Retry-After while retaining de-identified audits and failed-tool traces.
- An HMAC tamper-evident audit chain, immutable initialization state, explicit legacy anchoring, startup refusal, and an operator integrity endpoint.
- Knowledge source fingerprints, owners, change tickets, department authorization, validity periods, and immutable version history; expired, disabled, or unauthorized knowledge never reaches agent answers.
- Python allowlisted extraction of SafeNet-encrypted Office knowledge into location- and fingerprint-bearing review drafts; drafts cannot be published, and protected JSON moves from Python to Node through an in-memory pipe.
- A separately protected OpenMetrics endpoint, fixed low-cardinality labels, request-latency histograms, backlog gauges, and Prometheus alert rules.

The running service uses the Node.js 24 standard library and built-in SQLite. Intake checks use the company-allowlisted Python standard library. This is a PoC/MVP skeleton, not a production product that can bypass company security review.

## Run

```powershell
Copy-Item .env.example .env
node src/server.mjs
```

Employee entry: `http://127.0.0.1:8787/`; operator entry: `http://127.0.0.1:8787/admin`.

The service can also run directly from environment variables:

```powershell
$env:CONFIRMATION_SECRET='请替换成长随机值'
$env:MOCK_WEBHOOK_SECRET='请替换成另一个长随机值'
$env:TOOL_API_KEY='请替换成DEAP技能网关专用密钥'
$env:ADMIN_API_KEY='请替换成运营管理接口专用密钥'
$env:METRICS_API_KEY='请替换成监控采集器专用密钥'
$env:IDENTITY_HMAC_SECRET='请替换成身份网关专用签名密钥'
$env:IDENTITY_EVENT_SECRET='请替换成身份事件专用签名密钥'
$env:OPERATOR_HMAC_SECRET='请替换成运营身份网关专用签名密钥'
$env:ANALYTICS_HASH_SECRET='请替换成分析去标识专用密钥'
$env:AUDIT_CHAIN_SECRET='请替换成独立审计完整性密钥'
node src/server.mjs
```

The first start creates `data/demand-platform.db` and inserts demonstration services and FAQs.

Development mode uses mock connectors when no connector configuration is set. Production mode requires `CONNECTOR_CONFIG_PATH` and injected connector credentials or refuses to start. Use `deploy/connectors.production.example.json` as the reference, and never commit real configuration or credentials.

## Test

```powershell
node --test --test-concurrency=1 test/*.test.mjs
```

Tests cover field validation, the state machine, token tampering, employee isolation, unconfirmed-submission refusal, confirmed ticket creation, duplicate-submission idempotency, webhook signatures, replay prevention, status callbacks, sourced FAQs, two-layer DEAP tool authentication, service-catalog version governance, connector contracts, employee and operator signatures, concurrent one-time-ticket replay prevention, role permissions, CSRF, session revocation, P0 intake checks, production configuration checks, and agent evaluation execution.

## Configured extensions and evaluations

```powershell
# 校验服务目录，不写数据库
node scripts/import-service-catalog.mjs --file config/service-catalog.example.json --dry-run

# 校验组织目录快照，不写数据库
node scripts/import-organization-directory.mjs --file config/organization-directory.example.json --dry-run

# 校验受治理知识目录，不写数据库
node scripts/import-knowledge-catalog.mjs --file config/knowledge-catalog.example.json --dry-run

# 校验公司级Agent评测集结构
node scripts/run-agent-evals.mjs --file ..\DEAP组织中心Agent-评测集-v0.1.jsonl --validate-only

# 校验真实连接器配置结构与生产安全边界
node scripts/validate-connector-config.mjs --file deploy/connectors.production.example.json --production

# 对没有Webhook或需要兜底的下游工单执行一次主动对账
node scripts/reconcile-external-tickets.mjs --database data/demand-platform.db --connector-config deploy/connectors.production.json --limit 20

# 验证Python白名单资料接收检查器
python tools/audit_p0_intake.py --self-test

# 验证加密Office知识草稿和SafeNet JSON内存桥接
python tools/build_knowledge_draft.py --self-test
python tools/import_knowledge_catalog.py --self-test

# 对正在运行的平台执行DEAP只读工具链联调（密钥仅从环境变量读取）
node scripts/run-deap-tool-conformance.mjs --base-url http://127.0.0.1:8787

# 本地全量写入联调；远程环境还必须显式增加--allow-remote-write
node scripts/run-deap-tool-conformance.mjs --allow-write --service-code CRM_ACCOUNT_CHANGE --fields-file config/deap-conformance-fields.example.json

# 默认模拟50名员工进行只读并发试点
node scripts/run-synthetic-pilot.mjs --employees 50 --concurrency 10

# 对真实远程入口执行只读高可用拓扑采样
node scripts/run-runtime-topology-acceptance.mjs --base-url https://approved-test.example --samples 20 --output-json work/runtime-topology.json

# 全量写入合成试点；远程目标还必须增加--allow-remote-write
node scripts/run-synthetic-pilot.mjs --allow-write --employees 50 --write-employees 20 --service-code CRM_ACCOUNT_CHANGE --fields-file config/deap-conformance-fields.example.json --thresholds-file config/synthetic-pilot-thresholds.example.json

# 使用已确认的专用测试员工执行身份生命周期全链路联调
node scripts/run-identity-lifecycle-conformance.mjs --base-url https://approved-test.example --allow-write --allow-remote-write --confirm-test-employee --test-employee-id E-IAM-CONFORMANCE --starting-sequence 1000 --output-json work/identity-lifecycle-conformance.json
```

See `docs/service-catalog-governance.md`, `docs/organization-directory-governance.md`, `docs/identity-lifecycle-events.md`, `docs/runtime-topology-acceptance.md`, `docs/knowledge-governance.md`, `docs/encrypted-knowledge-intake.md`, `docs/connector-conformance.md`, `docs/http-json-connector.md`, `docs/integration-outbox.md`, `docs/runtime-and-health.md`, `docs/runtime-rate-limits.md`, `docs/monitoring-and-alerting.md`, `docs/audit-integrity.md`, `docs/database-backup-restore.md`, `docs/agent-evaluation.md`, `docs/deap-tool-conformance.md`, `docs/synthetic-pilot.md`, `docs/pilot-metrics.md`, `docs/session-auth.md`, `docs/operator-console.md`, `docs/p0-intake-audit.md`, `docs/data-lifecycle.md`, `docs/production-readiness-gate.md`, and `docs/production-security.md` for the detailed rules.

## Identity and sessions

The production path is "DingTalk passwordless credential -> company identity gateway verification and employee-context exchange -> platform server session." The platform supports two gateway exchanges: HMAC-signed identity headers injected on the same request path, or a browser-submitted one-time signed ticket valid for 30-300 seconds. A ticket binds its issuer, audience, employee, and expiration time. The database stores only its `jti` digest and consumes it atomically, so it cannot be replayed. The session database likewise stores only token digests, and browser writes also require a CSRF token.

Identity exchange endpoints:

```text
POST /api/v1/auth/session
GET  /api/v1/auth/me
POST /api/v1/auth/logout
```

Without a real DingTalk gateway, demonstration mode accepts these headers:

```text
X-Employee-Id: E10001
X-Department-Id: D-ORG
X-Employee-Name: 演示员工
```

Matrix organizations use `X-Identity-Version: v2` and `X-Department-Ids`, which includes the primary department. The complete department set and employee name must be covered by the identity-gateway HMAC signature; unsigned headers cannot extend them. Single-department v1 signatures remain compatible.

When no session exists, the browser demonstration falls back to the demonstration identity above. Production requires `IDENTITY_HMAC_SECRET`, HTTPS, and `SESSION_COOKIE_SECURE=true`. Ticket mode additionally requires a separate `IDENTITY_EXCHANGE_SECRET`, issuer, and audience. Never trust an employee identifier sent directly by a browser. See `docs/session-auth.md` for the detailed rules.

## Main API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health/live` | Process liveness |
| GET | `/health`, `/health/ready` | Database, outbox, and connector readiness |
| POST | `/api/v1/auth/session` | Exchange trusted gateway employee identity for a server session |
| GET | `/api/v1/auth/me` | Query the current browser session and CSRF token |
| POST | `/api/v1/auth/logout` | Revoke the current session and clear its cookie |
| GET | `/api/v1/services` | Query the employee-visible service catalog |
| GET | `/api/v1/services/:code/schema` | Get a dynamic form schema |
| POST | `/api/v1/assistant/messages` | Local demonstration Q&A and service recommendation; DEAP replaces it in production |
| POST | `/api/v1/cases/drafts` | Create a unified demand draft |
| PATCH | `/api/v1/cases/:requestNo/draft` | Add or change fields |
| POST | `/api/v1/cases/:requestNo/prepare-confirmation` | Freeze the preview and issue a short-lived confirmation token |
| POST | `/api/v1/cases/:requestNo/submit` | Submit idempotently after employee confirmation |
| GET | `/api/v1/cases` | Query the current employee's demands |
| GET | `/api/v1/cases/:requestNo` | Query a demand the current employee may view |
| POST | `/api/v1/handoffs` | Create a human handoff after employee confirmation |
| GET | `/api/v1/handoffs` | Query the current employee's handoffs |
| POST | `/api/v1/webhooks/:systemCode/status` | Receive downstream status events |
| POST | `/api/v1/feedback` | Submit one structured rating for an employee-owned session, demand, or handoff |
| POST | `/api/v1/tools/*` | Fine-grained DEAP custom-skill endpoints; require `X-Tool-Key` when configured |
| POST/GET | `/api/v1/operator/auth/*` | Exchange operator identity, query the session, and log out safely |
| GET/PATCH | `/api/v1/admin/*` | Management APIs protected by operator sessions and roles, with a server-side Admin Key compatibility path |
| GET/POST | `/api/v1/admin/integration-tasks/*` | Integration tasks, due execution, and manual retry |
| POST | `/api/v1/admin/external-tickets/reconcile` | Query downstream tickets and reconcile unified status |
| POST | `/api/v1/admin/auth-sessions/revoke` | Revoke all active sessions for an employee with an audited reason |
| GET | `/api/v1/admin/tool-invocations` | Query de-identified DEAP tool results, latency, and trace identifiers |
| GET | `/api/v1/admin/identity-states` | Query employee access state managed by IAM lifecycle events |

See `docs/api-examples.md` for complete examples. The importable DEAP tool contract at `docs/openapi.json` defines 13 operations. `guided_request_turn` provides cross-turn follow-up, structured form filling, and explicit confirmation checks.

## Project structure

```text
src/
  agents/          本地演示Agent；真实DEAP适配边界
  connectors/      下游契约、模拟器与可配置HTTP JSON实现
  domain/          状态机、Schema校验、确认令牌
  services/        服务目录、需求、审计与知识服务
                    含受治理组织目录与部门层级授权
  db.mjs           SQLite Schema、迁移与演示数据
  server.mjs       HTTP API 与静态门户
public/            员工门户与统一运营工作台
test/              Node内置测试
scripts/           服务目录导入与Agent评测命令
tools/             Python白名单资料检查、加密Office知识提取与SafeNet JSON导入桥接
  config/            可版本化目录及四类P0资料包清单示例
  evals/             本地Agent冒烟评测集
  conformance/       真实HTTP工具链联调验收逻辑
  pilot/             多员工合成试点和报告门禁校验
docs/              API示例与真实接入替换清单
```

## Real-environment replacements

1. Verify DingTalk or company-gateway passwordless credentials, call `/api/v1/auth/session` with signed headers or a one-time ticket, and use only the HttpOnly session cookie from the browser afterwards.
2. Register all 13 tools directly when the tenant supports OpenAPI skills. For a proprietary Response API or H5 Copilot, add only a protocol adapter at the edge.
3. Use configured connectors for standard HTTP JSON APIs. Implement dedicated CRM, OA, TB, or ERP connectors for OAuth2, mTLS, special signatures, or nonstandard protocols.
4. Map DingTalk directory or company IAM lifecycle messages into the unified `POST /api/v1/webhooks/identity/events` event contract. Isolate the identity-event secret from the login-signature secret.
5. The current version rejects the `PRODUCTION_HIGH_AVAILABILITY` runtime profile. After implementing company PostgreSQL/MySQL and asynchronous repository adapters, update the fixed capability declaration and pass remote topology acceptance.
6. Replace in-process rate limiting and single-node tasks with the company API gateway, Redis, message queue, and scheduling platform.
7. Replace demonstration secrets with the company key-management system and connect logs to enterprise audit and monitoring platforms.
8. Inject signed operator identity from the company SSO gateway and disable Admin Key browser bootstrap in production.

## Current non-goals

- Do not perform high-risk payment, deletion, or authorization actions.
- Do not replace the approval and specialized business rules in OA, CRM, or ERP systems.
- Do not assume a DEAP Response API or tenant-specific callback protocol. The importable OpenAPI tool contract and conformance runner are the stable integration interface.
- Do not store real passwords, tokens, API keys, or private keys in code, databases, or chats.
