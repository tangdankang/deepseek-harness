# Agent Note: VS Code model and permission onboarding

Status: implemented

English | [中文](2026-08-24-vscode-model-permission-onboarding.zh.md)

## Problem

The VS Code extension needs enough provider and permission configuration to prepare a coding session without creating a second DSH configuration system or exposing a credential through editor settings, Host responses, diagnostics, or snapshots. The `vscode` profile also inherits base permission choices that include unrestricted host access and do not distinguish rejection from one-shot confirmation.

## Decision

**VS Code SecretStorage owns extension-managed provider keys.** The onboarding wizard accepts a key through a password input, stores it under a generated provider credential reference, and never sends its value through the Host API. Each runtime launch rebuilds a scrubbed environment and adds only extension-owned `DSH_VSCODE_*_API_KEY` values; ambient provider variables remain excluded. Reconfiguring one route rotates the same SecretStorage entry.

**DSH settings own every non-secret provider fact.** The extension writes an OpenAI-compatible profile through revision-checked `settings.mutate` operations in `llm-pi-ai`, then selects its provider and model in `agent-default-model`. Provider routes use lowercase kebab-case so replacing hyphens with underscores produces an injective credential reference. Remote endpoints require HTTPS; loopback HTTP remains available for local gateways. If the default-model write fails, the extension restores the previous provider profile and SecretStorage value where those rollback writes remain current.

**The `vscode` bundle owns three permission choices.** `read-only` combines the read-only sandbox with the deterministic `never` approval policy, `confirm-changes` combines read-only with `ask`, and `workspace-write` combines workspace-write with `ask`. The bundle makes `confirm-changes` the default and exposes no danger-full-access preset. The extension writes only `permission.defaultPreset`, so an existing session keeps its pinned permission while later sessions use the saved default.

The connected sidebar displays the effective default provider/model returned by `host.describe` and the default permission returned by redacted settings. Configuration commands start the owned Host when needed; provider changes restart it so the newly stored credential enters only that child.

## Alternatives considered

**Write the key through `credentials.set`.** Rejected for this surface because the approved editor ownership puts extension-managed values in VS Code SecretStorage, while `credentials.set` persists through the DSH-home provider.

**Store provider metadata and the key in VS Code settings.** Rejected because settings are a plaintext, syncable configuration surface and would duplicate the existing DSH settings namespaces.

**Inherit provider variables from the Extension Host.** Rejected because an unrelated editor or shell environment could silently select another tenant's credential and the extension could not identify what it had delegated.

**Keep the base permission table and relabel it in the extension.** Rejected because presentation-only filtering would leave unrestricted access available through the Host and would not encode the reviewed three-mode policy in the runtime composition that enforces it.

## Verification

Focused tests cover provider and URL validation, SecretStorage isolation, revision-checked writes, rollback, exact permission composition, Host settings transport, sidebar rendering, and Extension Host command registration. A built-profile test writes a fixture route through the real stdio Host API and confirms the route and default model are visible while the fixture key is absent from every returned settings descriptor.

## Consequences

Model onboarding is available before the conversation UI, but it does not run a model turn. The wizard configures one OpenAI-compatible route at a time; other adapter protocols remain available through DSH settings outside this surface. A provider change restarts the owned runtime, and a default-permission change affects only sessions created afterward. Per-session switching and one-shot approval controls remain owned by later P2 work packages.
