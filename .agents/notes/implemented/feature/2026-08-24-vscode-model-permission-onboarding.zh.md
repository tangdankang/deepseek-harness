# Agent Note: VS Code 模型与权限引导

Status: implemented

[English](2026-08-24-vscode-model-permission-onboarding.md) | 中文

## 问题

VS Code 扩展需要足够的提供方与权限配置来准备编码会话，同时不能创建第二套 DSH 配置系统，也不能让凭据进入编辑器 settings、Host 响应、诊断或快照。`vscode` profile 还继承了 base 权限选项，其中包含不受限宿主访问，也没有区分确定性拒绝与一次性确认。

## 决策

**VS Code SecretStorage 持有扩展管理的提供方密钥。** 引导通过密码输入接收密钥，将其存储在生成的提供方凭据引用下，绝不通过 Host API 发送密钥值。每次运行时启动都会重新构造经过清理的环境，并且只加入扩展持有的 `DSH_VSCODE_*_API_KEY` 值；环境中的提供方变量仍被排除。再次配置同一路由会轮换同一个 SecretStorage 条目。

**DSH settings 持有所有非机密提供方事实。** 扩展通过带 revision 校验的 `settings.mutate` 操作向 `llm-pi-ai` 写入 OpenAI 兼容 profile，再在 `agent-default-model` 中选择提供方和模型。提供方路由采用小写 kebab-case，因此将连字符替换为下划线可以生成一一对应的凭据引用。远程端点必须使用 HTTPS；回环 HTTP 仍可用于本地网关。默认模型写入失败时，只要回滚写入仍基于当前 revision，扩展就会恢复之前的提供方 profile 和 SecretStorage 值。

**`vscode` bundle 持有三种权限选择。** `read-only` 组合只读沙箱与确定性 `never` 审批策略，`confirm-changes` 组合只读与 `ask`，`workspace-write` 组合工作区写入与 `ask`。该 bundle 以 `confirm-changes` 为默认值，不暴露 danger-full-access preset。扩展只写入 `permission.defaultPreset`，因此已有会话保留其固定权限，之后的会话使用保存的默认值。

已连接的侧边栏显示 `host.describe` 返回的有效默认提供方／模型，以及脱敏 settings 返回的默认权限。配置命令会在需要时启动自有 Host；提供方变更会重新启动它，因此新存储的凭据只进入该子进程。

## 考虑过的替代方案

**通过 `credentials.set` 写入密钥。** 此界面不采用，因为已经批准的编辑器所有权要求扩展管理的值进入 VS Code SecretStorage，而 `credentials.set` 会通过 DSH home 提供方持久化。

**把提供方元数据和密钥存入 VS Code settings。** 不采用，因为 settings 是明文且可同步的配置界面，同时还会重复现有 DSH settings namespace。

**继承 Extension Host 环境中的提供方变量。** 不采用，因为无关的编辑器或 Shell 环境可能静默选择另一个租户的凭据，扩展也无法识别自己委托了什么。

**保留 base 权限表，只在扩展中更改显示名称。** 不采用，因为只在展示层过滤仍会使不受限访问可通过 Host 使用，也无法在真正执行策略的运行时组合中编码已经审阅的三模式规则。

## 验证

定向测试覆盖提供方与 URL 校验、SecretStorage 隔离、带 revision 的写入、回滚、准确权限组合、Host settings 传输、侧边栏渲染与 Extension Host 命令注册。已构建 profile 测试通过真实 stdio Host API 写入夹具路由，并确认路由和默认模型可见，而夹具密钥不在任何返回的 settings descriptor 中。

## 结果

模型引导先于对话 UI 提供，但不会运行模型轮次。向导每次配置一条 OpenAI 兼容路由；其他适配器协议仍可通过此界面之外的 DSH settings 使用。提供方变更会重新启动自有运行时，默认权限变更只影响之后创建的会话。按会话切换与一次性审批控件仍由后续 P2 工作包持有。
