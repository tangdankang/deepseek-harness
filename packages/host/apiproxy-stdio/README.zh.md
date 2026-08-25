# `@deepseek-ai/dsh-host-apiproxy-stdio`

[English](README.md) | 中文

这是提供方无关的 [`ctx.apiProxy`](../apiproxy/README.md) 所使用的换行分隔 JSON-RPC 载体。插件将 stdout 保留给协议帧，从 stdin 读取请求，并只在 stderr 输出诊断。它注入 `apiProxy` 和启动器持有的 `appExit`；在未提供这两项服务的启动器之外启动时会明确报错。

## 协议

客户端必须先且只调用一次 `dsh/initialize`，之后才能发送其他请求。`dsh/request` 携带完整形式的 Host API `ClientRequest`；客户端取消请求时，会尽力使用该请求的 Host `rpcId` 发送 `dsh/cancel`。`dsh/respond` 回答由 Host 发起的交互，`dsh/subscribe` 则打开 `mux` 或 `host` 事件流。事件流帧以 `dsh/event` 通知抵达，其中包含载体生成的订阅 id 和服务端原始的可回答 `rpcId`；每个迭代器结算时只发送一次 `dsh/streamEnd` 通知。`dsh/unsubscribe` 会取消并等待一个流。协议词汇从 `@deepseek-ai/dsh-host-apiproxy-stdio/protocol` 导出，不会导入 Node 运行时模块。

`dsh/shutdown`、stdin 关闭和 stdin 故障都会取消活动流与执行中的请求，等待它们结算，flush 待处理协议输出，再请求启动器退出。插件 dispose 时会在关闭传输前达到相同的完全停稳状态。Host API 载荷会经过与 fetch 载体相同的、由编译器锁定的分发器和领域 schema；实现故障仍属于载体故障，不会伪装成业务错误响应。

## 模型体验

无，因为该载体只传送 Host API 消息，不贡献任何提示词、工具 schema、消息或模型调用。

#### KV Cache 影响

无；该载体不组装或发送提供方请求。

## 已知限制与暂缓事项

- **每个进程只允许一个已初始化客户端**：重连会启动新的 DSH 进程；同一载体上的第二次初始化会被拒绝。
- **除 Host 游标外没有事件流恢复**：`mux` 接受既有的按会话 `since` 游标，`host` 流没有载体级回放缓冲区。
- **没有认证层**：stdio 继承父子进程间的信任关系；没有外层授权机制时，不得把它暴露为共享管道。
