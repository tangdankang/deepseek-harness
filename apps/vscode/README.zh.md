# DeepSeek Harness VS Code 扩展

[English](README.md) | 中文

这个 workspace 构建 `deepseek-ai.dsh-vscode` workspace 扩展。它持有一个本地 DSH 子进程，通过 stdio 执行带版本的换行分隔 JSON-RPC 握手，并在活动栏、状态栏、命令和 **DeepSeek Harness** 输出通道中提供生命周期、OpenAI 兼容模型引导，以及未来会话的默认权限。侧边栏尚不包含对话、Diff 或逐操作审批界面。

## 开发

启动 Extension Development Host 之前，先构建 Host 包和扩展：

```powershell
pnpm run build:lib:host
pnpm --filter @deepseek-ai/dsh-vscode run build
code --extensionDevelopmentPath="E:\E_AI\DSH\deepseek-harness-myPcVs\apps\vscode\extension" "E:\E_AI\DSH\deepseek-harness-myPcVs"
```

打包后的扩展默认执行 `dsh --profile vscode`。如果 `PATH` 中没有安装 `dsh`，请将 `dsh.runtime.command` 设为已安装的 Node 可执行文件，并将 `dsh.runtime.args` 设为已构建的 CLI 入口，后接 `--profile`、`vscode`。`dsh.runtime.cwd` 默认使用第一个已打开的 workspace 文件夹。通过 **DSH: Start Runtime**、**DSH: Stop Runtime** 和 **DSH: Restart Runtime** 验证生命周期。`dsh.runtime.handshakeTimeoutMs` 分别限制协议初始化、Host 描述和 settings 描述请求。首个启动失败或已连接进程的意外退出会显示为明确错误，脱敏后的诊断信息保留在输出通道中。

**DSH: Configure OpenAI-compatible Model** 会收集路由 key、展示名称、基础 URL、模型 ID 和 API key。非机密 profile 数据写入 DSH 的 `llm-pi-ai` 与 `agent-default-model` settings namespace。密钥在引导中只写入，始终保留在 VS Code SecretStorage，并且只通过生成的 `DSH_VSCODE_*_API_KEY` 引用进入重新启动的自有子进程。再次配置同一路由会轮换已存储的值。远程端点必须使用 HTTPS；本地网关仍可使用回环 HTTP。

**DSH: Select Default Permission** 写入未来会话的默认权限。`vscode` profile 只提供**只读**（`read-only` + `never`）、**确认后更改**（`read-only` + `ask`）和**工作区可写**（`workspace-write` + `ask`）；组合默认值为**确认后更改**。该命令不会改变已经创建的会话。

## 进程与 secret 归属

Extension Host 同一时间只持有一个子进程。停止操作会先请求 `dsh/shutdown`，等待配置的截止时间，再终止无响应的子进程；dispose（资源释放）也使用同一路径。stdout 只承载协议，stderr 只承载诊断。子进程只接收操作系统与 DSH 位置变量白名单，以及本扩展明确存储的凭据；绝不继承环境中的模型凭据。提供方设置、Host 响应、输出、快照和诊断都不承载 SecretStorage 中的值，常见凭据形式还会经过最后一道诊断脱敏。

## 验证

`configuration.spec.ts` 覆盖提供方校验、secret 隔离、回滚和权限写入。`runtime-manager.spec.ts` 覆盖真实子进程生命周期与 settings 请求；`dsh-runtime.e2e.spec.ts` 启动已构建的产品 CLI，并证明已配置路由与默认模型抵达 DSH，而密钥不进入 settings；`view.snapshot.spec.ts` 记录侧边栏；`extension-host.ts` 在已安装的 VS Code Extension Host 中验证贡献命令。

## 已知限制

- **尚无对话界面**：已有模型与权限引导，但提示词、会话记录、Diff 与审批控件仍不可用。
- **每个 workspace 一个进程**：多根 workspace 默认使用第一个文件夹作为运行目录；没有按文件夹划分的运行时。
- **仅提供 OpenAI 兼容引导**：向导每次配置一条 `openai-completions` 路由；其他协议仍需通过此界面之外的 DSH settings 编辑。
