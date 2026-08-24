# VS Code Development Handoff: After P2.1

English | [中文](development-handoff.zh.md)

This reference lets a new coding agent continue the DeepSeek Harness VS Code project without the prior conversation. It records the accepted state, user collaboration rules, code entry points, environment constraints, and the next work package. Read this document and its linked owners before changing code.

## Handoff Status

- Repository: `E:\E_AI\DSH\deepseek-harness-myPcVs`, branch `master`.
- The commit containing this document is the P0–P2.1 checkpoint. P1, P2.0, and P2.1 passed user acceptance on 2026-08-24; P2.2 has not started.
- Inspect `git status --short` before work. Preserve any later user changes and never reset, discard, or overwrite them to recreate this checkpoint.
- Node `v24.19.0`, pnpm `11.7.0`, and VS Code `1.134.0` are installed on Windows. The extension build output is ignored and must be rebuilt before launching an Extension Development Host.

## Required Collaboration Rules

- Work on one approved P2 work package at a time. Report a stage result and wait for explicit user acceptance before starting the next package.
- When an ambiguity would materially change behavior, security, scope, or user experience, state it and wait for the user instead of choosing silently.
- Give acceptance procedures and stage reports in Chinese. Do not advance from P2.2 to P2.3 during the same implementation turn.
- Use focused verification for the changed behavior. The accepted repository baseline remains 12,877 passed, 59 skipped, and 36 failed tests: 32 Windows symlink `EPERM` cases and 4 full-suite timeouts. Do not turn removal of that baseline into P2.2 work.
- If focused P2.2 verification proves that a local development dependency is missing, the user permits a safe in-scope installation. Report any dependency that cannot be installed safely or automatically.

## Sources of Truth

| Document | What it owns |
| --- | --- |
| [Stage summary](README.md) | Accepted P0–P2.1 product state, verification baseline, security state, and known limits. |
| [Approved P2 plan](p2-plan.md) | D1–D7, scope, work-package order, acceptance boundaries, and the complete manual P2 flow. |
| [VS Code extension README](../../apps/vscode/README.md) | Extension commands, runtime configuration, process and secret ownership, build path, and focused checks. |
| [Architecture](../architecture.md) | Repository composition and extension points that must be read before changing `packages/`. |
| [Defensive patterns](../defensive-patterns.md) | Lifecycle, concurrency, subprocess, cancellation, and teardown rules required for P2.2. |
| [Host stdio runtime decision](../../.agents/notes/implemented/feature/2026-08-24-vscode-host-stdio-runtime.md) | Process ownership, carrier choice, profile composition, credential admission, and startup failure precedence. |
| [Model and permission onboarding decision](../../.agents/notes/implemented/feature/2026-08-24-vscode-model-permission-onboarding.md) | SecretStorage ownership, settings writes, rollback, permission choices, and restart behavior. |

Repository and subtree `AGENTS.md` files remain mandatory. Documentation changes use bilingual pairs and re-record their `.i18n.yaml` files.

## Delivered Baseline

P0 and P1 add the VS Code workspace extension, the `vscode` profile, a newline-delimited JSON-RPC Host carrier over stdio, transport-independent Host dispatch, one owned child-process lifecycle, visible connection state, redacted diagnostics, and graceful shutdown. P2.1 adds OpenAI-compatible provider onboarding, VS Code SecretStorage key ownership, generated credential references, Host settings mutations, and the three approved future-session permission defaults.

The runtime gives protocol initialization, Host description, and settings description independent startup deadlines. A failed startup retains its first diagnostic while cleanup terminates the child; only an exit after connection becomes an unexpected-exit error. Preserve both behaviors when extending subscriptions and reconnect handling.

The extension does not yet provide conversation UI, session history, live mux event consumption, editor context, Skill UI, Diff review, or per-operation approval. Model onboarding alone does not authorize a coding task through the extension.

## Code Entry Points

| Path | Current responsibility and P2.2 relevance |
| --- | --- |
| [`apps/vscode/src/host-client.ts`](../../apps/vscode/src/host-client.ts) | Client-side JSON-RPC framing, initialization, typed Host requests, and pending request ownership; primary P2.2 client entry point. |
| [`apps/vscode/src/runtime-manager.ts`](../../apps/vscode/src/runtime-manager.ts) | Child lifecycle, startup readiness, settings access, stop/restart, exit observation, and visible error precedence. |
| [`apps/vscode/src/extension.ts`](../../apps/vscode/src/extension.ts) | VS Code activation, commands, SecretStorage wiring, runtime configuration, and disposal. |
| [`apps/vscode/src/view.ts`](../../apps/vscode/src/view.ts) | Current connection/configuration Tree View; P2.2 must not prematurely implement the P2.3 conversation Webview. |
| [`packages/host/apiproxy-stdio/src/protocol.ts`](../../packages/host/apiproxy-stdio/src/protocol.ts) | Versioned physical stdio messages and validation. |
| [`packages/host/apiproxy-stdio/src/index.ts`](../../packages/host/apiproxy-stdio/src/index.ts) | Server-side stdio request, subscription, response, and shutdown ownership. |
| [`packages/host/apiproxy/src/dispatch.ts`](../../packages/host/apiproxy/src/dispatch.ts) | Carrier-independent Host API unary dispatch shared with the fetch carrier. |
| [`packages/bundle/vscode-app`](../../packages/bundle/vscode-app/README.md) | Assembled long-lived Host profile and its allowed permission presets. |

## Next Work Package: P2.2

Start P2.2 only after the user explicitly requests it. Deliver the typed stdio Host client additions, long-lived `events.mux` and `events.host` subscriptions, server-request responses for approval interactions, request cancellation, rejection of pending operations on process exit, subscription disposal, and reconnect reconciliation. Host API schemas remain the wire authority; do not add a parallel VS Code protocol or reuse the browser Cordis UI shell.

P2.2 stops at the protocol and event-folding foundation. Do not build the conversation Webview, session list, composer, editor context, Skill experience, Diff approval interface, or permission-mode UI for active sessions; those belong to P2.3–P2.6.

Before asking for P2.2 acceptance, tests must cover split input frames, stream termination, historical/live overlap handling, response correlation, cancellation, child exit, disposal, and restart. Report the changed files, commands actually run, remaining limitations, and a short Chinese acceptance procedure, then wait for the user.

## Security and Environment Constraints

- No provider API key belongs in source, settings JSON, command arguments, logs, snapshots, fixtures, or documentation. The credential disclosed in the prior conversation must be rotated before any real-provider test.
- P2.2 protocol work is keyless. Use deterministic fixtures; do not make a real model call merely to validate framing, streams, cancellation, or reconnect behavior.
- The Extension Host child receives only the environment allowlist plus extension-managed credential references. Do not restore ambient provider-variable inheritance.
- `pnpm run doc-sync` has one accepted host-specific failure when the Windows environment cannot create required symlinks with `EPERM`. Run focused document checks and report that exact limitation without treating it as a product regression.
- The local fallback runtime uses the installed Node executable and the built `apps/cli/lib/bin.js --profile vscode` entry when `dsh` is unavailable on `PATH`; the [P2.1 acceptance tutorial](p2-1-acceptance.md) contains the launch procedure.

## Continuation Procedure

The user can start the next stage with: `Read docs/vscode/development-handoff.zh.md completely, then start P2.2 and stop for my acceptance when P2.2 is complete.`

After receiving that instruction, inspect the working tree, read the linked architecture and defensive rules, confirm that P2.2 remains the active scope, implement only that work package, run the smallest relevant checks, update its owning documentation and Agent Note, provide Chinese acceptance steps, and stop before P2.3.
