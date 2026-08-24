# DeepSeek Harness for VS Code

English | [中文](README.zh.md)

This workspace builds the `deepseek-ai.dsh-vscode` workspace extension. It owns one local DSH child process, performs a versioned newline-delimited JSON-RPC handshake over stdio, and exposes lifecycle, OpenAI-compatible model onboarding, and the default permission for future sessions through the activity bar, status bar, commands, and the **DeepSeek Harness** output channel. The sidebar does not yet contain conversation, Diff, or per-operation approval surfaces.

## Development

Build the Host packages and extension before launching an Extension Development Host:

```powershell
pnpm run build:lib:host
pnpm --filter @deepseek-ai/dsh-vscode run build
code --extensionDevelopmentPath="E:\E_AI\DSH\deepseek-harness-myPcVs\apps\vscode\extension" "E:\E_AI\DSH\deepseek-harness-myPcVs"
```

The packaged extension defaults to `dsh --profile vscode`. When `dsh` is not installed on `PATH`, set `dsh.runtime.command` to the installed Node executable and `dsh.runtime.args` to the built CLI entry followed by `--profile`, `vscode`. `dsh.runtime.cwd` defaults to the first open workspace folder. Use **DSH: Start Runtime**, **DSH: Stop Runtime**, and **DSH: Restart Runtime** to exercise the lifecycle. `dsh.runtime.handshakeTimeoutMs` applies independently to protocol initialization, Host description, and settings description. The first startup failure or an unexpected connected-process exit appears as a visible error and retains redacted diagnostics in the output channel.

**DSH: Configure OpenAI-compatible Model** collects a route key, display names, base URL, model id, and API key. Non-secret profile data is written to the DSH `llm-pi-ai` and `agent-default-model` settings namespaces. The key is write-only in the wizard, remains in VS Code SecretStorage, and reaches a restarted owned child only through its generated `DSH_VSCODE_*_API_KEY` reference. Reconfiguring the same route rotates that stored value. Remote endpoints require HTTPS; loopback HTTP remains available for local gateways.

**DSH: Select Default Permission** writes the default for future sessions. The `vscode` profile exposes only **Read-only** (`read-only` + `never`), **Confirm changes** (`read-only` + `ask`), and **Workspace writes** (`workspace-write` + `ask`); **Confirm changes** is the composition default. This command does not alter an already-created session.

## Process and secret ownership

The Extension Host owns exactly one child at a time. Stop first requests `dsh/shutdown`, waits for the configured deadline, and then terminates an unresponsive child; disposal uses the same path. Stdout is protocol-only and stderr is diagnostic-only. The child receives an allowlist of operating-system and DSH-location variables plus only the credentials explicitly stored by this extension; ambient model credentials are never inherited. Provider settings, Host responses, output, snapshots, and diagnostics do not carry the SecretStorage value, and common credential forms receive a final diagnostic redaction pass.

## Verification

`configuration.spec.ts` covers provider validation, secret isolation, rollback, and permission writes. `runtime-manager.spec.ts` covers real child lifecycle and settings requests, `dsh-runtime.e2e.spec.ts` starts the built product CLI and proves the configured route/default reach DSH without the key entering settings, `view.snapshot.spec.ts` records the sidebar, and `extension-host.ts` verifies the contributed commands in an installed VS Code Extension Host.

## Known Limitations

- **No conversation surface yet** — model and permission onboarding is available, but prompts, transcripts, Diff, and approval controls remain unavailable.
- **One workspace process** — multi-root workspaces use the first folder as the default runtime directory; there is no per-folder runtime.
- **OpenAI-compatible onboarding only** — the wizard configures one `openai-completions` route at a time; other protocols remain editable through DSH settings outside this surface.
