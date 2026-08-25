# `@deepseek-ai/dsh-vscode-app`

[English](README.md) | 中文

这是 `vscode` profile 使用的长驻 Host 组合。[`cordis.patch.yml`](cordis.patch.yml) 叠加在 [`dsh-base`](../base/README.md) 之上，禁用模块 HMR，替换 base 权限表，并插入 JSON 持久化、Workspace 注册表、browse 目录提供方、`ctx.apiProxy` 及其 stdio 载体。它不挂载 HTTP server、浏览器运行时、client 插件名单、stdout logger、模型轮次 runner 或 Code Mode。

VS Code Extension Host 持有进程和 workspace 选择。因此这个组合包保留文件系统列表与目录创建能力，供后续 Host API 界面使用，但不会打开原生目录选择器。stdout 专门用于换行分隔 JSON-RPC，关闭操作则通过启动器提供的 `ctx.appExit` 钩子请求进程退出。

权限表仅包含 `read-only`（`read-only` + `never`）、`confirm-changes`（`read-only` + `ask`）和 `workspace-write`（`workspace-write` + `ask`）。新会话默认使用 `confirm-changes`。Settings namespace 仍为 `permission`，因此客户端通过既有配置 API 修改未来会话默认值，不会引入 VS Code 专用持久化路径。

该 profile 保留 P2 审批 UI 使用的文件系统 `write` 与 `edit` 及原生 Shell 升级。它禁用 `str-replace-editor`、subagent 创建与 fork、workflow 和 Ralph，因为这些修改路径无法提供同等的顶层准确 Diff 或命令关联。新的修改工具必须先具备客户端可复现的执行前视图，并与原始一次性审批请求绑定，才能加入组合。

## 模型体验

通过该组合包权限表所选择的 base 审批与沙箱 consumer 间接产生影响；这个组合包不贡献任何模型可见文本。

#### KV Cache 影响

无直接影响；这个组合包不添加请求前缀内容。

## 已知限制与暂缓事项

- **仅包含 Host 组合**：客户端必须持有进程启动并使用 stdio 载体通信；直接运行该 profile 会持续等待 stdin。
- **同一进程内没有 Web 后备方案**：HTTP 和浏览器配置行仍单独位于 `dsh-web-app`；在这里添加它们会破坏 stdout 与生命周期的归属。
- **没有修改工具后备方案**：不受支持的组合或嵌套修改路径保持不可用，不会得到无法证明准确影响的通用审批。
