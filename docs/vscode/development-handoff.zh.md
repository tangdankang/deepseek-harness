# VS Code 开发接续：P2.1 之后

[English](development-handoff.md) | 中文

本参考文档帮助新的编码智能体在没有既往对话的情况下继续 DeepSeek Harness VS Code 项目。本文记录已验收状态、用户协作规则、代码入口、环境限制与下一个工作包。更改代码前必须阅读本文及其链接的权威文档。

## 接续状态

- 仓库：`E:\E_AI\DSH\deepseek-harness-myPcVs`，分支为 `master`。
- 包含本文档的提交是 P0–P2.1 检查点。P1、P2.0 与 P2.1 均已于 2026-08-24 通过用户验收；P2.2 尚未开始。
- 开始工作前检查 `git status --short`。保留此后出现的任何用户改动，禁止通过 reset、丢弃或覆盖这些改动来重建检查点。
- Windows 已安装 Node `v24.19.0`、pnpm `11.7.0` 和 VS Code `1.134.0`。扩展构建产物已被忽略；启动 Extension Development Host 前必须重新构建。

## 必须遵守的协作规则

- 每次只开发一个已批准的 P2 工作包。报告阶段结果后等待用户明确验收，再开始下一个工作包。
- 疑惑项会实质改变行为、安全性、范围或用户体验时，必须指出并等待用户回复，禁止静默代替用户决定。
- 验收流程与阶段报告使用中文。同一次实现中禁止从 P2.2 自行推进到 P2.3。
- 对改动行为执行定向验证。已接受的仓库基线仍是 12,877 项通过、59 项跳过、36 项失败：其中 32 项为 Windows 符号链接 `EPERM`，4 项为全量测试超时。禁止把消除这项基线变成 P2.2 工作。
- P2.2 定向验证明确证明缺少本地开发依赖时，用户允许在安全且属于当前范围的前提下安装。无法安全或自动安装的依赖必须报告。

## 权威文档

| 文档 | 持有内容 |
| --- | --- |
| [阶段总结](README.md) | 已验收的 P0–P2.1 产品状态、验证基线、安全状态与已知限制。 |
| [已批准的 P2 计划](p2-plan.md) | D1–D7、范围、工作包顺序、验收边界与完整 P2 手工流程。 |
| [VS Code 扩展 README](../../apps/vscode/README.md) | 扩展命令、运行时配置、进程与 secret 所有权、构建路径和定向检查。 |
| [架构](../architecture.md) | 更改 `packages/` 前必须阅读的仓库组合与扩展点。 |
| [防御性模式](../defensive-patterns.md) | P2.2 必须遵守的生命周期、并发、子进程、取消与 teardown（清理）规则。 |
| [Host stdio 运行时决策](../../.agents/notes/implemented/feature/2026-08-24-vscode-host-stdio-runtime.md) | 进程所有权、载体选择、profile 组合、凭据准入与启动错误优先级。 |
| [模型与权限引导决策](../../.agents/notes/implemented/feature/2026-08-24-vscode-model-permission-onboarding.md) | SecretStorage 所有权、settings 写入、回滚、权限选择与重启行为。 |

仓库与子树的 `AGENTS.md` 仍然是必须遵守的规则。文档改动必须维护中英文配对，并重新记录对应 `.i18n.yaml`。

## 已交付基线

P0 与 P1 已加入 VS Code workspace 扩展、`vscode` profile、基于 stdio 的换行分隔 JSON-RPC Host 载体、与传输无关的 Host 分发、单个自有子进程生命周期、可见连接状态、脱敏诊断和优雅关闭。P2.1 已加入 OpenAI 兼容提供方引导、VS Code SecretStorage 密钥所有权、生成式凭据引用、Host settings mutation（变更）和三种已批准的未来会话默认权限。

运行时分别限制协议初始化、Host 描述和 settings 描述的启动时间。启动失败在清理子进程时保留首个诊断；只有连接后的退出才会成为意外退出错误。扩展订阅与重连处理时必须保留这两项行为。

扩展尚未提供对话 UI、会话历史、mux 实时事件消费、编辑器上下文、Skill UI、Diff 审阅或逐操作审批。只有模型引导并不允许扩展执行编码任务。

