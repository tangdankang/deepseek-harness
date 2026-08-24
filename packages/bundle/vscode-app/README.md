# `@deepseek-ai/dsh-vscode-app`

English | [中文](README.zh.md)

The long-lived Host composition for the `vscode` profile. [`cordis.patch.yml`](cordis.patch.yml) rides over [`dsh-base`](../base/README.md), disables module HMR, replaces the base permission table, and inserts JSON persistence, the Workspace registry, the browse directory provider, `ctx.apiProxy`, and its stdio carrier. It mounts no HTTP server, browser runtime, client plugin roster, stdout logger, or model turn runner.

The VS Code Extension Host owns the process and workspace selection. This bundle therefore keeps filesystem listing and directory creation for later Host API surfaces but does not open a native directory picker. Stdout belongs exclusively to newline-delimited JSON-RPC, while shutdown delegates process exit to the launcher-provided `ctx.appExit` hook.

The permission table contains exactly `read-only` (`read-only` + `never`), `confirm-changes` (`read-only` + `ask`), and `workspace-write` (`workspace-write` + `ask`). `confirm-changes` is the default for new sessions. The Settings namespace remains `permission`, so clients update the future-session default through the existing configuration API without introducing a VS Code-only persistence path.

## Model Experience

Indirectly, through the base approval and sandbox consumers selected by this bundle's permission table; this bundle contributes no model-visible text.

#### KV Cache effect

None directly; the bundle adds no request-prefix content.

## Known Limitations and Deferred Work

- **Host-only composition** — a client must own process launch and speak the stdio carrier; running the profile directly leaves it waiting on stdin.
- **No Web fallback in the same process** — HTTP and browser rows remain separate in `dsh-web-app`; adding them here would violate stdout and lifecycle ownership.
