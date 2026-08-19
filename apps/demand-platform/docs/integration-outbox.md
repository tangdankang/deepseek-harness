# 下游提交 Outbox 与故障恢复

## 为什么需要

员工确认后，平台先在同一数据库事务中更新需求为 `SUBMITTING` 并写入持久化 `integration_tasks`，再调用下游。这样即使进程在下游调用前后退出，提交意图仍不会丢失。

平台采用“至少一次执行 + 端到端幂等”，不宣称仅靠本地数据库实现跨系统 exactly-once：真实连接器必须把平台幂等键传给下游，或在调用前后通过业务唯一键查重。

## 任务状态

```text
PENDING → RUNNING → SUCCEEDED
                 ↘ RETRY_WAIT → RUNNING
                 ↘ DEAD → 人工修复/重试 → RUNNING
```

- `PENDING`：已持久化，等待执行；
- `RUNNING`：被工作进程认领，带短期锁；锁过期可恢复；
- `RETRY_WAIT`：瞬时错误，按指数退避等待；
- `DEAD`：业务错误或达到最大次数，需要运营处理；
- `SUCCEEDED`：下游编号、本地工单和任务状态已在同一事务中固化。

员工接口只返回安全任务状态和错误编码，不返回下游原始错误信息、幂等键或锁信息；运营接口才可查看诊断字段。

## 工作进程

一次处理到期任务：

```powershell
node scripts/run-integration-worker.mjs `
  --database data/demand-platform.db `
  --limit 20
```

生产环境应由公司调度/容器平台周期运行或常驻封装，接入进程健康、队列积压和失败告警。`INTEGRATION_MAX_ATTEMPTS` 控制最大自动尝试次数，`INTEGRATION_RETRY_BASE_SECONDS` 控制指数退避基数。

## 运营恢复接口

```text
GET  /api/v1/admin/integration-tasks?status=DEAD
POST /api/v1/admin/integration-tasks/run
POST /api/v1/admin/integration-tasks/{taskId}/retry
```

全部使用独立 `X-Admin-Key`，查看、运行和人工重试均写入审计。生产应再由公司 SSO/RBAC、工单审批和操作原因约束。

## 已验证故障

- 下游实际已建单但客户端响应超时；平台不登记工单，任务进入 `RETRY_WAIT`；
- 关闭并重新打开数据库模拟进程重启；
- 新工作进程用相同幂等键查回同一张下游工单，只在平台登记一次；
- 非瞬时业务校验失败进入 `DEAD`；运营修复后人工重试成功并留痕；
- 重复运行工作进程不会再次处理 `SUCCEEDED` 任务。

真实系统仍必须验证接口超时语义、查重能力、幂等有效期、限流、重试窗口和对账机制。
