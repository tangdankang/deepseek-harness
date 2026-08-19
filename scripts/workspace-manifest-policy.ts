/** Manifest fields used to classify private workspace applications. */
interface WorkspaceApplicationManifest {
  readonly name?: unknown
  readonly private?: unknown
}

/**
 * Whether an application belongs to this workspace without joining an npm release family.
 * @param directory - repository-relative package directory.
 * @param manifest - parsed package manifest.
 * @returns `true` for private, non-DeepSeek applications under `apps/`.
 */
export function isPrivateWorkspaceApplication(
  directory: string,
  manifest: WorkspaceApplicationManifest,
): boolean {
  const normalized = directory.replaceAll('\\', '/')
  return /^apps\/[^/]+$/.test(normalized)
    && manifest.private === true
    && typeof manifest.name === 'string'
    && manifest.name.length > 0
    && !manifest.name.startsWith('@deepseek-ai/')
}
