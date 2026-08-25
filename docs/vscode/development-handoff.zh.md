# VS Code 开发接续：P2 后改进与复用

[English](development-handoff.md) | 中文

本参考文档帮助新的编码智能体在没有既往对话的情况下继续 DeepSeek Harness VS Code 项目。更改实现前必须阅读本文及其链接的权威文档。

## 接续状态

- 仓库：`E:\E_AI\DSH\deepseek-harness-myPcVs`，分支为 `master`。
- P0–P2.7 已实现并通过验收。P1、P2.0 与 P2.1 均已于 2026-08-24 通过用户验收；完整 P2 编码闭环已于 2026-08-25 通过整体验收。
- 开始工作前检查 `git status --short`。保留用户改动，禁止通过 reset、丢弃或覆盖这些改动来重建检查点。
- Windows 已安装 Node `v24.19.0`、pnpm `11.7.0` 和 VS Code `1.134.0`。启动 Extension Development Host 前必须重新构建被忽略的扩展产物。

## 必须遵守的协作规则

- 把已验收的 P2 行为作为产品基线。新工作必须有明确问题、有限范围、迁移决定和验收检查点。
- 优先改进产品并支持他人复用；不得把局部易用性请求扩大为无关的仓库清理。
- 验收流程与阶段报告使用中文。
- 对改动行为执行定向验证。已接受的仓库基线仍是 12,877 项通过、59 项跳过、36 项失败：其中 32 项为 Windows 符号链接 `EPERM`，4 项为全量测试超时。禁止把修复这项基线扩大为 P2 范围。
- 无法安全完成的环境归属步骤必须报告。真实提供方任务需要用户通过 VS Code SecretStorage 提供已经轮换的凭据；确定性的组装流程测试必须保持无密钥。

## 权威文档

| 文档 | 持有内容 |
| --- | --- |
| [阶段总结](README.md) | P0–P2 产品状态、安全状态与已知限制。 |
| [P2 完成与复用汇报](p2-completion-and-reuse-report.html) | 可分享的管理摘要、已交付能力、证据与 P2 后路线。 |
| [已批准的 P2 计划](p2-plan.md) | D1–D7、范围、设计、工作包与验收边界。 |
| [P2 验收教程](p2-acceptance.md) | 完整编码闭环的有序手工验证。 |
| [VS Code 扩展 README](../../apps/vscode/README.md) | 命令、配置、进程与 secret 所有权及定向检查。 |
| [架构](../architecture.md) | 更改 `packages/` 前必须阅读的仓库组合与扩展点。 |
| [防御性模式](../defensive-patterns.md) | 生命周期、并发、子进程、取消与 teardown（清理）规则。 |
| [Host stdio 运行时决策](../../.agents/notes/implemented/feature/2026-08-24-vscode-host-stdio-runtime.md) | 进程所有权、载体、profile 组合、凭据准入与启动诊断。 |
| [模型与权限引导决策](../../.agents/notes/implemented/feature/2026-08-24-vscode-model-permission-onboarding.md) | SecretStorage 所有权、settings 写入、回滚、权限与重启行为。 |
| [P2 编码闭环决策](../../.agents/notes/implemented/feature/2026-08-24-vscode-p2-coding-loop.md) | 对话投影、上下文持久化、Skill 根目录与审批限制。 |

仓库与子树的 `AGENTS.md` 仍然是必须遵守的规则。文档改动必须同步中英文，并重新记录每个 `.i18n.yaml` 配对。

## 已交付基线

扩展持有一个本地 `dsh --profile vscode` 进程和类型化的换行分隔 JSON-RPC 客户端。它先建立 mux 与 host 流，再校准历史；断开连接时拒绝待处理操作；重启后修复已跟踪会话尾页；提供方凭据保留在 VS Code SecretStorage。

Webview 展示普通会话、冷历史恢复与分页、流式助手 Markdown、不暴露私有推理文本的推理状态、Host 提供的工具卡片、取消、模型选择和活动权限投影。Extension Host 是唯一的进程与凭据持有者；Webview 只接收经过校验、可序列化的视图模型。

上下文标签在明确的字节和文件数量限制下捕获选区、当前或 Explorer 文件、Explorer 文件夹清单或工作区清单。准确渲染的分区进入 `session.prompt`，因此也进入持久用户消息。项目与用户 Skill 复用现有文件系统提供方根目录、斜杠补全、显式调用、文件系统刷新和不覆盖的骨架创建。

文件审批为 `write` 与定向 `edit` 提供准确的执行前 Diff，拒绝过期预览，并且只为原始审批请求发送一次应答。Shell 审批展示准确命令、工作目录、理由，以及无法预测全部文件系统影响的说明。`vscode` profile 禁用无法提供同等顶层审阅元数据的修改工具路径；组合中不包含 Code Mode。

