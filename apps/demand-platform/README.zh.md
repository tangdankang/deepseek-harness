# AI 统一需求平台 MVP v1.17

[English](README.md) | 中文

本应用作为 DeepSeek Harness monorepo 的私有 `demand-platform` workspace 成员维护。它拥有企业需求、确认、连接器和审计等业务事实；Harness Agent 通过受控 API 和工具调用本应用，不直接替代这些业务记录。

从仓库根目录运行：

```powershell
pnpm --filter demand-platform test
pnpm --filter demand-platform start
```

这是一个不依赖第三方包、可直接运行的技术骨架，用于验证：

- 统一服务目录与动态字段 Schema；
- 员工身份隔离和“我的需求”；
- 需求草稿、缺失字段追问、预览确认和版本控制；
- 短期确认令牌，防止未确认或确认后篡改；
- 幂等提交，防止重复生成下游工单；
- 模拟 CRM/OA/ERP 连接器和状态回传；
- Webhook 签名、防重放、统一状态映射和审计；
- FAQ 首问答复、知识来源和服务推荐；
- 面向 DEAP 的细粒度工具 API。
- 服务目录 JSON 配置化导入、Schema 历史版本保留和发布冲突保护。
- 连接器统一契约与幂等一致性测试。
- Agent JSONL 评测集校验和端点执行器。
- 生产启动门禁、DEAP 工具密钥和可信网关员工身份签名。
- 经员工确认的人工接管队列、处理状态和本人查询。
- 不保存原始问句的交互统计、受保护的试点指标和周报生成。
- 持久化下游提交 Outbox、指数退避、死信、跨进程恢复和运营重试。
- 员工明确评价、本人对象校验、结构化反馈和严格Go/No-Go试点门禁。
- 可配置异步 HTTP JSON 建单/查单连接器、字段映射、错误分类和主动状态对账。
- 生产真实连接器门禁、健康探针、优雅停机、数据库备份恢复和单机试点部署参考。
- 可信网关身份交换、不可伪造的服务端会话、HttpOnly Cookie、CSRF 防护、绝对超时和即时注销撤销。
- 浏览器员工会话与 DEAP 工具身份通道隔离，防止浏览器 Cookie 被误用为 Agent 工具凭据。
- 公司身份网关一次性交换票据、签发方/受众/时间窗校验、原子消费和并发防重放。
- 员工停用、离职或安全事件的全会话撤销与审计。
- Python 白名单 P0 资料包检查器，可校验 SafeNet Office 可读性、证据齐套度、哈希与凭据声明。
- 独立运营身份会话、角色权限、CSRF 防护和生产身份网关签名。
- 可直接使用的统一运营工作台，覆盖总览、人工队列、需求、集成任务、员工会话和审计。
- DEAP 工具调用编号、防重放、无业务载荷调用追踪和运营查询。
- 可对真实 HTTP 端点执行只读或显式写入的 DEAP 十三工具联调验收器。
- 员工网页入口可在聊天消息中逐轮补充最多3个Schema字段，也可随时切换完整表单；预览和明确确认后才提交。
- 服务目录支持 `ALL_EMPLOYEES` 与 `DEPARTMENTS` 受众策略，并在搜索、Schema、草稿、确认和提交各层执行服务端授权。
- 服务目录正式发布强制操作人和变更单，保存连续、带哈希且不可修改/删除的完整定义修订。
- 组织目录整包版本发布、不可变快照、部门子树授权、人员包含/排除例外和过期默认拒绝。
- 运行档位和高可用拓扑自证：单机SQLite不能声明为生产高可用，远程验收必须观察多实例、HA数据库及分布式状态能力。
- Python白名单P0资料检查支持业务系统、DEAP租户、组织目录和高可用基础设施四类资料包。
- 可信多部门身份：v2签名头和一次性票据绑定主部门、矩阵成员部门与姓名，会话、服务目录和知识授权统一消费。
- 统一身份生命周期事件：公司IAM签名推送停用、离职、恢复、成员关系或资料变化，平台防重放、拒绝乱序并即时撤销全会话；停用状态同时约束浏览器与DEAP工具链。
- 多员工、多部门并发合成试点，验证延迟、错误率、跨员工隔离、重复提交和重复下游工单。
- 合成试点报告结构校验并纳入正式 Go/No-Go 门禁，但不替代真人试点和三方签字。
- 数据生命周期策略白名单、默认预演、备份时效门禁、双重删除授权和去标识化执行证据。
- 法律、调查、审计、事件与业务保留冻结；需求、工单、审计等核心记录不进入自动删除范围。
- 生产就绪总门禁：统一校验真实DEAP、真实连接器、真人试点、远程容量、安全与三方审批证据，拒绝本地或合成报告冒充生产验收。
- 平台侧分范围限流与过载保护：员工、DEAP工具、认证、运营和Webhook独立计数，返回429/Retry-After并保留脱敏审计与工具失败追踪。
- 审计事件HMAC防篡改链、不可变初始化状态、显式旧数据锚定、启动拒绝和运营完整性验证端点。
- 知识条目来源指纹、Owner、变更单、部门授权、有效期和不可变版本历史；过期、停用或越权知识不会进入Agent回答。
- SafeNet加密Office知识来源可由Python白名单提取为带位置和指纹的待审阅草稿；草稿强制不可发布，受保护JSON通过Python到Node内存管道导入。
- 独立Bearer保护的OpenMetrics端点、固定低基数标签、请求延迟直方图、业务积压Gauge和Prometheus告警规则。

