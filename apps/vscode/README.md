# DeepSeek Harness for VS Code

English | [中文](README.zh.md)

This workspace builds the `deepseek-ai.dsh-vscode` extension for VS Code 1.106 or later. It owns one local DSH child process and presents the complete P2 conversation loop: durable sessions and history, streaming Markdown, Host-authored tool cards, bounded editor context, local Skills, per-session models and permissions, native file Diffs, and one-shot approvals.

## Development

Build the Host packages and extension before starting an Extension Development Host:

```powershell
pnpm run build:lib:host
pnpm --filter @deepseek-ai/dsh-vscode run build
code --extensionDevelopmentPath="E:\E_AI\DSH\deepseek-harness-myPcVs\apps\vscode\extension" "E:\E_AI\DSH\deepseek-harness-myPcVs"
```

The packaged extension runs `dsh --profile vscode` by default. When `dsh` is absent from `PATH`, set `dsh.runtime.command` to the installed Node executable and `dsh.runtime.args` to the absolute built CLI entry followed by `--profile`, `vscode`. `dsh.runtime.cwd` defaults to the first workspace folder. Starting without an open workspace folder fails with a direct diagnostic instead of using the VS Code installation directory; an explicit `dsh.runtime.cwd` remains available for advanced launches. The Chinese runtime commands expose lifecycle control and diagnostics.

**DSH：配置 OpenAI 兼容模型** writes non-secret route metadata through DSH settings and keeps the key in VS Code SecretStorage. Remote endpoints require HTTPS; loopback HTTP supports local gateways. The model selector changes the active session's exact provider/model pair.

The conversation view lives in the Secondary Side Bar and retains its Webview state while other views have focus. Its prominent new-conversation control remains above a scrollable transcript; a separate Settings page contains runtime, model, permission, and advanced settings. Provider facts and credentials remain in DSH user settings and VS Code SecretStorage, so hiding or recreating the view does not require model reconfiguration.

The view creates or selects ordinary Host sessions, restores the newest history page, loads older pages, sends queued prompts, cancels the active turn, and renders streaming assistant Markdown without private reasoning text. Tail reconciliation repeats until the subscribed sequence is complete and starts again when a live sequence gap appears. Its permission selector writes the active session through `/permission`; the default-permission action controls future sessions. The three choices are **Read-only**, **Confirm changes**, and **Workspace writes**; new VS Code sessions default to **Confirm changes**.

Context commands capture the current selection, current or Explorer file, Explorer folder listing, or workspace listing. Tags are removable draft state; exact bounded text enters the durable user message. Binary, invalid UTF-8, and oversized inputs fail visibly. Project Skills live under `<workspace>/.agents/skills`; user Skills live under `<DSH_HOME>/skills`. Creation commands validate lowercase kebab-case, never overwrite, open `SKILL.md`, and refresh leading-slash completion.

For Host `write` and targeted `edit` calls, approval cards appear after the transcript immediately above the composer and scroll into view when a request arrives. They open a native VS Code Diff built from current UTF-8 content and the exact proposed result. A changed or oversized target rejects the stale approval. Shell approvals display the exact command, working directory, reason, and the limitation that arbitrary command effects cannot be predicted as a Diff.

## Process and Secret Ownership

The Extension Host owns the process, Host API, filesystem review, and credentials. The CSP Webview receives only a validated serializable presentation model. Stop requests `dsh/shutdown`, waits for the configured deadline, then terminates an unresponsive child; disposal uses the same path. Stdout carries only protocol frames and stderr carries diagnostics. The child receives an operating-system and DSH-location allowlist plus extension-owned credential references, never ambient provider credentials. Provider settings, Host responses, output, snapshots, and diagnostics never contain SecretStorage values.

## Configuration Limits

`dsh.context.maxFileBytes`, `maxTotalBytes`, and `maxFolderFiles` bound prompt context. `dsh.conversation.historyPageMessages`, `maxToolOutputChars`, and `maxDiffBytes` bound history and presentation work. Runtime handshake and stop settings govern process deadlines. Invalid or unsafe inputs fail instead of being truncated silently.

## Verification

`host-client.spec.ts`, `event-fold.spec.ts`, and `runtime-manager.spec.ts` cover framing, typed correlation, streams, cancellation, reconciliation, lifecycle, and restart. Conversation, context, Skill, and approval tests cover the P2 product logic. `conversation-flow.snapshot.spec.ts` starts a real stdio fixture process and proves restore, context plus Skill persistence, tool lifecycle, rejection, one-shot application, and reasoning redaction. `dsh-runtime.e2e.spec.ts` boots the built product profile without a provider key; `view.snapshot.spec.ts` records the assembled Webview; `extension-host.ts` checks contributed commands in an installed Extension Host.

The ordered real-provider procedure is the [P2 acceptance tutorial](../../docs/vscode/p2-acceptance.md).

## Known Limitations

- One extension instance owns one process and uses the first folder of a multi-root workspace as its default runtime directory.
- Provider onboarding configures one OpenAI-compatible route at a time; other adapters remain configurable through DSH settings outside this UI.
- P2 has no multi-file transaction, rollback, remembered approvals, interactive PTY, semantic code search, Git workflow, or remote DSH connection.
- File Diff review covers exact `write` and literal `edit` requests. Arbitrary Shell effects cannot be predicted, and unsupported modifying tool paths are excluded from the `vscode` profile.
