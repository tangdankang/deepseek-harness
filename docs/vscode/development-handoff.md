# VS Code Development Handoff: Post-P2 Improvement and Reuse

English | [中文](development-handoff.zh.md)

This reference lets a new coding agent continue the DeepSeek Harness VS Code project without prior conversation. Read it and its linked authorities before changing the implementation.

## Handoff Status

- Repository: `E:\E_AI\DSH\deepseek-harness-myPcVs`, branch `master`.
- P0–P2.7 are implemented and accepted. P1, P2.0, and P2.1 passed user acceptance on 2026-08-24; the complete P2 coding loop passed integrated acceptance on 2026-08-25.
- Inspect `git status --short` before work. Preserve user changes and never reconstruct this checkpoint by resetting, discarding, or overwriting them.
- Windows has Node `v24.19.0`, pnpm `11.7.0`, and VS Code `1.134.0`. Rebuild ignored extension artifacts before starting an Extension Development Host.

## Required Collaboration Rules

- Treat the accepted P2 behavior as the product baseline. New work needs an explicit problem statement, bounded scope, migration decision, and acceptance checkpoint.
- Prioritize product improvement and reuse by other people; do not widen a local usability request into an unrelated repository cleanup.
- Give acceptance procedures and stage reports in Chinese.
- Use focused verification for changed behavior. The accepted repository baseline remains 12,877 passed, 59 skipped, and 36 failed tests: 32 Windows symlink `EPERM` cases and 4 full-suite timeouts. Do not broaden P2 into repairing that baseline.
- Report any environment-owned step that cannot be completed safely. A real provider task requires a rotated credential supplied through VS Code SecretStorage; deterministic assembled-flow tests must remain keyless.

## Sources of Truth

| Document | Ownership |
| --- | --- |
| [Stage summary](README.md) | P0–P2 product state, security posture, and known limits. |
| [P2 completion and reuse report](p2-completion-and-reuse-report.html) | Shareable executive summary, delivered capabilities, evidence, and post-P2 roadmap. |
| [Approved P2 plan](p2-plan.md) | D1–D7, scope, design, work packages, and acceptance boundary. |
| [P2 acceptance tutorial](p2-acceptance.md) | Ordered manual verification of the complete coding loop. |
| [VS Code extension README](../../apps/vscode/README.md) | Commands, configuration, process and secret ownership, and focused checks. |
| [Architecture](../architecture.md) | Repository composition and extension points required before changing `packages/`. |
| [Defensive patterns](../defensive-patterns.md) | Lifecycle, concurrency, subprocess, cancellation, and teardown rules. |
| [Host stdio runtime decision](../../.agents/notes/implemented/feature/2026-08-24-vscode-host-stdio-runtime.md) | Process ownership, carrier, profile composition, credential admission, and startup diagnostics. |
| [Model and permission onboarding decision](../../.agents/notes/implemented/feature/2026-08-24-vscode-model-permission-onboarding.md) | SecretStorage ownership, settings writes, rollback, permissions, and restart behavior. |
| [P2 coding-loop decision](../../.agents/notes/implemented/feature/2026-08-24-vscode-p2-coding-loop.md) | Conversation projection, context persistence, Skill roots, and approval restrictions. |

Repository and subtree `AGENTS.md` files remain mandatory. Documentation changes update both languages and re-record each `.i18n.yaml` pair.

## Delivered Baseline

The extension owns one local `dsh --profile vscode` process and a typed newline-delimited JSON-RPC client. It establishes mux and host streams before history reconciliation, rejects pending work on disconnect, repairs tracked session tails after restart, and keeps provider credentials in VS Code SecretStorage.

The Webview presents ordinary sessions, cold-history restoration and pagination, streaming assistant Markdown, reasoning status without private reasoning text, Host-authored tool cards, cancellation, model selection, and the active permission projection. The Extension Host is the only process and credential owner; the Webview receives a validated serializable view model.

Context tags capture a selection, current or Explorer file, Explorer folder listing, or workspace listing under explicit byte and file limits. Exact rendered sections enter `session.prompt` and therefore the durable user message. Project and user Skills use the existing filesystem provider roots, slash completion, explicit invocation, filesystem refresh, and non-overwriting skeleton creation.

File approvals support exact pre-execution Diff previews for `write` and targeted `edit`, reject stale previews, and send one response for the original approval request. Shell approvals display the exact command, working directory, reason, and the inability to predict every filesystem effect. The `vscode` profile disables modifying tool paths that cannot provide the same top-level review metadata; Code Mode is absent.

