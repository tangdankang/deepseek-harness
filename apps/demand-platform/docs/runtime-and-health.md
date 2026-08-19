# 运行时、健康检查与优雅停机

## 健康端点

| 端点 | 含义 | 负载均衡用途 |
|---|---|---|
| `GET /health/live` | 只证明 Node 进程仍能响应 | 存活探针；连续失败后重启进程 |
| `GET /health` | 数据库可查询，并返回 Outbox 积压/死信摘要 | 与 `/health/ready` 等价，兼容现有调用 |
| `GET /health/ready` | 数据库可查询，并返回 Outbox 积压/死信摘要 | 就绪探针；失败时停止接收新流量 |

健康端点不要求员工身份或 DEAP 工具密钥，不返回密钥、员工信息、任务负载或下游错误详情。就绪检查数据库失败时返回 HTTP 503 和 `READINESS_FAILED`。

就绪响应还包含随机进程级 `instanceId`、`runtimeProfile`、`deploymentModel`、`storageBackend` 和三个布尔型分布式能力。实例ID不对应主机名且每次进程启动变化，用于远程拓扑采样；生产验收报告只保存其SHA-256。当前版本固定声明 `PILOT_SINGLE_NODE_SQLITE`、`SINGLE_NODE_PILOT` 和 `SQLITE`，三项分布式能力均为false，不能通过全员生产高可用门禁。

健康检查只能证明当前依赖可访问，不能代替真实业务探针。试点至少还应监控 API 错误率、P95 延迟、`pendingIntegrationTasks`、`deadIntegrationTasks`、磁盘空间和最后一次成功备份时间。

## 运行时边界

```text
REQUEST_TIMEOUT_MS=30000
HEADERS_TIMEOUT_MS=15000
KEEP_ALIVE_TIMEOUT_MS=5000
GRACEFUL_SHUTDOWN_MS=15000
```

- 请求超时允许 1–120 秒；
- 请求头超时允许 1–60 秒，且不得大于请求超时；
- Keep-Alive 超时允许 0.5–30 秒；
- 优雅停机窗口允许 1–60 秒；
- 每个连接最多处理 1000 个请求，每个请求最多 100 个请求头。

这些值是应用边界，不替代公司网关的连接、请求体、速率和并发限制。公司网关超时应略大于应用内部下游调用超时，并小于员工端无限等待时间。

## 优雅停机

API 进程收到 `SIGTERM` 或 `SIGINT` 后：

1. 停止接受新连接；
2. 等待在途请求结束；
3. 到达 `GRACEFUL_SHUTDOWN_MS` 后关闭剩余连接；
4. 关闭 SQLite 连接并退出。

Outbox 工作进程支持常驻模式，并响应相同停止信号：

```powershell
node scripts/run-integration-worker.mjs `
  --database data/demand-platform.db `
  --limit 20 `
  --watch `
  --interval-ms 5000
```

工作进程退出时未完成任务依靠短期锁过期恢复；真实部署应让容器停止宽限期大于应用优雅停机时间，并为锁过期、长时间 `RUNNING` 和积压增长配置告警。

## 已自动验证

- 存活/就绪端点无需员工身份即可访问；
- 就绪端点能查询数据库和任务摘要；
- 就绪端点明确暴露低敏运行拓扑，不允许以环境变量把SQLite声明成高可用；
- 超时配置越界或请求头超时大于请求超时时拒绝启动；
- `close()` 可重复调用并释放 HTTP 与数据库资源。
