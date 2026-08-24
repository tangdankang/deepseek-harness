# Agent Note: VS Code 持有的 Host stdio 运行时

Status: implemented

[English](2026-08-24-vscode-host-stdio-runtime.md) | 中文

## 问题

VS Code workspace 扩展需要一个长驻 DSH 进程，并在编辑器中明确显示其生命周期与故障。复用浏览器组合还会启动编辑器不消费的 HTTP server 和 Web client，而扩展 ACP 或公共 SDK 协议则会把编辑器 UI 流量与自动化语义耦合。第一阶段只需要连接归属，但传输必须从一开始就保留后续阶段所需的完整 Host API 请求和事件词汇。

## 决策

**Extension Host 持有一个 DSH 子进程。** 它启动可配置的命令，默认执行 `dsh --profile vscode`，执行版本初始化、Host 就绪请求和 settings 就绪请求，并通过编辑器界面暴露 starting、connected、stopping、stopped 和 error 状态。每个就绪请求都有各自的配置时限。优雅停止会先请求协议关闭，再终止进程，dispose 使用同一路径。启动失败在终止对应子进程期间仍保留原错误状态；只有已连接进程的退出会成为意外退出错误。

**专用 stdio 载体包装既有 Host API。** `dsh-host-apiproxy` 持有一个与载体无关、由编译器锁定的一元分发器。fetch handler 与 `dsh-host-apiproxy-stdio` 都先校验自身的物理信封，再调用这个分发器，因此 Host 方法与领域 schema 只有一份注册表。stdio 载体保留完整服务端请求，包括可回答的 `rpcId`，并持有订阅取消，而不改变 Host API 领域类型。

**`vscode` profile 是最小 Host 组合。** `dsh-vscode-app` 在 `dsh-base` 之上叠加存储、Workspace、browse 目录支持、`ctx.apiProxy` 与 stdio 载体。它不挂载 HTTP、Web 或 stdout 日志配置行。普通 `web` 与 `headless` 模板仍是相互独立的组合。

**扩展只接纳自己明确持有的模型凭据。** 子进程环境允许操作系统与 DSH 位置变量，以及从 VS Code SecretStorage 加载的扩展管理引用；环境中的提供方变量仍被排除，诊断信息还会经过最后一道凭据脱敏。[模型与权限引导决策](2026-08-24-vscode-model-permission-onboarding.md)持有写入路径与运行时注入规则。

## 曾考虑的替代方案

**扩展 ACP 或 SDK 协议。** 不采用：这些协议服务于自动化与受支持的 SDK 客户端，而编辑器功能消费产品 Host API 及其双向交互事件。

**复用 Web HTTP 与 SSE 载体。** 不采用：回环 server 会引入端口、origin、认证和关闭归属，而父子进程 stdio 通道不需要这些机制。

**每次编辑器操作都运行一个 DSH 进程。** 不采用：会话、事件订阅、待处理交互和后续流式对话状态需要一条持久连接。

## 后果

无需调用模型或提供 secret，就可以激活扩展并验收其运行时生命周期。模型配置、对话、Diff 与审批阶段使用同一进程和 Host API，无需替换载体。载体协议独立于 Host 领域方法进行版本控制；重连会启动新的子进程，而不是重新连接既有进程。
