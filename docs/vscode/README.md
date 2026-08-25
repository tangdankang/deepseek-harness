# VS Code Project Stage Summary: P0–P2

English | [中文](README.zh.md)

This reference records the DeepSeek Harness VS Code product state. P1, P2.0, and P2.1 passed user acceptance on 2026-08-24. The complete P2.2–P2.7 coding loop passed integrated user acceptance on 2026-08-25.

## Stage Status

| Stage | State | Result |
| --- | --- | --- |
| P0 | Complete | The architecture, trust boundaries, transport choice, process ownership, and product direction are fixed. |
| P1 | Accepted | The workspace extension owns one local stdio Host, visible lifecycle, redacted diagnostics, graceful shutdown, and a restricted `vscode` profile. |
| P2.0 | Accepted | D1–D7, three permissions, scope, tool restrictions, and the complete acceptance boundary are fixed. |
| P2.1 | Accepted | OpenAI-compatible onboarding stores keys in SecretStorage and writes non-secret settings; the bundle exposes the three approved future defaults. |
| P2.2 | Accepted | Typed Host calls, streams, approval responses, cancellation, event reconciliation, and restart repair. |
| P2.3 | Accepted | Session list/create/switch, history pages, composer, streaming transcript, model selector, cancellation, and Host tool cards. |
| P2.4 | Accepted | Bounded selection/file/folder/workspace context, removable tags, and durable exact prompt text. |
| P2.5 | Accepted | Project/user Skill roots, slash completion, explicit invocation, refresh, folder reveal, and non-overwriting skeletons. |
| P2.6 | Accepted | Active permissions, exact file Diff approvals, stale rejection, Shell disclosure, and modifying-tool restrictions. |
| P2.7 | Accepted | The built profile, keyless assembled flow, real-provider task, and complete manual tutorial all passed. |

## Delivered System

The extension owns one local `dsh --profile vscode` process. Its typed newline-delimited JSON-RPC client establishes mux and host subscriptions before history repair, correlates server requests, supports cancellation, closes pending operations deterministically, and restores tracked sessions after restart. Provider keys remain in VS Code SecretStorage and enter only the scrubbed owned child through generated credential references.

The CSP Webview displays ordinary sessions, restored and paginated history, streaming Markdown, reasoning status without private reasoning text, Host-authored generic/terminal/Diff tool cards, runtime state, model and permission selectors, cancellation, context tags, Skill completion, and approval controls. The Webview receives no process handles, raw Host protocol, filesystem authority, or credentials.

Model-visible context is deterministic durable text with source paths and optional line ranges. Folder and workspace context use bounded listings; binary, invalid UTF-8, and oversized content fail visibly. Project and user Skill commands write only the existing provider roots and never overwrite a resource.

File review is exact for `write` and literal `edit`. The extension computes the proposed right document from current content, binds approval to the current file digest and existence, and rejects stale or unsupported requests. Shell review shows the exact command, working directory, and reason while stating that arbitrary effects cannot be predicted. Composite or nested modifying paths without equivalent top-level evidence are disabled in the profile.

## Verification State

Focused unit tests cover protocol framing, type validation, streams, cancellation, history/live overlap, projections, transcript rendering, context limits, Skill creation, permissions, Diff generation, stale approval, and process teardown. Product snapshots cover the assembled Webview and a keyless end-to-end conversation flow through a real stdio fixture process. A built-profile smoke starts the real `vscode` bundle and exercises Host settings and session APIs without a model key.

Host package builds, extension bundling, TypeScript project builds, focused lint, runtime-closure checks, documentation checks, and diff hygiene form the outgoing verification set. Windows symlink creation can still block one documentation leaf and the NodeNext consumer check with the accepted `EPERM` host limitation.

## Security State

- Provider keys do not enter source, settings JSON, command arguments, Host responses, logs, snapshots, fixtures, or documentation.
- Ambient model credentials are removed from the child environment; only extension-owned values are admitted.
- User text and Markdown cross the Webview boundary only through validated view data; raw HTML and remote resources do not receive CSP authority.
- Context and Diff inputs fail closed on invalid encoding, binary content, size limits, ambiguous edits, unsupported tools, or stale files.
- `read-only`, `confirm-changes`, and `workspace-write` are the only permission choices; danger-full-access and unreviewable modifying tool paths are absent.

## P2 Acceptance Result

The user completed the [P2 acceptance tutorial](p2-acceptance.md) on 2026-08-25. The accepted flow covers runtime and model persistence, ordinary conversation, editor context, explicit Skill invocation, rejection without mutation, stale-Diff protection, one-shot approval, Shell disclosure, all three permissions, cancellation, restart, and window-reopen recovery.

## Known Limits

- One extension instance owns one runtime and defaults a multi-root workspace to its first folder.
- Provider onboarding configures one OpenAI-compatible route at a time.
- P2 has no multi-file transaction, rollback, remembered approvals, interactive PTY, semantic code search, Git workflow, or remote runtime.
- Arbitrary Shell effects cannot be represented as a reliable pre-execution Diff.

## Project Artifacts

- [Development handoff](development-handoff.md)
- [P2 completion and reuse report](p2-completion-and-reuse-report.html)
- [Approved P2 plan](p2-plan.md)
- [Complete P2 acceptance tutorial](p2-acceptance.md)
- [P2.1 onboarding acceptance tutorial](p2-1-acceptance.md)
- [VS Code extension reference](../../apps/vscode/README.md)
- [Host runtime decision](../../.agents/notes/implemented/feature/2026-08-24-vscode-host-stdio-runtime.md)
- [Model and permission decision](../../.agents/notes/implemented/feature/2026-08-24-vscode-model-permission-onboarding.md)
- [P2 coding-loop decision](../../.agents/notes/implemented/feature/2026-08-24-vscode-p2-coding-loop.md)
