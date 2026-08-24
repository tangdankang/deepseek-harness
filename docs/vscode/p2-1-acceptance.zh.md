# VS Code P2.1 验收：模型与权限引导

[English](p2-1-acceptance.md) | 中文

本教程只验证 P2.1。它不测试聊天、模型请求、会话控制、Diff 或逐操作审批；这些能力属于后续工作包。

## 前置条件

- 使用 VS Code 打开本仓库，并且已经通过 P1 运行时连接验收。
- 轮换此前在对话中披露过的所有 API 密钥。本次验收不得输入旧密钥。
- 只在密码输入框中使用替换后的密钥；不要把它写入项目文件、VS Code settings、终端命令或输出通道。

## 1. 构建并启动扩展

在仓库根目录运行：

```powershell
Set-Location 'E:\E_AI\DSH\deepseek-harness-myPcVs'
pnpm run build:lib:host
pnpm --filter @deepseek-ai/dsh-vscode run build
code --extensionDevelopmentPath="E:\E_AI\DSH\deepseek-harness-myPcVs\apps\vscode\extension" "E:\E_AI\DSH\deepseek-harness-myPcVs"
```

在新打开的 Extension Development Host 中，从活动栏打开 **DeepSeek Harness**，然后选择 **Start**。运行时必须显示已连接，并且不能出现错误通知。

## 2. 配置模型

在侧边栏选择 **Configure Model**，或从命令面板运行 **DSH: Configure OpenAI-compatible Model**。依次输入小写 kebab-case 提供方路由、提供方展示名称、HTTPS 基础 URL、模型 ID、模型展示名称，以及轮换后的新密钥。API key 输入控件必须隐藏输入值。

扩展会把非机密提供方 profile 写入 DSH settings，把密钥存入 VS Code SecretStorage，并重新启动运行时。重新连接后，侧边栏必须显示所选 `provider/model` 和 **Default permission: confirm-changes**。

## 3. 验证三种权限选择

运行 **DSH: Select Default Permission**，依次选择每个选项：

1. **只读**：已连接侧边栏必须显示 `read-only`。
2. **工作区可写**：必须显示 `workspace-write`。
3. **确认后更改**：必须显示 `confirm-changes`；本项检查结束时保留该选择。

这些值应用于未来会话。P2.1 尚无对话界面，因此不会创建会话来测试按会话切换。

## 4. 验证持久化与密钥安全

打开 **DSH: Show Runtime Output**。输出可以包含生命周期和脱敏错误文本，但不得显示 API key。关闭 Extension Development Host，使用第 1 步命令重新启动并启动 DSH。不重新输入密钥时，之前的提供方／模型和 `confirm-changes` 默认值必须重新出现。

P2.1 中不应出现聊天输入框、模型回复、Diff 或审批按钮。它们的缺失不属于本次验收失败。

## 验收结果

满足以下条件时 P2.1 通过：运行时连接成功；提供方／模型在重启后恢复；三种权限均可选择且可见；最终默认值为 `confirm-changes`；API key 从未出现在 settings 或输出中。批准本阶段前，请报告任何失败步骤及其可见错误。