当前运行服务使用 Node.js 24 标准库和内置 SQLite；资料接收检查器使用公司白名单 Python 标准库。它是 PoC/MVP 骨架，不是未经公司安全评审即可直接投产的成品。

## 运行

```powershell
Copy-Item .env.example .env
node src/server.mjs
```

员工入口：`http://127.0.0.1:8787/`；运营入口：`http://127.0.0.1:8787/admin`。

也可以直接通过环境变量运行：

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

首次启动会创建 `data/demand-platform.db` 并写入演示服务和 FAQ。

开发模式未指定连接器配置时使用 Mock 连接器。生产模式必须设置 `CONNECTOR_CONFIG_PATH` 并注入连接器凭据，否则拒绝启动；参考 `deploy/connectors.production.example.json`，不得把实际配置或凭据提交到源码。

## 测试

```powershell
node --test --test-concurrency=1 test/*.test.mjs
```

测试覆盖：字段校验、状态机、令牌篡改、员工隔离、未确认禁止提交、确认后建单、重复提交幂等、Webhook 签名、防重放、状态回传、带来源 FAQ、DEAP 工具双层鉴权、服务目录版本治理、连接器契约、员工与运营身份签名、一次性票据并发防重放、角色权限、CSRF、会话撤销、P0 资料检查、生产配置门禁和 Agent 评测执行。

## 配置化扩展与评测

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

详细规则见 `docs/service-catalog-governance.md`、`docs/organization-directory-governance.md`、`docs/identity-lifecycle-events.md`、`docs/runtime-topology-acceptance.md`、`docs/knowledge-governance.md`、`docs/encrypted-knowledge-intake.md`、`docs/connector-conformance.md`、`docs/http-json-connector.md`、`docs/integration-outbox.md`、`docs/runtime-and-health.md`、`docs/runtime-rate-limits.md`、`docs/monitoring-and-alerting.md`、`docs/audit-integrity.md`、`docs/database-backup-restore.md`、`docs/agent-evaluation.md`、`docs/deap-tool-conformance.md`、`docs/synthetic-pilot.md`、`docs/pilot-metrics.md`、`docs/session-auth.md`、`docs/operator-console.md`、`docs/p0-intake-audit.md`、`docs/data-lifecycle.md`、`docs/production-readiness-gate.md` 和 `docs/production-security.md`。

## 身份与会话

生产链路为“钉钉免登凭证 → 公司身份网关验签/换取员工上下文 → 平台创建服务端会话”。平台支持两种网关交换方式：同链路注入 HMAC 签名身份头，或浏览器提交 30–300 秒内的一次性签名票据。票据绑定签发方、受众、员工和过期时间，数据库只保存 `jti` 摘要并原子消费，不能重放。平台会话数据库同样只保存 Token 摘要；浏览器写操作还必须携带 CSRF Token。

身份交换端点：

```text
POST /api/v1/auth/session
GET  /api/v1/auth/me
POST /api/v1/auth/logout
```

演示模式在没有真实钉钉网关时仍可使用以下请求头：

```text
X-Employee-Id: E10001
X-Department-Id: D-ORG
X-Employee-Name: 演示员工
```

矩阵组织使用 `X-Identity-Version: v2` 和包含主部门的 `X-Department-Ids`；整组部门及姓名必须进入身份网关HMAC签名，不能追加未签名请求头。单部门v1签名继续兼容。

浏览器演示页在会话不存在时回退到上述演示身份。生产必须设置 `IDENTITY_HMAC_SECRET`、启用 HTTPS 并设置 `SESSION_COOKIE_SECURE=true`；启用票据模式时还必须配置独立的 `IDENTITY_EXCHANGE_SECRET`、签发方和受众。不能信任浏览器直接传来的员工标识。详细边界见 `docs/session-auth.md`。

