# VS Code 项目阶段总结：P0–P2

[English](README.md) | 中文

本参考文档记录 DeepSeek Harness VS Code 产品状态。P1、P2.0 与 P2.1 已于 2026-08-24 通过用户验收。完整的 P2.2–P2.7 编码闭环已于 2026-08-25 通过用户整体验收。

## 阶段状态

| 阶段 | 状态 | 结果 |
| --- | --- | --- |
| P0 | 完成 | 架构、信任边界、传输选择、进程所有权与产品方向已经确定。 |
| P1 | 已验收 | workspace 扩展持有一个本地 stdio Host、可见生命周期、脱敏诊断、优雅关闭与受限 `vscode` profile。 |
| P2.0 | 已验收 | D1–D7、三种权限、范围、工具限制与完整验收边界已经确定。 |
| P2.1 | 已验收 | OpenAI 兼容引导把密钥存入 SecretStorage 并写入非机密 settings；bundle 暴露三种已批准的未来默认值。 |
| P2.2 | 已验收 | 类型化 Host 调用、流、审批应答、取消、事件校准与重启修复。 |
| P2.3 | 已验收 | 会话列表／创建／切换、历史分页、输入框、流式记录、模型选择、取消与 Host 工具卡片。 |
| P2.4 | 已验收 | 有界选区／文件／文件夹／工作区上下文、可移除标签与持久准确提示词文本。 |
| P2.5 | 已验收 | 项目／用户 Skill 根目录、斜杠补全、显式调用、刷新、目录展示与不覆盖骨架。 |
| P2.6 | 已验收 | 活动权限、准确文件 Diff 审批、过期拒绝、Shell 披露与修改工具限制。 |
| P2.7 | 已验收 | 已构建 profile、无密钥组装流程、真实提供方任务和完整手工教程全部通过。 |

## 已交付系统

扩展持有一个本地 `dsh --profile vscode` 进程。类型化的换行分隔 JSON-RPC 客户端先建立 mux 与 host 订阅，再修复历史；关联服务端请求；支持取消；确定性关闭待处理操作；重启后恢复已跟踪会话。提供方密钥保留在 VS Code SecretStorage，只通过生成的凭据引用进入经过清理的自有子进程。

CSP Webview 展示普通会话、恢复与分页历史、流式 Markdown、不含私有推理文本的推理状态、Host 提供的通用／终端／Diff 工具卡片、运行时状态、模型与权限选择、取消、上下文标签、Skill 补全和审批控件。Webview 不接收进程句柄、原始 Host 协议、文件系统权威或凭据。

模型可见上下文是包含来源路径和可选行号的确定性持久文本。文件夹与工作区上下文使用有界清单；二进制、无效 UTF-8 和超限内容会明确失败。项目与用户 Skill 命令只写入现有提供方根目录，绝不覆盖资源。

文件审阅对 `write` 与字面 `edit` 是准确的。扩展根据当前内容计算拟议右侧文档，把审批绑定到当前文件摘要与存在性，并拒绝过期或不受支持的请求。Shell 审阅展示准确命令、工作目录与理由，同时说明任意影响无法预测。没有同等顶层证据的组合或嵌套修改路径在 profile 中被禁用。

## 验证状态

定向单元测试覆盖协议分帧、类型校验、流、取消、历史／实时重叠、投影、记录渲染、上下文限制、Skill 创建、权限、Diff 生成、过期审批与进程 teardown（清理）。产品快照覆盖组装后的 Webview，以及通过真实 stdio 夹具进程执行的无密钥端到端对话流程。已构建 profile 冒烟启动真实 `vscode` bundle，并在没有模型密钥的情况下执行 Host settings 与会话 API。

Host 包构建、扩展 bundle、TypeScript project 构建、定向 lint、运行时闭包检查、文档检查与 diff hygiene（整洁性）组成提交前验证集。Windows 符号链接创建仍可能以已接受的 `EPERM` 主机限制阻塞一个文档子检查与 NodeNext consumer 检查。

## 安全状态

- 提供方密钥不进入源代码、settings JSON、命令参数、Host 响应、日志、快照、夹具或文档。
- 子进程环境会移除环境中的模型凭据，只准入扩展持有的值。
- 用户文本与 Markdown 只通过经过校验的视图数据跨越 Webview；原始 HTML 与远程资源没有 CSP 权限。
- 上下文与 Diff 输入在无效编码、二进制内容、大小限制、有歧义编辑、不受支持工具或过期文件时关闭式失败。
- `read-only`、`confirm-changes` 与 `workspace-write` 是仅有的权限选择；danger-full-access 与无法审阅的修改工具路径不在组合中。

## P2 验收结果

用户已于 2026-08-25 完成 [P2 验收教程](p2-acceptance.md)。验收覆盖运行时与模型持久化、普通对话、编辑器上下文、显式 Skill 调用、拒绝且不修改、陈旧 Diff 保护、一次性允许、Shell 披露、三种权限、取消、重启与窗口重开恢复。

## 已知限制

- 一个扩展实例持有一个运行时，并把多根 workspace 的第一个文件夹作为默认目录。
- 提供方引导每次配置一条 OpenAI 兼容路由。
- P2 不提供多文件事务、回滚、记住审批、交互式 PTY、语义代码搜索、Git 工作流或远程运行时。
- 任意 Shell 影响无法表示为可靠的执行前 Diff。

## 项目资料

- [开发接续文档](development-handoff.md)
- [P2 完成与复用汇报](p2-completion-and-reuse-report.html)
- [已批准的 P2 计划](p2-plan.md)
- [完整 P2 验收教程](p2-acceptance.md)
- [P2.1 引导验收教程](p2-1-acceptance.md)
- [VS Code 扩展参考](../../apps/vscode/README.md)
- [Host 运行时决策](../../.agents/notes/implemented/feature/2026-08-24-vscode-host-stdio-runtime.md)
- [模型与权限决策](../../.agents/notes/implemented/feature/2026-08-24-vscode-model-permission-onboarding.md)
- [P2 编码闭环决策](../../.agents/notes/implemented/feature/2026-08-24-vscode-p2-coding-loop.md)