## 代码入口

| 路径 | 当前职责与 P2.2 关系 |
| --- | --- |
| [`apps/vscode/src/host-client.ts`](../../apps/vscode/src/host-client.ts) | 客户端 JSON-RPC 分帧、初始化、类型化 Host 请求与待处理请求所有权；P2.2 的主要客户端入口。 |
| [`apps/vscode/src/runtime-manager.ts`](../../apps/vscode/src/runtime-manager.ts) | 子进程生命周期、启动就绪、settings 访问、停止／重启、退出观察与可见错误优先级。 |
| [`apps/vscode/src/extension.ts`](../../apps/vscode/src/extension.ts) | VS Code 激活、命令、SecretStorage wiring（接线）、运行时配置与 dispose。 |
| [`apps/vscode/src/view.ts`](../../apps/vscode/src/view.ts) | 当前连接／配置 Tree View；P2.2 禁止提前实现属于 P2.3 的对话 Webview。 |
| [`packages/host/apiproxy-stdio/src/protocol.ts`](../../packages/host/apiproxy-stdio/src/protocol.ts) | 带版本的 stdio 物理消息与校验。 |
| [`packages/host/apiproxy-stdio/src/index.ts`](../../packages/host/apiproxy-stdio/src/index.ts) | 服务端 stdio 请求、订阅、应答与关闭所有权。 |
| [`packages/host/apiproxy/src/dispatch.ts`](../../packages/host/apiproxy/src/dispatch.ts) | 与载体无关的 Host API 一元分发，由 fetch 载体共同使用。 |
| [`packages/bundle/vscode-app`](../../packages/bundle/vscode-app/README.md) | 已组装的长驻 Host profile 及其允许使用的权限 preset。 |

## 下一个工作包：P2.2

只有用户明确要求后才能开始 P2.2。交付内容包括类型化 stdio Host 客户端扩展、长驻 `events.mux` 与 `events.host` 订阅、审批交互的服务端请求应答、请求取消、进程退出时拒绝待处理操作、订阅释放，以及重连校准。Host API schema 继续作为 wire（线路）权威；禁止新增平行的 VS Code 协议，也禁止复用浏览器 Cordis UI 外壳。

P2.2 停在协议与事件折叠基础层。禁止实现对话 Webview、会话列表、输入框、编辑器上下文、Skill 体验、Diff 审批界面或活动会话权限模式 UI；这些内容属于 P2.3–P2.6。

申请 P2.2 验收前，测试必须覆盖拆分输入帧、流终止、历史／实时事件重叠处理、应答关联、取消、子进程退出、释放与重启。报告改动文件、实际运行的命令、剩余限制和简短中文验收流程，然后等待用户。

## 安全与环境限制

- 提供方 API key 禁止进入源代码、settings JSON、命令参数、日志、快照、夹具或文档。既往对话中披露的凭据必须在任何真实提供方测试前轮换。
- P2.2 协议工作不需要密钥。使用确定性夹具；禁止仅为验证分帧、流、取消或重连行为而调用真实模型。
- Extension Host 子进程只能接收环境白名单与扩展管理的凭据引用。禁止恢复环境中提供方变量的继承。
- Windows 环境无法创建所需符号链接并返回 `EPERM` 时，`pnpm run doc-sync` 存在一项已接受的主机特定失败。运行定向文档检查并准确报告此限制，禁止把它误判为产品回归。
- `PATH` 中没有 `dsh` 时，本地 fallback（后备）运行时使用已安装的 Node 可执行文件和已构建的 `apps/cli/lib/bin.js --profile vscode` 入口；[P2.1 验收教程](p2-1-acceptance.md)包含启动流程。

## 接续流程

用户可以使用这条指令开始下一阶段：`请完整阅读 docs/vscode/development-handoff.zh.md，然后开始 P2.2；P2.2 完成后停下来等待我验收。`

收到该指令后，检查工作区，阅读链接的架构与防御性规则，确认 P2.2 仍是当前范围，只实现该工作包，运行覆盖改动的最小检查，更新所属文档与 Agent Note，提供中文验收步骤，并在 P2.3 之前停止。