## 主要 API

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health/live` | 进程存活状态 |
| GET | `/health`、`/health/ready` | 数据库、Outbox和连接器就绪状态 |
| POST | `/api/v1/auth/session` | 将可信网关员工身份兑换为服务端会话 |
| GET | `/api/v1/auth/me` | 查询当前浏览器会话与 CSRF Token |
| POST | `/api/v1/auth/logout` | 撤销当前会话并清除 Cookie |
| GET | `/api/v1/services` | 查询员工可用服务目录 |
| GET | `/api/v1/services/:code/schema` | 获取动态表单 Schema |
| POST | `/api/v1/assistant/messages` | 本地演示问答/服务推荐；生产由 DEAP 替换 |
| POST | `/api/v1/cases/drafts` | 创建统一需求草稿 |
| PATCH | `/api/v1/cases/:requestNo/draft` | 补充或修改字段 |
| POST | `/api/v1/cases/:requestNo/prepare-confirmation` | 固化预览并获取短期确认令牌 |
| POST | `/api/v1/cases/:requestNo/submit` | 经员工确认后幂等提交 |
| GET | `/api/v1/cases` | 查询当前员工的需求 |
| GET | `/api/v1/cases/:requestNo` | 查询本人有权查看的需求 |
| POST | `/api/v1/handoffs` | 员工确认后创建人工受理事项 |
| GET | `/api/v1/handoffs` | 查询本人的人工受理事项 |
| POST | `/api/v1/webhooks/:systemCode/status` | 接收下游状态事件 |
| POST | `/api/v1/feedback` | 对本人真实会话/需求/人工事项提交一次结构化反馈 |
| POST | `/api/v1/tools/*` | 供 DEAP 自定义技能调用的细粒度工具端点；配置后要求 `X-Tool-Key` |
| POST/GET | `/api/v1/operator/auth/*` | 运营身份交换、查询会话和安全退出 |
| GET/PATCH | `/api/v1/admin/*` | 受运营会话与角色权限保护的管理接口；保留服务端 Admin Key 兼容通道 |
| GET/POST | `/api/v1/admin/integration-tasks/*` | 集成任务、到期执行和人工重试 |
| POST | `/api/v1/admin/external-tickets/reconcile` | 主动查单并对账统一状态 |
| POST | `/api/v1/admin/auth-sessions/revoke` | 按员工撤销全部有效会话并审计原因 |
| GET | `/api/v1/admin/tool-invocations` | 查询脱敏的 DEAP 工具调用结果、耗时与 Trace ID |
| GET | `/api/v1/admin/identity-states` | 查询受 IAM 生命周期事件管理的员工访问状态 |

完整示例见 `docs/api-examples.md`；可导入的 DEAP 工具契约见 `docs/openapi.json`，包含 13 个操作，其中 `guided_request_turn` 提供跨轮补问、结构化填单与显式确认门禁。

## 项目结构

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

## 真实环境替换点

1. 在钉钉/公司网关验证免登凭证，通过签名请求头或一次性票据调用 `/api/v1/auth/session`；浏览器后续只使用 HttpOnly 会话 Cookie。
2. 在租户支持 OpenAPI 技能时直接注册 13 个工具；若使用专有 Response API/H5 Copilot，只在边界增加协议适配器。
3. 对标准 HTTP JSON API 使用配置连接器；OAuth2/mTLS/特殊签名或非标准协议实现专用 CRM/OA/TB/ERP 连接器。
4. 将钉钉通讯录或公司IAM生命周期消息映射为 `POST /api/v1/webhooks/identity/events` 的统一事件契约；身份事件密钥与登录签名密钥必须隔离。
5. 当前版本会拒绝 `PRODUCTION_HIGH_AVAILABILITY` 运行档位；完成公司 PostgreSQL/MySQL及异步Repository适配后，必须同步修改硬编码能力声明并通过远程拓扑验收。
6. 进程内限流和单机任务替换为公司 API 网关、Redis、消息队列和调度平台。
7. 演示密钥替换成公司密钥管理系统；日志接入企业审计与监控平台。
8. 管理入口由公司 SSO 网关注入签名运营身份，生产关闭 Admin Key 浏览器引导。

## 当前非目标

- 不执行付款、删除、授权等高风险动作；
- 不替代原 OA/CRM/ERP 审批与专业业务规则；
- 不假定 DEAP Response API 或租户专有回调格式；当前以可导入 OpenAPI 工具契约和联调验收器作为稳定边界；
- 不在代码、数据库或聊天中保存真实密码、Token、API Key 或私钥。
