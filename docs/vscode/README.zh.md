# VS Code 项目阶段性总结：P0–P2.1

[English](README.md) | 中文

本文记录 DeepSeek Harness VS Code 项目的阶段结果。P1 与 P2.1 均于 2026-08-24 通过验收，完整 P2 计划与 D1–D7 已获批准。P2.2 尚未开始。

## 阶段状态

| 阶段 | 结果 | 当前含义 |
| --- | --- | --- |
| P0 | 已完成 | 已具备扩展工作区、专用 `vscode` profile、Host API stdio 载体、构建路径与开发调试路径。 |
| P1 | 已验收 | VS Code 可以启动、观察、停止和重启一个本地 DSH 运行时，并显示状态与脱敏诊断。 |
| P2.0 | 已验收 | [P2 计划](p2-plan.md)与 D1–D7 定义了已获批准的最小可用开发闭环。 |
| P2.1 | 已验收 | 安全的 OpenAI 兼容模型引导和三种 VS Code 权限选择已通过用户验收；后续工作包尚未开始。 |

## 已交付系统

| 组件 | 职责 |
| --- | --- |
| [`apps/vscode`](../../apps/vscode/README.md) | VS Code 工作区扩展、活动栏容器、侧边栏控制、状态栏、命令、运行时所有权与 Extension Host 测试。 |
| [`packages/host/apiproxy-stdio`](../../packages/host/apiproxy-stdio/README.md) | 基于 stdin/stdout 的版本化逐行 JSON-RPC 载体，包含协议初始化与优雅关闭。 |
| [`packages/bundle/vscode-app`](../../packages/bundle/vscode-app/README.md) | 长驻 `vscode` Host 组合，包含持久化、Workspace 服务、Host API 分发与 stdio 载体。 |
| [`packages/host/apiproxy/src/dispatch.ts`](../../packages/host/apiproxy/src/dispatch.ts) | 与传输无关的 Host API 方法分发，由现有载体和新增 stdio 载体共同使用。 |

## P1 用户体验

- 活动栏提供 DeepSeek Harness 容器与连接视图。
- 侧边栏和状态栏显示已停止、启动中、已连接、停止中与错误状态。
- **DSH: Start Runtime**、**DSH: Stop Runtime** 与 **DSH: Restart Runtime** 共同管理一个子进程，并收敛并发的生命周期请求。
- 优雅停止会请求 `dsh/shutdown`；子进程超过配置期限仍未响应时会被终止。
- **DeepSeek Harness** 输出通道保留生命周期与错误诊断，并先对疑似凭据文本进行脱敏。

## 验证结果

| 证据 | 结果 |
| --- | --- |
| P0/P1 定向测试 | 7 个测试文件、59 项测试通过。 |
| 已构建 DSH 运行时冒烟测试 | 真实构建的 CLI 完成 `vscode` profile 握手与优雅关闭。 |
| 已安装的 VS Code Extension Host | 扩展发现、激活及全部 5 个贡献命令通过。 |
| 静态与包级门禁 | 已交付范围的 typecheck、lint、Knip、工作区约束、publint、翻译配对、包 invariant、Cordis 配置与运行时闭包检查通过。 |
| 文档门禁 | `doc-sync` 的 28 个叶级检查中 27 个通过；剩余 Windows 符号链接检查因已接受的 Developer Mode/EPERM 环境限制失败。 |
| 仓库环境基线 | 已接受的基线仍为 12,877 项通过、59 项跳过、36 项失败：其中 32 项为 Windows 符号链接 EPERM，4 项为全量测试超时。P1 使用定向测试完成验收，没有重新定义该基线。 |

## P2.1 阶段结果

- **DSH: Configure OpenAI-compatible Model** 通过 Host settings API 写入非机密路由和未来会话模型值，将密钥保留在 VS Code SecretStorage，并只使用生成的 `DSH_VSCODE_*_API_KEY` 引用重新启动自有子进程。
- **DSH: Select Default Permission** 通过 `permission` Settings namespace 写入未来会话默认值。
- `vscode` profile 仅提供**只读**、**确认后更改**和**工作区可写**；默认值为**确认后更改**。
- 定向配置、运行时、bundle、侧边栏快照、TypeScript、Host 构建、扩展构建与已构建 profile 测试均通过。已构建 profile 测试证明 DSH 收到路由与默认模型，而密钥没有进入 settings 响应。
- 用户已于 2026-08-24 验收 P2.1。用户明确要求开始之前，P2.2 仍保持未启动状态。

## 安全与模型状态

- 扩展向子进程传递操作系统与 DSH 位置变量白名单，不继承环境中的模型凭据。
- 扩展管理的密钥保留在 VS Code SecretStorage，并且只通过生成的凭据引用注入；提供方 settings 与 Host 响应始终不含密钥值。
- 对话中曾提供的服务商配置值没有进入源文件、日志、快照或生成文档。
- 真实提供方验收前必须轮换已经披露的凭据；P2.1 测试只使用生成的夹具值。

## 已知限制

- VS Code 视图中尚无对话输入框和会话记录。
- 扩展尚未消费 Host mux 事件，无法显示流式助手文本或工具生命周期更新。
- 当前文件、选区、文件、文件夹与工作区上下文尚不能加入提示词。
- 会话列表、切换、历史分页与重启恢复尚无 VS Code 展示界面。
- 逐操作审批尚无 VS Code UI；只有模型引导并不能使该 profile 具备代码任务能力。

## 项目文档

- [开发接续文档](development-handoff.md)向新的编码智能体提供当前状态、协作规则与 P2.2 入口。
- [P2.1 验收教程](p2-1-acceptance.md)记录已经完成的手工验证。
- 已批准的实现顺序见 [P2 最小可用开发闭环计划](p2-plan.md)。
- P0/P1 的架构决策记录在 [VS Code Host stdio 运行时 Agent Note](../../.agents/notes/implemented/feature/2026-08-24-vscode-host-stdio-runtime.md)。
- P2.1 的 secret 与权限所有权记录在 [VS Code 模型与权限引导 Agent Note](../../.agents/notes/implemented/feature/2026-08-24-vscode-model-permission-onboarding.md)。
- 独立中文审阅版将本总结与 P2 提案合并在 [`stage-summary-and-p2-plan.html`](stage-summary-and-p2-plan.html) 中。
