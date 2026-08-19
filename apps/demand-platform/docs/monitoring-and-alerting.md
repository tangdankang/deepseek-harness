# 生产监控与告警

## 指标端点

`GET /internal/metrics` 输出 OpenMetrics 1.0 文本。端点与员工、DEAP工具和运营身份完全分离，只接受：

```http
Authorization: Bearer <METRICS_API_KEY>
```

未配置密钥时端点返回404；无效密钥返回401，并受认证范围限流保护。生产要求 `METRICS_API_KEY` 至少32位、不得使用示例值，也不得与任何业务或身份密钥复用。

生产建议：

- 仅允许公司监控采集器经内网或服务网格访问，不对员工网络或公网开放。
- 网关到应用必须使用TLS；采集器凭据由KMS注入并定期轮换。
- 禁止把Bearer凭据写入Prometheus配置仓库、URL参数、日志或探针输出。
- 默认采集间隔15至30秒，超时应小于应用请求超时。

## 指标边界

指标只使用固定路由名、HTTP方法、状态类别、受控业务状态和连接器系统编码。不会输出员工号、部门号、需求编号、工单号、Trace ID、请求正文、知识正文、URL查询值、IP或任何密钥。

主要指标：

- `ai_demand_http_requests_total`
- `ai_demand_http_request_duration_seconds`
- `ai_demand_cases`
- `ai_demand_handoffs`
- `ai_demand_integration_tasks`
- `ai_demand_oldest_pending_integration_age_seconds`
- `ai_demand_active_sessions`
- `ai_demand_knowledge_items`
- `ai_demand_organization_directory_required_services`
- `ai_demand_organization_directory_available`
- `ai_demand_organization_directory_seconds_until_expiry`
- `ai_demand_audit_failures_24h`
- `ai_demand_audit_chain_startup_valid`
- `ai_demand_rate_limit_rejections_total`
- `ai_demand_connector_configured`

HTTP计数和直方图保存在进程内，实例重启后归零；应使用 `rate()` 计算趋势。数据库业务量是当前快照。多实例聚合时，请求计数使用 `sum`，共享数据库状态类Gauge通常使用 `max`，不能把每个实例的相同数据库快照相加。

## 告警规则

示例位于 `deploy/prometheus-alerts.example.yml`。阈值只是初始值，必须结合真实员工入口峰值、业务SLO、下游系统SLA和试点基线审批后冻结。

### 平台不可用

检查进程、反向代理、证书、数据库可用性和最近发布。不要通过绕过鉴权临时暴露指标端点。

### 高服务端错误率

按固定路由定位5xx增长，关联应用日志Trace ID和下游连接器错误码；禁止从指标标签中寻找员工信息，因为指标刻意不保存这些信息。

### 高延迟

区分员工/API、DEAP工具、运营端点和下游集成。检查事件循环、数据库锁等待、连接器耗时和任务积压。

### 集成死信

先确认下游是否已经实际建单，避免盲目重试产生重复工单。使用运营工作台查看安全错误码，修复后再执行有审计的人工重试。

### 集成积压

检查Worker存活、数据库锁、下游限流和重试时间。扩容前确认SQLite单机试点边界；全员高可用架构不得把多个写实例直接共享同一SQLite文件。

### 审计链异常

立即停止发布和高风险运营操作，保护数据库、应用版本和KMS密钥现场，执行离线审计链验证并按安全事件流程处理。

### 限流拒绝升高

区分正常高峰、Agent工具链放大、错误重试风暴和攻击。不要直接关闭生产限流，应先调整上游退避和请求合并。

### 身份事件失败

检查 `api_v1_webhooks_identity_events` 固定路由的 4xx/5xx 比例，按 Trace ID 区分签名失败、来源不匹配、过期、乱序和数据库异常。签名失败应同时检查 API 网关来源限制和密钥轮换；乱序应暂停该员工后续事件并修复 IAM 适配器的持久化序号。不得通过生成新事件 ID 绕过事件重放或顺序校验。

`ai_demand_identity_states{status="BLOCKED"}` 只提供聚合数量；员工级状态必须通过受 `MANAGE_SESSIONS` 权限保护的 `/api/v1/admin/identity-states` 查询，不得把员工编号写入监控标签。

### 无有效知识

检查知识是否全部过期、停用或未正式导入。不得通过恢复旧版本绕过Owner复审，应发布经过批准的新版本。

### 组织目录不可用

当启用服务依赖部门子树而最新组织快照缺失或过期时触发。平台会默认拒绝所有需要层级展开的访问，并让就绪探针返回503。检查组织同步任务、快照有效期、版本连续性和变更审批；不得通过修改系统时间、扩大为全员可见或直接改数据库恢复流量。

### 组织目录即将过期

最新组织快照距离失效不足24小时且仍有服务依赖部门子树时触发。应在有效期内完成来自批准组织源的新版本发布；若组织源故障，业务Owner和安全Owner须决定是否临时停用相关服务，不能沿用过期层级作授权依据。

## 验收证据

生产门禁中的监控告警证据至少应包含：采集目标、连续观察窗口、告警触发与恢复截图、值班通知记录、Runbook演练、指标无PII抽检、安全Owner和运维Owner签字。示例规则本身不能作为生产验收通过证据。
