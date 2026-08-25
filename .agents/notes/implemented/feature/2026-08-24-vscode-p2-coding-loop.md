# Agent Note: VS Code P2 coding loop

Status: implemented

English | [中文](2026-08-24-vscode-p2-coding-loop.zh.md)

## Problem

The VS Code extension needs a usable coding loop over the existing Host API without moving process, credential, session, Skill, or approval authority into a Webview. File approval also needs an exact pre-execution representation; a generic approval prompt does not prove what content the operation will write.

## Decision

**The Extension Host owns orchestration and sends a presentation-only model to the Webview.** A pure event fold reconciles durable history with live mux frames, retains Host projections and transient state, and repairs tracked tails after reconnect or a live sequence gap. Reconciliation continues until the subscribed baseline is complete rather than abandoning an answerable approval after a fixed attempt count. A conversation controller owns session selection, history pages, models, permissions, Skills, context, and pending approvals. The CSP Webview validates actions at its message edge and receives neither process handles nor credential values. Assistant Markdown is rendered in the Extension Host; user text is inserted as text content. Reasoning events expose only a busy/status indication, never reasoning text.

**The conversation remains available beside editor work.** VS Code 1.106 or later places the view container in the Secondary Side Bar and retains the Webview while hidden. A prominent new-conversation action and compact status remain above the scrollable transcript. Runtime, model, permission, and advanced configuration live on a separate in-view Settings page; provider settings and SecretStorage remain authoritative after the page or window is recreated. Pending approvals render after the transcript immediately above the composer and scroll into view when a new request arrives.

**Model-visible editor context is durable prompt text.** The extension captures a selection, explicit file, bounded folder listing, or bounded workspace listing into deterministic `<dsh-context>` sections with workspace-relative paths and optional one-based lines. Literal closing tags in context and task bodies are escaped before framing. Binary, invalid UTF-8, per-file overflow, and aggregate overflow fail visibly. Removable chips are draft state and clear only after Host prompt acceptance. A leading `/skill-name` remains the first token before context sections so the existing Host Skill injector recognizes the explicit invocation.

**Skill authoring uses the existing filesystem provider roots.** Project skeletons live at `<workspace>/.agents/skills/<name>/SKILL.md`; user skeletons live at `<DSH_HOME>/skills/<name>/SKILL.md`. Names use lowercase kebab-case, creation is non-overwriting, and VS Code plus Host filesystem watchers refresh the slash catalog. The extension creates no Skill database or remote catalog.

**Exact file review is limited to tool calls the client can reproduce.** `write` uses the proposed full content; targeted `edit` applies the literal unique replacement to the current UTF-8 file, with new files represented by an empty left document. The approval coordinator binds the preview to the file existence and digest. An approval request may reach the client while its correlated tool call is still reconciling; the Webview presents a prominent preparing card, and the coordinator retries against later history until it can produce the exact review. A request without correlation or a non-reproducible call remains rejection-only. Allowing a changed, binary, invalid, oversized, ambiguous, or unsupported input fails closed; stale previews are rejected through the original Host approval request. Shell cards show the exact command, working directory, and reason while stating that arbitrary command effects cannot be predicted as a Diff.

**The runtime composition excludes bypass paths.** The `vscode` profile retains top-level filesystem `write` and `edit` plus Shell escalation, and disables `str-replace-editor`, subagent creation, workflow, Ralph, and Code Mode paths that cannot preserve the same top-level call view and approval correlation. Permission selection continues to use the existing three presets and durable `/permission` projection.

**Runtime startup requires a project directory.** An explicit `dsh.runtime.cwd` wins over the first open workspace folder. When neither exists, the extension reports that the user must open a folder instead of launching from the VS Code installation directory, where workspace discovery is both incorrect and potentially slow.

## Alternatives considered

**Reuse the browser Cordis UI shell.** Rejected because it would add browser runtime ownership and a second client architecture to a local editor integration. The VS Code Webview remains a rendering component over the Host protocol.

**Store context attachments outside the session log.** Rejected because the model request could not be reconstructed from durable events and a restored conversation would hide what the model actually received.

**Approve every modifying tool from its name and arguments.** Rejected because composite or nested callers can omit the exact final file content and make the displayed decision weaker than the operation that runs.

**Render a speculative Shell Diff.** Rejected because arbitrary commands can affect files, processes, and external systems in ways a static client cannot derive. Exact command disclosure is the truthful approval representation.

## Verification

Pure tests cover repeated history repair, live sequence-gap recovery, session projections, transcript rendering, context limits and persisted text, Skill roots and non-overwrite creation, exact Diff generation, stale rejection, permission mutation, and the Chinese Secondary Side Bar Webview. A keyless assembled-flow snapshot starts a real stdio fixture process through the runtime manager and proves session restore, context plus Skill persistence, out-of-order approval/tool-call reconciliation, tool lifecycle, reject-without-write, one-shot allowance, and reasoning redaction. A built-profile smoke starts the real `vscode` bundle and exercises Host configuration, Skill discovery and prompt admission, and session APIs. The reusable manual tutorial is accepted against a real provider and Extension Development Host, including rejection, stale-Diff protection, one-shot allowance, permission changes, cancellation, and restart recovery.

## Consequences

P2 supports a reviewed local coding task while keeping Host sessions as the durable authority. Draft context is intentionally not restored, and arbitrary Markdown resources cannot load under the Webview CSP. Diff review supports the exact `write` and literal `edit` requests composed by this profile; additional modifying tools require equally reproducible pre-execution views before they can join the profile. Shell approval is explicit but cannot provide transactional rollback or predicted filesystem effects.
