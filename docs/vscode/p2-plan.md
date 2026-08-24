# VS Code P2 Plan: Minimum Usable Development Loop

English | [中文](p2-plan.zh.md)

Status: approved. D1–D7 and the complete plan are accepted; P2.1 passed user acceptance on 2026-08-24, and P2.2 has not started.

## Goal

P2 delivers the first complete coding loop inside VS Code: the user creates or restores a DSH session, sends a task with editor context and optional Skills, watches the model read and analyze the project, reviews each proposed file change or privileged command, allows or rejects it, sees the resulting tool output, and recovers the transcript after restarting VS Code.

## Current Stage

P2.1 supplies secure OpenAI-compatible provider onboarding and the three approved permission choices. Its accepted stage result is recorded in the [project summary](README.md). P2.2 is the next work package and starts only when the user explicitly requests it.

## Acceptance Boundary

P2 is accepted only when DSH can complete a small real repository change through the extension rather than merely discuss it. The default mode requires one-shot confirmation before a file mutation or sandbox escalation. A rejection leaves the target unchanged, an approval applies only the displayed operation, and every event remains visible in the durable transcript.

## Scope

### In Scope

- A VS Code Webview conversation surface using VS Code theme tokens, keyboard behavior, accessibility labels, and a Content Security Policy.
- Host API calls for session list, create, history, prompt, cancel, model selection, approval responses, Skill listing, and the mux/host streams needed for live updates.
- Streamed assistant text, reasoning-status summaries without chain-of-thought exposure, tool call/result cards, running state, terminal errors, and reconnect reconciliation.
- Context collection for the current selection, current file, Explorer file, Explorer folder, and workspace, with visible source path and line range where applicable.
- Session list, create, switch, history paging, and cold-session recovery from the existing DSH persistence store.
- Project and user Skill discovery, catalog display, `/skill-name` completion, explicit invocation, hot refresh, and commands that create or open a Skill location.
- Three permission choices: read-only, confirm changes, and automatic workspace writes, with confirm changes selected by default for new VS Code sessions.
- Pre-execution Diff review for file tools, command review for sandbox-escalating shell tools, one-shot allow/reject responses, and visible settled results.

### Out of Scope

- Turn-wide multi-file transactions, batch accept/reject, automatic checkpoints, and rollback after an approved change.
- Remembered approvals, allow-always rules, unrestricted host access, an interactive PTY, and background job management.
- A rich Skill editor, marketplace installation, remote Skill providers, and recursive nested Skill discovery.
- Symbol search, diagnostics integration, language-server orchestration, and semantic code exploration, which remain a later stage.
- Git staging, commit, branch, and conflict flows, which remain a later stage.
- Remote DSH connections, multi-runtime ownership, and a wholesale reuse of the browser Cordis UI shell.

## Grounded Technical Baseline

| Existing capability | P2 use or gap |
| --- | --- |
| Newline JSON-RPC request/response | Extend the P1 client from handshake-only calls to typed Host API calls without changing the chosen transport. |
| `session.list`, `session.create`, and `session.history` | Provide session discovery, creation, pagination, and cold recovery without adding a second persistence layer. |
| `events.mux` and `events.host` | Carry durable session events, tool views, queue state, running state, approval requests, and transport errors; the stdio carrier needs long-lived stream subscriptions. |
| `session.prompt` | Sends text and image parts and dispatches host slash commands; file context needs deterministic text rendering, while permission switches can reuse `/permission`. |
| `skill.list` plus the filesystem Skill provider | Already discovers project and user Skills, watches catalog changes, and supports deterministic `/skill-name` injection; VS Code needs catalog and creation UI. |
| File-tool call views | `write` and `edit` publish pending Diff intents before execution; VS Code must correlate them with approval `callId` values and resolve current workspace content for an exact preview. |
| Approval response channel | Host mux frames already carry one-shot approval requests and `api.respond` accepts `allowed-once` or `rejected`; the stdio client needs the response path and fail-closed UI lifecycle. |
| Permission presets and projections | DSH persists per-session sandbox and approval settings, but the `vscode` profile needs distinct read-only, confirm-changes, and workspace-write product choices. |
| `settings.*`, credentials, and model selection | Already support redacted settings views, custom provider metadata, and per-session model selection; VS Code SecretStorage remains the proposed key owner. |

## Proposed Design

### Runtime and Protocol Client

The P1 runtime manager continues to own one child. Its protocol client gains typed unary dispatch, long-lived mux and host subscriptions, server-request responses, request cancellation, pending-request rejection on process exit, and reconnect reconciliation. Host API schemas remain the wire authority; the VS Code layer does not create a parallel protocol.

### Conversation and Session Presentation

A Webview owns the transcript and composer because the existing Tree View is not suitable for streamed Markdown, approval controls, and Diff cards. The Extension Host owns DSH I/O and sends validated view models to the Webview; the Webview never receives process handles or provider credentials. P2 reuses pure event-fold and presentation logic where practical without importing the browser Cordis shell.

