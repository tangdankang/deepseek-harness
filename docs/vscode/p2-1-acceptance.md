# VS Code P2.1 Acceptance: Model and Permission Onboarding

English | [中文](p2-1-acceptance.zh.md)

This tutorial verifies only P2.1. It does not test chat, model requests, session controls, Diff, or operation approval, which belong to later work packages.

## Prerequisites

- Use VS Code with this repository open and the P1 runtime connection already accepted.
- Rotate any API key previously disclosed in conversation. Do not enter the old key during this acceptance run.
- Keep the replacement key available only for the password input; do not place it in project files, VS Code settings, a terminal command, or the output channel.

## 1. Build and Launch the Extension

Run the following commands from the repository root:

```powershell
Set-Location 'E:\E_AI\DSH\deepseek-harness-myPcVs'
pnpm run build:lib:host
pnpm --filter @deepseek-ai/dsh-vscode run build
code --extensionDevelopmentPath="E:\E_AI\DSH\deepseek-harness-myPcVs\apps\vscode\extension" "E:\E_AI\DSH\deepseek-harness-myPcVs"
```

In the new Extension Development Host, open **DeepSeek Harness** in the activity bar and select **Start**. Press `Ctrl+Shift+P`, run **Preferences: Open User Settings (JSON)**, and add this configuration to the JSON object:

```json
{
  "dsh.runtime.command": "C:\\Program Files\\nodejs\\node.exe",
  "dsh.runtime.args": [
    "E:\\E_AI\\DSH\\deepseek-harness-myPcVs\\apps\\cli\\lib\\bin.js",
    "--profile",
    "vscode"
  ],
  "dsh.runtime.cwd": "E:\\E_AI\\DSH\\deepseek-harness-myPcVs",
  "dsh.runtime.startOnOpen": false
}
```

Acceptance requires the connected state and no error notification.

## 2. Configure the Model

Select **Configure Model** in the sidebar or run **DSH: Configure OpenAI-compatible Model** from the Command Palette. Enter a lowercase kebab-case provider route, provider display name, HTTPS base URL, model id, model display name, and the rotated replacement key. The API key control must mask the entered value.

The extension writes the non-secret provider profile to DSH settings, stores the key in VS Code SecretStorage, and restarts the runtime. After reconnection, the sidebar must show the selected `provider/model` and **Default permission: confirm-changes**.

## 3. Verify the Three Permission Choices

Run **DSH: Select Default Permission** and select each choice once:

1. **只读** must display `read-only` in the connected sidebar.
2. **工作区可写** must display `workspace-write`.
3. **确认后更改** must display `confirm-changes`; leave this choice selected when the check finishes.

These values apply to future sessions. P2.1 has no conversation surface and therefore does not create a session to test per-session switching.

## 4. Verify Persistence and Secret Safety

Open **DSH: Show Runtime Output**. The output may contain lifecycle and redacted error text, but it must not show the API key. Close the Extension Development Host, launch it again with the command from step 1, and start DSH. The same provider/model and `confirm-changes` default must reappear without entering the key again.

Do not expect a chat input, model response, Diff, or approval button in P2.1. Their absence is not a failure in this acceptance run.

## Acceptance Result

P2.1 passes when the runtime connects, the configured provider/model survives restart, all three permission choices are selectable and visible, the final default is `confirm-changes`, and the API key never appears in settings or output. Report any failed step and its visible error before approving the stage.
