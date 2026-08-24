/** P2.1 model-provider and default-permission configuration. */

import type * as vscode from 'vscode'
import type { SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-host-apiproxy/api/settings'
import type { SettingsDescription, SettingsMutation } from './host-client.ts'
import { isManagedCredentialReference } from './environment.ts'

const PI_AI_SETTINGS_NAMESPACE = 'llm-pi-ai'
const DEFAULT_MODEL_SETTINGS_NAMESPACE = 'agent-default-model'
const PERMISSION_SETTINGS_NAMESPACE = 'permission'
const SECRET_KEY_PREFIX = 'dsh.provider-credential.'
const PROVIDER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** User-facing permission modes shipped by the VS Code profile. */
export const PERMISSION_MODES = [
  {
    value: 'read-only',
    label: '只读',
    description: '允许读取项目；拒绝所有需要提升权限的操作。',
  },
  {
    value: 'confirm-changes',
    label: '确认后更改',
    description: '每次文件更改或高权限命令执行前都询问。',
  },
  {
    value: 'workspace-write',
    label: '工作区可写',
    description: '允许工作区内写入；更宽访问仍需确认。',
  },
] as const

/** Stable value of a VS Code permission choice. */
export type PermissionMode = typeof PERMISSION_MODES[number]['value']

/** Values collected by the OpenAI-compatible provider wizard. */
export interface ModelProviderDraft {
  /** Lowercase kebab-case route key. */
  provider: string
  /** Provider label shown in model selectors. */
  displayName: string
  /** OpenAI-compatible API base URL. */
  baseURL: string
  /** Model id accepted by the endpoint. */
  model: string
  /** Model label shown in selectors. */
  modelDisplayName: string
  /** Write-only credential entered by the user. */
  apiKey: string
}

/** Minimal settings client used by the extension and deterministic tests. */
export interface ConfigurationHost {
  /** Read redacted settings descriptors. */
  describeSettings(signal?: AbortSignal): Promise<SettingsDescription>
  /** Apply a revision-checked path mutation. */
  mutateSettings(mutation: SettingsMutation, signal?: AbortSignal): Promise<SettingsNamespaceView>
}

/** Validated non-secret provider facts plus its credential reference. */
export interface ModelProviderConfiguration {
  /** Provider route key. */
  provider: string
  /** Model id. */
  model: string
  /** Environment-style reference resolved by DSH credentials. */
  credentialRef: string
  /** Profile written to the `llm-pi-ai` settings namespace. */
  profile: Record<string, unknown>
}

/**
 * Validate and normalize a provider wizard result.
 * @param draft - raw values collected from VS Code input controls.
 * @returns non-secret settings content and a credential reference.
 */
export function resolveModelProviderDraft(draft: ModelProviderDraft): ModelProviderConfiguration {
  const provider = draft.provider.trim()
  if (!PROVIDER_PATTERN.test(provider)) {
    throw new Error('Provider route must use lowercase kebab-case, for example company-gateway')
  }
  const displayName = required(draft.displayName, 'Provider display name')
  const model = required(draft.model, 'Model ID')
  const modelDisplayName = required(draft.modelDisplayName, 'Model display name')
  if (draft.apiKey.trim() === '') throw new Error('API key must not be empty')
  const baseURL = normalizeProviderUrl(draft.baseURL)
  const credentialRef = credentialReference(provider)
  return {
    provider,
    model,
    credentialRef,
    profile: {
      apiKeyEnv: credentialRef,
      displayName,
      api: 'openai-completions',
      baseURL,
      models: [{ id: model, name: modelDisplayName }],
    },
  }
}

/**
 * Configure an OpenAI-compatible route and select it for future sessions.
 * The credential is stored before settings are written and restored if either
 * settings write fails; it never enters a Host payload.
 * @param host - connected Host settings client.
 * @param secrets - extension-owned encrypted storage.
 * @param draft - complete wizard values.
 * @returns configured provider, model, and credential reference.
 */
export async function configureModelProvider(
  host: ConfigurationHost,
  secrets: vscode.SecretStorage,
  draft: ModelProviderDraft,
): Promise<ModelProviderConfiguration> {
  const configuration = resolveModelProviderDraft(draft)
  const described = await host.describeSettings()
  if (!described.writable) throw new Error('DSH settings are read-only in this runtime')
  const providerNamespace = namespaceOf(described, PI_AI_SETTINGS_NAMESPACE)
  const defaultNamespace = namespaceOf(described, DEFAULT_MODEL_SETTINGS_NAMESPACE)
  const key = credentialSecretKey(configuration.credentialRef)
  const previousSecret = await secrets.get(key)
  let storedSecret = false
  let providerAfterWrite: SettingsNamespaceView | undefined
  try {
    await secrets.store(key, draft.apiKey)
    storedSecret = true
    providerAfterWrite = await host.mutateSettings({
      ns: PI_AI_SETTINGS_NAMESPACE,
      ops: [{ op: 'set', path: ['providers', configuration.provider], value: configuration.profile }],
      expectedRevision: providerNamespace.revision,
    })
    await host.mutateSettings({
      ns: DEFAULT_MODEL_SETTINGS_NAMESPACE,
      ops: [
        { op: 'set', path: ['provider'], value: configuration.provider },
        { op: 'set', path: ['model'], value: configuration.model },
        { op: 'unset', path: ['reasoningEffort'] },
      ],
      expectedRevision: defaultNamespace.revision,
    })
    return configuration
  } catch (error: unknown) {
    const rollbackFailures: string[] = []
    if (providerAfterWrite !== undefined) {
      const previousProfile = valueAt(providerNamespace.user, ['providers', configuration.provider])
      const rollbackOp: SettingsPathOpView = previousProfile === undefined
        ? { op: 'unset', path: ['providers', configuration.provider] }
        : { op: 'set', path: ['providers', configuration.provider], value: previousProfile }
      try {
        await host.mutateSettings({
          ns: PI_AI_SETTINGS_NAMESPACE,
          ops: [rollbackOp],
          expectedRevision: providerAfterWrite.revision,
        })
      } catch {
        rollbackFailures.push('provider settings')
      }
    }
    if (storedSecret) {
      try {
        if (previousSecret === undefined) await secrets.delete(key)
        else await secrets.store(key, previousSecret)
      } catch {
        rollbackFailures.push('credential')
      }
    }
    const suffix = rollbackFailures.length === 0
      ? ''
      : `; could not restore ${rollbackFailures.join(' and ')}`
    throw new Error(`Could not configure the model provider: ${errorMessage(error)}${suffix}`)
  }
}

/**
 * Persist the default permission for future VS Code sessions.
 * @param host - connected Host settings client.
 * @param mode - one of the three profile-owned choices.
 */
export async function setDefaultPermission(host: ConfigurationHost, mode: PermissionMode): Promise<void> {
  const described = await host.describeSettings()
  if (!described.writable) throw new Error('DSH settings are read-only in this runtime')
  const namespace = namespaceOf(described, PERMISSION_SETTINGS_NAMESPACE)
  await host.mutateSettings({
    ns: PERMISSION_SETTINGS_NAMESPACE,
    ops: [{ op: 'set', path: ['defaultPreset'], value: mode }],
    expectedRevision: namespace.revision,
  })
}

/**
 * Build the explicit child environment from extension-owned secrets.
 * Unrelated SecretStorage entries are ignored, and only credential references
 * generated by this module can become environment names.
 * @param secrets - extension-owned encrypted storage.
 * @returns credential variables for one runtime launch.
 */
export async function loadCredentialEnvironment(secrets: vscode.SecretStorage): Promise<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of await secrets.keys()) {
    if (!key.startsWith(SECRET_KEY_PREFIX)) continue
    const ref = key.slice(SECRET_KEY_PREFIX.length)
    if (!isManagedCredentialReference(ref)) {
      throw new Error('DSH SecretStorage contains an invalid provider credential reference')
    }
    const value = await secrets.get(key)
    if (value === undefined || value.length === 0) {
      throw new Error(`DSH SecretStorage credential ${ref} is empty`)
    }
    environment[ref] = value
  }
  return environment
}

