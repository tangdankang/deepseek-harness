# Agent Note: VS Code-owned Host stdio runtime

Status: implemented

English | [中文](2026-08-24-vscode-host-stdio-runtime.zh.md)

## Problem

A VS Code workspace extension needs a long-lived DSH process whose lifecycle and failures are visible in the editor. Reusing the browser composition would also start an HTTP server and Web client that the editor does not consume, while extending ACP or the public SDK protocol would couple editor UI traffic to automation semantics. The first stage needs only connection ownership, but the transport must already preserve the complete Host API request and event vocabulary required by later stages.

## Decision

**The Extension Host owns one DSH child process.** It starts a configurable command that defaults to `dsh --profile vscode`, performs version initialization plus Host and settings readiness requests, and exposes starting, connected, stopping, stopped, and error states through editor surfaces. Each readiness request receives its own configured deadline. Graceful stop requests protocol shutdown before process termination, and disposal follows the same path. A startup failure retains the error state while its child is terminated; only a process that exits after connecting becomes an unexpected-exit error.

**A dedicated stdio carrier wraps the existing Host API.** `dsh-host-apiproxy` owns carrier-independent, compiler-locked request dispatch and response-value validation. The fetch handler, fetch client, `dsh-host-apiproxy-stdio`, and VS Code client use those Host method and domain schemas instead of defining transport-local copies. The stdio carrier preserves full server requests, including answerable `rpcId` values; exposes explicit mux/host subscription settlement; and maps client cancellation to the matching in-flight Host request without changing Host API domain types.

**The Extension Host reconciles each process generation from Host authority.** It opens mux and host subscriptions before reading session history, buffers live events while the tail page is pending, deduplicates overlap by session-event sequence, and repulls once when the subscription baseline is ahead. Replayed approval requests replace process-local pending interaction state. A restart opens new subscriptions and rereads every tracked session; process exit or input closure rejects unary and stream waiters from the prior generation.

**The `vscode` profile is a minimal Host composition.** `dsh-vscode-app` layers storage, Workspace, browse-directory support, `ctx.apiProxy`, and the stdio carrier over `dsh-base`. It mounts no HTTP, Web, or stdout logging rows. The normal `web` and `headless` templates remain separate compositions.

**The extension admits only explicitly owned model credentials.** The child environment admits operating-system and DSH-location variables plus extension-managed references loaded from VS Code SecretStorage; ambient provider variables remain excluded, and diagnostics receive a final credential-redaction pass. The [model and permission onboarding decision](2026-08-24-vscode-model-permission-onboarding.md) owns the write path and runtime injection rules.

## Alternatives considered

**Extend ACP or the SDK protocol.** Rejected because those protocols serve automation and supported SDK clients, while editor features consume the product Host API and its bidirectional interaction events.

**Reuse the Web HTTP and SSE carriers.** Rejected because a loopback server adds port, origin, authentication, and shutdown ownership that a parent-child stdio channel does not need.

**Run one DSH process per editor operation.** Rejected because sessions, event subscriptions, pending interactions, and later streaming conversation state require one durable connection.

## Consequences

The extension can be activated and its runtime lifecycle can be accepted without any model call or secret. Model configuration, conversation, Diff, and approval stages use the same process, typed request path, event fold, and Host API without replacing the carrier. The carrier protocol is independently versioned from the Host domain methods, and reconnect means starting a fresh child and reconciling from history plus live streams rather than reattaching to an existing process.
