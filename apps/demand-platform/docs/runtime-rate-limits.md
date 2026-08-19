# 运行时限流与过载保护

平台对员工接口、DEAP工具、认证尝试、运营接口和Webhook分别实施固定窗口限流。该控制用于减少单一身份、错误凭据和异常调用对平台的影响；公司API网关/WAF仍须承担跨实例、跨区域和源网络级聚合限流。

## 默认配置

| 环境变量 | 默认值 | 含义 |
|---|---:|---|
| `RATE_LIMIT_ENABLED` | `true` | 平台侧限流开关；生产不得关闭 |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | 固定窗口秒数 |
| `EMPLOYEE_RATE_LIMIT` | `120` | 单员工普通接口每窗口请求数 |
| `TOOL_RATE_LIMIT` | `300` | 单员工DEAP工具每窗口调用数 |
| `AUTH_RATE_LIMIT` | `600` | 单来源认证或无效凭据尝试数 |
| `ADMIN_RATE_LIMIT` | `300` | 单运营身份每窗口请求数 |
| `WEBHOOK_RATE_LIMIT` | `600` | 单下游系统每窗口事件数 |
| `RATE_LIMIT_MAX_ENTRIES` | `50000` | 单进程活跃限流主体上限 |

示例值不是生产SLO。应根据真实钉钉入口峰值、DEAP工具链放大系数、Webhook积压恢复速度和运营批量操作确定，并在远程容量测试前冻结。

## 行为

- 普通超限返回HTTP `429`、错误码 `RATE_LIMIT_EXCEEDED`；
- 限流状态容量耗尽返回HTTP `503`、错误码 `RATE_LIMIT_CAPACITY_EXCEEDED`，采用拒绝新主体的保守策略；
- 响应包含 `Retry-After`、`X-RateLimit-Limit` 和 `X-RateLimit-Remaining: 0`；
- 错误正文只包含范围、阈值和重试秒数，不包含员工号、IP、凭据或限流键；
- 限流主体以独立HMAC摘要作为内存键，不保存原始主体；
- 每个主体/窗口只写一次 `RATE_LIMITED` 审计，容量耗尽也按窗口抑制，避免日志放大；
- 已认证DEAP工具调用即使被限流，仍生成调用编号，并以HTTP 429和 `RATE_LIMIT_EXCEEDED` 记录失败；
- 无效DEAP/Admin凭据尝试使用独立认证范围计数，不产生工具业务调用记录。

## 健康与监控

`GET /health/ready` 返回：

```json
{
  "rateLimiting": {
    "enabled": true,
    "activeSubjects": 123,
    "maxEntries": 50000,
    "windowSeconds": 60
  }
}
```

建议告警：

- `RATE_LIMITED` 审计事件突增；
- 429比例超过已批准阈值；
- `activeSubjects / maxEntries` 超过70%；
- 出现 `RATE_LIMIT_CAPACITY_EXCEEDED`；
- 单一工具或Webhook持续触发限流；
- 网关429与平台429趋势不一致。

## 多实例边界

当前限流状态位于单个API进程内，适用于纵深防御，不提供多实例全局配额。正式高可用部署必须在公司网关/WAF或批准的共享限流存储中配置同口径聚合策略；平台阈值应略高于网关正常配额，避免双层策略互相震荡。生产证据应包含网关策略、平台策略、突发流量、重试退避和故障降级的联合验证。