## Code Entry Points

| Path | Responsibility |
| --- | --- |
| [`apps/vscode/src/host-client.ts`](../../apps/vscode/src/host-client.ts) | Framing, typed Host requests, streams, cancellation, and pending request ownership. |
| [`apps/vscode/src/event-fold.ts`](../../apps/vscode/src/event-fold.ts) | History/live reconciliation, projections, transient state, and pending interactions. |
| [`apps/vscode/src/runtime-manager.ts`](../../apps/vscode/src/runtime-manager.ts) | Child-process lifecycle, startup, configuration, stop/restart, and reconnect repair. |
| [`apps/vscode/src/conversation.ts`](../../apps/vscode/src/conversation.ts) | Sessions, history, prompts, models, permissions, Skills, context, and approvals. |
| [`apps/vscode/src/conversation-model.ts`](../../apps/vscode/src/conversation-model.ts) | Pure transcript and Host render-intent projection. |
| [`apps/vscode/src/context.ts`](../../apps/vscode/src/context.ts) | Bounded context capture and deterministic durable prompt rendering. |
| [`apps/vscode/src/skills.ts`](../../apps/vscode/src/skills.ts) | Approved Skill roots, watchers, and safe skeleton creation. |
| [`apps/vscode/src/approvals.ts`](../../apps/vscode/src/approvals.ts) | Native Diff documents, exact edit simulation, stale checks, and one-shot responses. |
| [`apps/vscode/src/view.ts`](../../apps/vscode/src/view.ts) | CSP Webview renderer and validated action decoding. |
| [`packages/bundle/vscode-app`](../../packages/bundle/vscode-app/README.md) | Long-lived Host composition, permission choices, and tool restrictions. |

## Accepted P2 Evidence

The user completed the [P2 acceptance tutorial](p2-acceptance.md) with a real provider on 2026-08-25. The accepted path includes runtime and model persistence, ordinary conversation and tools, bounded context, project Skill creation and slash invocation, exact Diff rejection, stale-Diff protection, one-shot approval, Shell disclosure, all three permissions, cancellation, restart, and window-reopen recovery.

The automated assembled flow starts a real stdio fixture process through `RuntimeManager`, creates and restores a session, persists context and Skill invocation, projects tool lifecycle and approvals, proves rejection leaves the file unchanged, proves one-shot allowance applies the exact edit, and verifies that private reasoning text never reaches the view model. A built `vscode` profile smoke covers real bundle boot and Host APIs without a model credential.

## Security and Environment Constraints

- Provider API keys never enter source, settings JSON, command arguments, logs, snapshots, fixtures, or documentation. Credentials disclosed in prior conversation must be rotated before a real provider task.
- The child receives only the environment allowlist and extension-managed credential references; ambient provider variables remain excluded.
- Binary, invalid UTF-8, oversized context, and oversized or stale Diff inputs fail visibly instead of truncating or approving silently.
- A Windows host that cannot create repository test symlinks returns `EPERM` from one `doc-sync` leaf and the NodeNext consumer check. Report the host limitation without classifying it as a product regression.
- When `dsh` is absent from `PATH`, configure the installed Node executable and built `apps/cli/lib/bin.js --profile vscode` fallback described in the acceptance tutorial.

## Next Development Focus

Work after P2 should proceed in three ordered themes:

1. **Stability and onboarding.** Remove manual runtime-path setup, package a reliable launch path, improve first-run diagnosis, preserve settings across ordinary window and view changes, and turn accepted workflows into deterministic regression coverage.
2. **Distribution and reuse.** Produce an installable extension artifact, define supported VS Code/Node/OS versions, document installation and upgrade paths, provide safe configuration export without credentials, and supply reusable project templates and Skills.
3. **Product improvement.** Use observed user friction to improve conversation navigation, approval prominence, recovery, accessibility, localization, diagnostics, and longer-session performance before adding broad new agent capabilities.

Keep SecretStorage as the credential owner, preserve the Host API and session log as the authoritative runtime records, and retain exact pre-execution review for modifying operations. Do not make configuration portability include credential values, and do not weaken review guarantees to simplify packaging.

## Continuation Procedure

Inspect the worktree and current branch, read the linked authorities, and define whether the next request belongs to stability, distribution, or product improvement. Record non-trivial decisions in the owning Agent Note, add keyless assembled evidence for user-visible behavior, update bilingual documentation, run the smallest checks that cover the change, and stop at the requested acceptance boundary.