On connection, the extension reads `session.list`, selects the last locally active session when it still exists, and loads the newest history page. Mux subscription begins before reconciliation so no event gap exists; subscription and history sequence numbers deduplicate overlap. Older pages load on demand, and a cold session resumes through the existing Host path when the user sends its next prompt.

### Context Representation

Each selected context item becomes a deterministic text section containing its source kind, workspace-relative path, optional line range, and captured text. The rendered text reaches `session.prompt`, so the model-visible input is durable in the user message. Context chips remain removable before sending, folders expand only to a bounded file manifest, binary files are rejected, and size limits produce a visible refusal instead of silent truncation.

### Skill Experience

The composer queries `skill.list` for the active session and offers `/skill-name` completion. A selected or hand-typed whitespace-bounded Skill name stays in the user message, while DSH performs the existing deterministic full-body injection. Catalog changes refresh the picker without restarting the runtime.

**Create Project Skill** scaffolds `<workspace>/.agents/skills/<name>/SKILL.md` for a repository-owned workflow. **Create User Skill** scaffolds `<DSH_HOME>/skills/<name>/SKILL.md` for a personal cross-project workflow. Both commands validate kebab-case names, refuse an existing target, open the new file for editing, and never overwrite Skill resources. **Open Skills Folder** exposes both locations without adding a second Skill store.

### Permission Modes

The `vscode` profile exposes three product choices and records the selected value in the existing session permission events.

| Mode | Sandbox and approval behavior | User experience |
| --- | --- | --- |
| Read-only | `read-only` with approval disabled | Reads and non-mutating tools may run; every escalation fails without presenting an allow action. |
| Confirm changes | `read-only` with one-shot approval enabled | File mutations display a Diff and shell escalation displays the exact command; each operation waits for allow once or reject. |
| Workspace writes | `workspace-write` with approval enabled only for wider access | Mutations inside the workspace run automatically; wider access still requires one-shot approval. |

Confirm changes is the VS Code default. The selector changes the active session through the existing permission command and sets the default for newly created sessions through the settings API. The UI always shows the effective session value rather than assuming the saved default also changed existing sessions.

### Diff and Approval Flow

When an approval frame names a file-tool `callId`, the Extension Host joins it with that pending call's `card: diff` view, resolves the path against the session workspace, reads the current file, and builds a VS Code Diff preview. A create uses an empty left document; an edit applies the proposed replacement to the current left document; a full-file write uses its proposed content as the right document. The approval card shows the reason, affected path, and **Allow once** or **Reject** controls.

If the file changes while approval is pending, the extension invalidates the preview and refuses the stale approval. DSH's filesystem observation policy remains the final stale-write check after the response. Rejection answers the Host request and does not call the mutation. Success replaces the pending card with the persisted applied Diff view.

Every mutation path visible to the P2 agent must pass this policy. Mutation tools that cannot provide a pre-execution Diff or one-shot approval are restricted from the VS Code agent composition until they gain that behavior. Code Mode stays disabled for P2 so nested mutation calls cannot bypass top-level presentation metadata.

A shell escalation is different: the UI can show the exact command, working directory, reason, and requested permission, but it cannot predict every filesystem effect. The approval copy states this limitation. Read-only mode rejects shell escalation; confirm-changes mode permits one approved command; workspace-write follows the selected sandbox policy.

### Provider and Credential Setup

The proposed source of truth is VS Code SecretStorage for the key, with non-secret provider metadata stored through DSH settings. On runtime launch, the extension reads the one named secret and injects only that explicit credential variable into the scrubbed child environment; DSH subprocesses remove credential-shaped inherited values. No key enters extension settings, command arguments, diagnostics, session events, snapshots, or these documents. The previously disclosed key must be rotated before the real-provider acceptance run.

## Work Packages

| Package | Deliverable | Stage result required before continuation |
| --- | --- | --- |
| P2.0 | Freeze this revised scope, permission meanings, and acceptance wording. | User explicitly approves the complete plan. |
| P2.1 | Secure provider bootstrap plus the three `vscode` permission choices. | Configuration, redaction, projection, and permission-behavior tests pass; the user reviews the stage result. |
| P2.2 | Typed stdio Host client, stream subscriptions, event fold, approval responses, cancellation, and reconnect reconciliation. | Protocol tests cover split frames, stream end, overlap, response correlation, exit, and restart; the user reviews the stage result. |
| P2.3 | Session list, create/switch, history paging, composer, streaming transcript, and tool cards. | Extension Host tests and a product-visible snapshot cover the assembled conversation; the user reviews the stage result. |
| P2.4 | Current selection/file and Explorer file/folder/workspace context commands, chips, limits, and durable text rendering. | Context tests prove path/range identity, binary refusal, bounds, and exact sent text; the user reviews the stage result. |
| P2.5 | Skill catalog, slash completion, explicit invocation, hot refresh, and safe project/user Skill scaffolding. | Skill tests prove scope, precedence, invocation, refresh, and no-overwrite creation; the user reviews the stage result. |
| P2.6 | Diff preview, file and shell approval cards, mode selector, stale-preview handling, and mutation-tool restrictions. | Reject/allow tests prove pre-execution behavior and no bypass; the user reviews the stage result. |
| P2.7 | Built-extension smoke, real-model directed task, Chinese manual acceptance guide, and documentation update. | User completes the P2 acceptance flow. |

