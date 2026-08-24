# VS Code Project Stage Summary: P0–P2.1

English | [中文](README.zh.md)

This document records the staged result of the DeepSeek Harness VS Code project. P1 and P2.1 were accepted on 2026-08-24, and the complete P2 plan and D1–D7 are approved. P2.2 has not started.

## Stage Status

| Stage | Result | Current meaning |
| --- | --- | --- |
| P0 | Complete | The extension workspace, dedicated `vscode` profile, Host API stdio carrier, build path, and development launch path exist. |
| P1 | Accepted | VS Code can start, observe, stop, and restart one local DSH runtime with visible state and redacted diagnostics. |
| P2.0 | Accepted | The [P2 plan](p2-plan.md) and decisions D1–D7 define the approved minimum usable development loop. |
| P2.1 | Accepted | Secure OpenAI-compatible model onboarding and the three VS Code permission choices passed user acceptance; later work packages have not started. |

## Delivered System

| Component | Responsibility |
| --- | --- |
| [`apps/vscode`](../../apps/vscode/README.md) | VS Code workspace extension, activity-bar container, sidebar controls, status bar, commands, runtime ownership, and Extension Host tests. |
| [`packages/host/apiproxy-stdio`](../../packages/host/apiproxy-stdio/README.md) | Versioned newline-delimited JSON-RPC carrier over stdin/stdout, with protocol initialization and graceful shutdown. |
| [`packages/bundle/vscode-app`](../../packages/bundle/vscode-app/README.md) | Long-lived `vscode` Host composition with persistence, Workspace services, Host API dispatch, and the stdio carrier. |
| [`packages/host/apiproxy/src/dispatch.ts`](../../packages/host/apiproxy/src/dispatch.ts) | Transport-independent Host API method dispatch shared by the existing carrier and the new stdio carrier. |

## P1 User Experience

- The activity bar exposes a DeepSeek Harness container and a connection view.
- The sidebar and status bar show stopped, starting, connected, stopping, and error states.
- **DSH: Start Runtime**, **DSH: Stop Runtime**, and **DSH: Restart Runtime** own one child process and converge concurrent lifecycle requests.
- Graceful stop requests `dsh/shutdown`; an unresponsive child is terminated after the configured deadline.
- The **DeepSeek Harness** output channel retains lifecycle and error diagnostics after credential-like text is redacted.

## Verification Result

| Evidence | Result |
| --- | --- |
| Focused P0/P1 tests | 7 test files and 59 tests passed. |
| Built DSH runtime smoke | The real built CLI completed the `vscode` profile handshake and graceful shutdown. |
| Installed VS Code Extension Host | Extension discovery, activation, and all five contributed commands passed. |
| Static and package gates | Typecheck, lint, Knip, workspace constraints, publint, translation pairing, package invariants, Cordis configuration, and runtime-closure checks passed for the delivered surface. |
| Documentation gates | 27 of 28 `doc-sync` leaves passed; the remaining Windows symlink check failed with the accepted Developer Mode/EPERM environment limitation. |
| Repository baseline | The accepted baseline remains 12,877 passed, 59 skipped, and 36 failed tests: 32 Windows symlink EPERM cases and 4 full-suite timeout cases. P1 acceptance used focused tests instead of redefining this baseline. |

## P2.1 Stage Result

- **DSH: Configure OpenAI-compatible Model** writes non-secret route and future-session model values through the Host settings API, keeps the key in VS Code SecretStorage, and restarts the owned child with only generated `DSH_VSCODE_*_API_KEY` references.
- **DSH: Select Default Permission** writes the future-session default through the `permission` Settings namespace.
- The `vscode` profile exposes only **Read-only**, **Confirm changes**, and **Workspace writes**; **Confirm changes** is the default.
- Focused configuration, runtime, bundle, sidebar snapshot, TypeScript, Host build, extension build, and built-profile tests pass. The built-profile test proves DSH receives the route and default model while the key remains absent from settings responses.
- The user accepted P2.1 on 2026-08-24. P2.2 remains unstarted until the user explicitly requests it.

## Security and Model State

- The extension passes an operating-system and DSH-location environment allowlist to the child instead of inheriting ambient model credentials.
- Extension-managed keys remain in VS Code SecretStorage and are injected only under generated credential references; provider settings and Host responses remain value-free.
- Provider values previously supplied in conversation are absent from source files, logs, snapshots, and generated documents.
- The disclosed credential must be rotated before a real-provider acceptance run; P2.1 tests use generated fixture values only.

## Known Limits

- There is no conversation composer or transcript in the VS Code view.
- The extension does not yet consume Host mux events for streamed assistant text or tool lifecycle updates.
- Current file, selection, file, folder, and workspace context cannot yet be added to a prompt.
- Session listing, switching, history paging, and restart recovery have no VS Code presentation.
- Per-operation approval has no VS Code UI yet; model onboarding alone does not make the profile ready for coding tasks.

## Project Artifacts

- The [development handoff](development-handoff.md) gives a new coding agent the current state, operating rules, and P2.2 entry point.
- The [P2.1 acceptance tutorial](p2-1-acceptance.md) records the completed manual verification.
- The approved implementation sequence is the [P2 Minimum Usable Development Loop plan](p2-plan.md).
- The architecture decision for P0/P1 is recorded in the [VS Code Host stdio runtime Agent Note](../../.agents/notes/implemented/feature/2026-08-24-vscode-host-stdio-runtime.md).
- P2.1 secret and permission ownership is recorded in the [VS Code model and permission onboarding Agent Note](../../.agents/notes/implemented/feature/2026-08-24-vscode-model-permission-onboarding.md).
- A standalone Chinese review copy combines this summary and the P2 proposal in [`stage-summary-and-p2-plan.html`](stage-summary-and-p2-plan.html).