## 代码入口

| 路径 | 职责 |
| --- | --- |
| [`apps/vscode/src/host-client.ts`](../../apps/vscode/src/host-client.ts) | 分帧、类型化 Host 请求、流、取消与待处理请求所有权。 |
| [`apps/vscode/src/event-fold.ts`](../../apps/vscode/src/event-fold.ts) | 历史／实时校准、投影、瞬时状态与待处理交互。 |
| [`apps/vscode/src/runtime-manager.ts`](../../apps/vscode/src/runtime-manager.ts) | 子进程生命周期、启动、配置、停止／重启与重连修复。 |
| [`apps/vscode/src/conversation.ts`](../../apps/vscode/src/conversation.ts) | 会话、历史、提示词、模型、权限、Skill、上下文与审批。 |
| [`apps/vscode/src/conversation-model.ts`](../../apps/vscode/src/conversation-model.ts) | 纯记录投影与 Host 渲染意图投影。 |
| [`apps/vscode/src/context.ts`](../../apps/vscode/src/context.ts) | 有界上下文捕获与确定性持久提示词渲染。 |
| [`apps/vscode/src/skills.ts`](../../apps/vscode/src/skills.ts) | 已批准的 Skill 根目录、监听与安全骨架创建。 |
| [`apps/vscode/src/approvals.ts`](../../apps/vscode/src/approvals.ts) | 原生 Diff 文档、准确编辑模拟、过期检查与一次性应答。 |
| [`apps/vscode/src/view.ts`](../../apps/vscode/src/view.ts) | CSP Webview 渲染与经过校验的动作解码。 |
| [`packages/bundle/vscode-app`](../../packages/bundle/vscode-app/README.md) | 长驻 Host 组合、权限选择与工具限制。 |

## 已验收的 P2 证据

用户已于 2026-08-25 使用真实提供方完成 [P2 验收教程](p2-acceptance.md)。通过的路径包括运行时与模型持久化、普通对话与工具、有界上下文、项目 Skill 创建与斜杠调用、准确 Diff 拒绝、陈旧 Diff 保护、一次性允许、Shell 披露、三种权限、取消、重启与窗口重开恢复。

自动化组装流程通过 `RuntimeManager` 启动真实 stdio 夹具进程，创建并恢复会话，持久化上下文与 Skill 调用，投影工具生命周期和审批，证明拒绝不会改变文件、一次性允许会应用准确编辑，并确认私有推理文本从不进入视图模型。已构建的 `vscode` profile 冒烟覆盖真实 bundle 启动和无模型凭据的 Host API。

## 安全与环境限制

- 提供方 API key 禁止进入源代码、settings JSON、命令参数、日志、快照、夹具或文档。既往对话中披露的凭据必须在真实提供方任务前轮换。
- 子进程只接收环境白名单与扩展管理的凭据引用；环境中的提供方变量仍被排除。
- 二进制、无效 UTF-8、超限上下文，以及超限或过期 Diff 都会明确失败，不会静默截断或批准。
- Windows 主机无法创建仓库测试所需符号链接时，`doc-sync` 的一个子检查与 NodeNext consumer 检查会返回 `EPERM`。必须报告主机限制，禁止归类为产品回归。
- `PATH` 中没有 `dsh` 时，配置已安装的 Node 可执行文件和已构建的 `apps/cli/lib/bin.js --profile vscode` 后备路径；验收教程提供具体步骤。

## 下一阶段重点

P2 后工作按以下三个主题推进：

1. **稳定性与上手体验。** 消除手工运行时路径配置，提供可靠启动方式，改善首次启动诊断，在普通窗口和视图切换后保留设置，并把已验收流程固化为确定性回归覆盖。
2. **分发与复用。** 生成可安装扩展产物，定义支持的 VS Code、Node 与操作系统版本，记录安装和升级流程，提供不含凭据的安全配置导出，并提供可复用项目模板与 Skill。
3. **产品改进。** 在增加大范围智能体能力之前，根据已观察到的用户阻力改进对话导航、审批显著性、恢复、无障碍、中文化、诊断和长会话性能。

继续由 SecretStorage 持有凭据，由 Host API 与会话日志持有权威运行记录，并保留修改操作的准确执行前审阅。配置复用不得包含凭据值，打包简化也不得削弱审阅保证。

## 接续流程

先检查工作区和当前分支，阅读链接的权威资料，再判断下一项请求属于稳定性、分发还是产品改进。非平凡决定写入所属 Agent Note，用户可见行为增加无密钥组装证据，同步中英文文档，运行覆盖改动的最小检查，并停在用户要求的验收边界。