## Verification and Acceptance

### Automated Evidence

- Unit tests cover protocol framing, event ordering, history/live overlap, reconnection, cancellation, approval correlation, and fail-closed disposal.
- Permission tests prove read-only denial, confirm-changes one-shot decisions, automatic workspace writes, and refusal of unpresentable mutation tools.
- Diff tests cover create, targeted edit, full overwrite, rejection, stale-file invalidation, applied-result replacement, and Windows paths.
- Skill tests cover project/user discovery, precedence, slash invocation, hot refresh, name validation, existing-target refusal, and exact scaffold content.
- A keyless assembled snapshot records session creation, context and Skill submission, streamed text, a rejected change, an approved change, tool lifecycle rows, cancellation, and restored history through a runnable example.
- An installed Extension Development Host test activates the real extension and validates Webview messaging, VS Code Diff documents, Skill commands, approval responses, and permission switching.
- Focused typecheck, lint, build, package invariants, runtime closure, translation pairing, and documentation gates cover the outgoing P2 diff; the accepted repository baseline remains separate.
- A real-provider directed task uses the configured custom OpenAI-compatible route only after the secret is rotated and stored through the approved path.

### Manual Acceptance Flow

1. Open the repository in a clean Extension Development Host and confirm the DSH status becomes connected.
2. Configure the custom provider through the secure input, create a session, and confirm **Confirm changes** is selected.
3. Create a project Skill from the extension, add one visible coding rule, type `/skill-name`, and confirm the Skill appears in the task flow.
4. Add a selection and a file from the editor or Explorer, verify their path and line information, then send a small code-change task.
5. Confirm assistant text streams incrementally and read/search tool calls show running and settled states.
6. At the first proposed file mutation, inspect the VS Code Diff, choose **Reject**, and confirm the file remains unchanged.
7. Request the change again, inspect the Diff, choose **Allow once**, and confirm only the displayed file change is applied.
8. Approve one displayed test command, confirm its output appears, and verify the command card clearly states that terminal side effects cannot be predicted as a Diff.
9. Switch the session to **Read-only**, request another mutation, and confirm it fails without an allow action.
10. Switch to **Workspace writes** only for the test fixture, request an in-workspace edit, and confirm it runs automatically while outside-workspace access still asks or fails.
11. Restart the Extension Development Host, select the previous session, and confirm the transcript, permission value, Skill evidence, Diffs, and decisions are restored without duplicate events.

## Review Points Before Implementation

| ID | Proposed decision | Consequence |
| --- | --- | --- |
| D1 | Store the provider key in VS Code SecretStorage and inject it only into the owned DSH child. | The exposed key must be rotated; no second plain-text key setting is introduced. |
| D2 | Make **Confirm changes** the default for new VS Code sessions. | The first useful coding task remains interactive and every privilege grant is one-shot. |
| D3 | Offer Read-only, Confirm changes, and Workspace writes; do not expose unrestricted access in P2. | Users can choose safety or speed without granting host-wide access. |
| D4 | Send editor context as deterministic durable text with visible path/range and strict limits. | P2 avoids a new durable content type while preserving exactly what the model received. |
| D5 | Support both project and user Skills, plus slash completion and safe scaffolding. | Repository workflows can be shared while personal constraints remain outside the project. |
| D6 | Show an exact Diff for file tools and the exact command plus an explicit warning for shell escalation. | File edits are reviewable before execution; terminal effects are disclosed but cannot be predicted. |
| D7 | Require keyless snapshots, Extension Host tests, one real-provider task, and the eleven-step Chinese manual flow. | The accepted 36-failure environment baseline remains unchanged while every P2 behavior gains targeted evidence. |

## Stop Condition

The approved plan authorizes one work package at a time. Each work package stops after reporting its stage result and waits for user acceptance before the next package starts. P2.1 acceptance clears its stage block; P2.2 remains unstarted until the user explicitly requests it.

## Related Documents

- [P0–P2.1 stage summary](README.md)
- [VS Code extension contract](../../apps/vscode/README.md)
- [Original P0/P1 architecture decision](../../.agents/notes/implemented/feature/2026-08-24-vscode-host-stdio-runtime.md)
