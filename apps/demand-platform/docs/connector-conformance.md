# 连接器契约与一致性测试

真实 CRM、OA、TB、ERP 连接器应继承或兼容 `BaseConnector`，并在进入集成环境前通过 `verifyConnectorContract`。

当前契约检查：

- `systemCode` 与必需方法完整；
- 能力声明全部为布尔值；
- 有效请求通过、无效请求返回结构化错误；
- 连接器不修改输入对象；
- 建单结果包含系统、工单编号、原始状态和统一状态；
- 统一状态属于平台状态机；
- 相同幂等键和相同内容返回同一工单；
- 相同幂等键但内容不同必须返回 `IDEMPOTENCY_CONFLICT`；
- 原始状态映射不会产生平台未知状态。

示意：

```js
const report = verifyConnectorContract(realConnector, {
  validRequest,
  invalidRequest,
  conflictingRequest,
  rawStatuses: ["OPEN", "WORKING", "NEED_INFO", "RESOLVED", "CLOSED"],
});
```

契约测试只证明连接器满足统一技术边界，不替代下游测试环境中的业务字段、权限、限流、超时、Webhook、乱序、恢复和对账测试。
