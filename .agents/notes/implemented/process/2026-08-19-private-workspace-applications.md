# Agent Note: Private workspace applications

Status: implemented

English | [中文](2026-08-19-private-workspace-applications.zh.md)

## Problem

The workspace includes product assemblies under `apps/`, but not every application is an npm product published by the DeepSeek release sequence. Treating every application manifest as a release member requires internal applications to adopt an official package name, repository metadata, public access, and the repository-wide release version.

## Decision

An `apps/<name>` manifest with `private: true` and a non-`@deepseek-ai/*` package name is a private workspace application. It participates in dependency installation and repository checks but is absent from npm release-family discovery.

The shared `isPrivateWorkspaceApplication()` predicate owns this classification. Workspace constraints apply the ordinary private-package requirement to these applications. Official `@deepseek-ai/*` applications remain release members, including when `private: true` is set accidentally, so the publication checks report the invalid manifest instead of silently omitting it.

## Alternatives considered

**Publish every application.** This would expose internal product assemblies to the official npm release process and couple their versions and repository metadata to the Harness distribution.

**Maintain a directory allowlist.** A central list would require a tooling update for every internal application and could drift from the manifest that already declares publication intent.

**Exclude every private manifest.** This would let an official release member disappear from a release when its `private` field is set accidentally.

## Consequences

Private applications can live in the root workspace and use shared dependency management without becoming publishable artifacts. Their unscoped names distinguish them from official release applications. The constraint check and release-family tests pin both the exclusion and the requirement that official applications remain publishable.
