# DeepSeek Harness VS Code 扩展

[English](README.md) | 中文

这个 workspace 构建适用于 VS Code 1.106 及以上版本的 `deepseek-ai.dsh-vscode` 扩展。它持有一个本地 DSH 子进程，并提供完整 P2 对话闭环：持久会话与历史、流式 Markdown、Host 提供的工具卡片、有界编辑器上下文、本地 Skill、按会话模型与权限、原生文件 Diff 和一次性审批。

## 开发

启动 Extension Development Host 前，先构建 Host 包与扩展：

```powershell
pnpm run build:lib:host
pnpm --filter @deepseek-ai/dsh-vscode run build
code --extensionDevelopmentPath="E:\E_AI\DSH\deepseek-harness-myPcVs\apps\vscode\extension" "E:\E_AI\DSH\deepseek-harness-myPcVs"
```

打包后的扩展默认运行 `dsh --profile vscode`。`PATH` 中没有 `dsh` 时，将 `dsh.runtime.command` 设为已安装的 Node 可执行文件，并将 `dsh.runtime.args` 设为已构建 CLI 入口的绝对路径，后接 `--profile`、`vscode`。`dsh.runtime.cwd` 默认使用第一个 workspace 文件夹。没有打开工作区文件夹时，启动会直接提示原因，不会把 VS Code 安装目录当作项目目录；高级启动仍可显式填写 `dsh.runtime.cwd`。中文运行时命令提供生命周期控制和诊断。

**DSH：配置 OpenAI 兼容模型**通过 DSH settings 写入非机密路由元数据，并把密钥保留在 VS Code SecretStorage。远程端点必须使用 HTTPS；回环 HTTP 支持本地网关。模型选择器会改变活动会话的准确提供方／模型组合。

对话视图位于右侧辅助侧边栏；其他视图获得焦点时，Webview 状态仍然保留。醒目的新建对话按钮固定在可滚动记录上方，独立设置页面集中显示运行时、模型、权限和高级设置。提供方信息与凭据分别保存在 DSH 用户设置和 VS Code SecretStorage 中，隐藏或重新创建视图不需要重新配置模型。

对话视图创建或选择普通 Host 会话，恢复最新历史页，加载更早页面，发送排队提示词，取消活动轮次，并渲染不含私有推理文本的流式助手 Markdown。尾页校准会持续到订阅序号完整，并在实时事件出现序号缺口时再次启动。权限选择器通过 `/permission` 写入活动会话；默认权限操作控制未来会话。三种选择是**只读**、**确认后更改**和**工作区可写**；新的 VS Code 会话默认使用**确认后更改**。

上下文命令捕获当前选区、当前或 Explorer 文件、Explorer 文件夹清单或工作区清单。标签是可移除的草稿状态；准确的有界文本进入持久用户消息。二进制、无效 UTF-8 和超限输入会明确失败。项目 Skill 位于 `<workspace>/.agents/skills`；用户 Skill 位于 `<DSH_HOME>/skills`。创建命令校验小写 kebab-case，绝不覆盖，打开 `SKILL.md`，并刷新开头斜杠补全。

对于 Host `write` 与定向 `edit` 调用，审批卡片显示在对话记录之后、输入框正上方；新请求到达时会自动滚入视野。卡片根据当前 UTF-8 内容和准确拟议结果打开原生 VS Code Diff。目标变化或超限时会拒绝过期审批。Shell 审批展示准确命令、工作目录、理由，以及任意命令影响无法作为 Diff 预测的限制。

## 进程与 Secret 所有权

Extension Host 持有进程、Host API、文件系统审阅与凭据。CSP Webview 只接收经过校验、可序列化的展示模型。停止操作请求 `dsh/shutdown`，等待配置的截止时间，再终止无响应的子进程；dispose（资源释放）使用同一路径。stdout 只承载协议帧，stderr 承载诊断。子进程接收操作系统与 DSH 位置白名单及扩展持有的凭据引用，绝不接收环境中的提供方凭据。提供方 settings、Host 响应、输出、快照和诊断都不包含 SecretStorage 值。

## 配置限制

`dsh.context.maxFileBytes`、`maxTotalBytes` 与 `maxFolderFiles` 限制提示词上下文。`dsh.conversation.historyPageMessages`、`maxToolOutputChars` 与 `maxDiffBytes` 限制历史和展示工作。运行时握手与停止设置控制进程截止时间。无效或不安全输入会失败，不会被静默截断。

## 验证

`host-client.spec.ts`、`event-fold.spec.ts` 与 `runtime-manager.spec.ts` 覆盖分帧、类型化关联、流、取消、校准、生命周期与重启。对话、上下文、Skill 和审批测试覆盖 P2 产品逻辑。`conversation-flow.snapshot.spec.ts` 启动真实 stdio 夹具进程，证明恢复、上下文与 Skill 持久化、工具生命周期、拒绝、一次性应用和推理脱敏。`dsh-runtime.e2e.spec.ts` 在没有提供方密钥的情况下启动已构建产品 profile；`view.snapshot.spec.ts` 记录组装后的 Webview；`extension-host.ts` 在已安装的 Extension Host 中检查贡献命令。

有序真实提供方流程见 [P2 验收教程](../../docs/vscode/p2-acceptance.md)。

## 已知限制

- 一个扩展实例持有一个进程，并把多根 workspace 的第一个文件夹作为默认运行目录。
- 提供方引导每次配置一条 OpenAI 兼容路由；其他适配器仍可通过此 UI 之外的 DSH settings 配置。
- P2 不提供多文件事务、回滚、记住审批、交互式 PTY、语义代码搜索、Git 工作流或远程 DSH 连接。
- 文件 Diff 审阅覆盖准确的 `write` 与字面 `edit` 请求。任意 Shell 影响无法预测，不受支持的修改工具路径从 `vscode` profile 中排除。