/** Derive an injective environment-style reference from a kebab-case route. */
export function credentialReference(provider: string): string {
  if (!PROVIDER_PATTERN.test(provider)) throw new Error('Cannot derive a credential reference from an invalid provider route')
  return `DSH_VSCODE_${provider.replaceAll('-', '_').toUpperCase()}_API_KEY`
}

/** SecretStorage key for one DSH credential reference. */
export function credentialSecretKey(ref: string): string {
  if (!isManagedCredentialReference(ref)) throw new Error('Invalid VS Code provider credential reference')
  return `${SECRET_KEY_PREFIX}${ref}`
}

/** Resolve and normalize a provider URL without accepting embedded credentials. */
function normalizeProviderUrl(input: string): string {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error('Provider base URL must be an absolute URL')
  }
  const localHttp = url.protocol === 'http:'
    && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error('Provider base URL must use HTTPS; HTTP is allowed only for localhost')
  }
  if (url.username !== '' || url.password !== '') throw new Error('Provider base URL must not contain credentials')
  if (url.search !== '' || url.hash !== '') throw new Error('Provider base URL must not contain a query or fragment')
  return url.toString().replace(/\/$/, '')
}

/** Require one trimmed text field. */
function required(value: string, label: string): string {
  const resolved = value.trim()
  if (resolved === '') throw new Error(`${label} must not be empty`)
  return resolved
}

/** Find one registered settings namespace or fail with a correction. */
function namespaceOf(description: SettingsDescription, ns: string): SettingsNamespaceView {
  const namespace = description.namespaces.find(candidate => candidate.ns === ns)
  if (namespace === undefined) throw new Error(`DSH settings namespace ${ns} is not available in this profile`)
  return namespace
}

/** Read one raw user-setting path without widening it into the resolved base. */
function valueAt(root: unknown, path: readonly string[]): unknown {
  let value = root
  for (const part of path) {
    if (!isRecord(value) || !(part in value)) return undefined
    value = value[part]
  }
  return value
}

/** Narrow an unknown value to a non-array record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Normalize a failure without including any wizard input. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
