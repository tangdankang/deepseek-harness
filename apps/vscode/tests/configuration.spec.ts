/** P2.1 provider-secret and permission configuration tests. */

import type * as vscode from 'vscode'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-host-apiproxy/api/settings'
import { describe, expect, it, vi } from 'vitest'
import {
  configureModelProvider,
  credentialReference,
  credentialSecretKey,
  loadCredentialEnvironment,
  resolveModelProviderDraft,
  setDefaultPermission,
  type ConfigurationHost,
  type ModelProviderDraft,
} from '../src/configuration.ts'
import { runtimeEnvironment } from '../src/environment.ts'
import type { SettingsDescription, SettingsMutation } from '../src/host-client.ts'

const draft: ModelProviderDraft = {
  provider: 'acme-gateway',
  displayName: 'Acme Gateway',
  baseURL: 'https://gateway.example/model/v1/',
  model: 'acme-model',
  modelDisplayName: 'Acme Model',
  apiKey: 'fixture-secret-value',
}

class MemorySecrets {
  readonly values = new Map<string, string>()
  async keys(): Promise<string[]> { return [...this.values.keys()] }
  async get(key: string): Promise<string | undefined> { return this.values.get(key) }
  async store(key: string, value: string): Promise<void> { this.values.set(key, value) }
  async delete(key: string): Promise<void> { this.values.delete(key) }
}

/** Build a minimal redacted settings row. */
function namespace(ns: string, revision = 0, user?: unknown): SettingsNamespaceView {
  return {
    ns,
    schema: {},
    value: {},
    applies: 'live',
    secrets: [],
    revision,
    ...user === undefined ? {} : { user },
  }
}

/** Build the three settings namespaces P2.1 owns. */
function settings(overrides: Partial<Record<string, SettingsNamespaceView>> = {}): SettingsDescription {
  return {
    writable: true,
    hasDocument: true,
    namespaces: [
      overrides['llm-pi-ai'] ?? namespace('llm-pi-ai'),
      overrides['agent-default-model'] ?? namespace('agent-default-model'),
      overrides['permission'] ?? namespace('permission'),
    ],
  }
}

describe('P2.1 configuration', () => {
  it('builds non-secret OpenAI-compatible settings and an injective credential reference', () => {
    const resolved = resolveModelProviderDraft(draft)
    expect(resolved).toEqual({
      provider: 'acme-gateway',
      model: 'acme-model',
      credentialRef: 'DSH_VSCODE_ACME_GATEWAY_API_KEY',
      profile: {
        apiKeyEnv: 'DSH_VSCODE_ACME_GATEWAY_API_KEY',
        displayName: 'Acme Gateway',
        api: 'openai-completions',
        baseURL: 'https://gateway.example/model/v1',
        models: [{ id: 'acme-model', name: 'Acme Model' }],
      },
    })
    expect(JSON.stringify(resolved)).not.toContain(draft.apiKey)
    expect(credentialReference('acme-gateway')).not.toBe(credentialReference('acmegateway'))
  })

  it('rejects ambiguous provider routes and remote plaintext endpoints', () => {
    expect(() => resolveModelProviderDraft({ ...draft, provider: 'acme_gateway' })).toThrow('kebab-case')
    expect(() => resolveModelProviderDraft({ ...draft, baseURL: 'http://gateway.example/v1' })).toThrow('HTTPS')
    expect(resolveModelProviderDraft({ ...draft, baseURL: 'http://localhost:8080/v1' }).profile)
      .toMatchObject({ baseURL: 'http://localhost:8080/v1' })
  })

  it('injects only extension-managed secrets and never inherits ambient credentials', async () => {
    const secrets = new MemorySecrets()
    const ref = credentialReference('acme-gateway')
    secrets.values.set(credentialSecretKey(ref), draft.apiKey)
    secrets.values.set('unrelated-secret', 'must-not-leave-secret-storage')

    const explicit = await loadCredentialEnvironment(secrets as unknown as vscode.SecretStorage)
    expect(explicit).toEqual({ [ref]: draft.apiKey })
    expect(runtimeEnvironment({ PATH: 'fixture-path', OPENAI_API_KEY: 'ambient-secret' }, explicit)).toEqual({
      PATH: 'fixture-path',
      [ref]: draft.apiKey,
    })
    expect(() => runtimeEnvironment({}, { PATH: 'credential-collision' })).toThrow('not managed')
  })

  it('stores the key only in SecretStorage and writes the provider plus future-session model', async () => {
    const secrets = new MemorySecrets()
    const mutations: SettingsMutation[] = []
    const host: ConfigurationHost = {
      describeSettings: async () => settings(),
      mutateSettings: async (mutation) => {
        mutations.push(mutation)
        return namespace(mutation.ns, 1)
      },
    }

    const configured = await configureModelProvider(host, secrets as unknown as vscode.SecretStorage, draft)

    expect(secrets.values.get(credentialSecretKey(configured.credentialRef))).toBe(draft.apiKey)
    expect(mutations).toHaveLength(2)
    expect(mutations[0]).toMatchObject({
      ns: 'llm-pi-ai',
      ops: [{ op: 'set', path: ['providers', 'acme-gateway'] }],
      expectedRevision: 0,
    })
    expect(mutations[1]).toEqual({
      ns: 'agent-default-model',
      ops: [
        { op: 'set', path: ['provider'], value: 'acme-gateway' },
        { op: 'set', path: ['model'], value: 'acme-model' },
        { op: 'unset', path: ['reasoningEffort'] },
      ],
      expectedRevision: 0,
    })
    expect(JSON.stringify(mutations)).not.toContain(draft.apiKey)
  })

  it('restores the previous provider profile and secret when selecting the default model fails', async () => {
    const secrets = new MemorySecrets()
    const ref = credentialReference(draft.provider)
    const key = credentialSecretKey(ref)
    secrets.values.set(key, 'previous-secret')
    const previousProfile = { apiKeyEnv: ref, baseURL: 'https://old.example/v1' }
    const mutations: SettingsMutation[] = []
    const host: ConfigurationHost = {
      describeSettings: async () => settings({
        'llm-pi-ai': namespace('llm-pi-ai', 4, { providers: { [draft.provider]: previousProfile } }),
        'agent-default-model': namespace('agent-default-model', 8),
      }),
      mutateSettings: vi.fn(async (mutation: SettingsMutation) => {
        mutations.push(mutation)
        if (mutation.ns === 'agent-default-model') throw new Error('default selection refused')
        return namespace(mutation.ns, mutation.expectedRevision === 4 ? 5 : 6)
      }),
    }

    await expect(configureModelProvider(host, secrets as unknown as vscode.SecretStorage, draft))
      .rejects.toThrow('default selection refused')
    expect(secrets.values.get(key)).toBe('previous-secret')
    expect(mutations.at(-1)).toEqual({
      ns: 'llm-pi-ai',
      ops: [{ op: 'set', path: ['providers', draft.provider], value: previousProfile }],
      expectedRevision: 5,
    })
  })

  it('writes the selected default permission by revision', async () => {
    const mutateSettings = vi.fn(async (mutation: SettingsMutation) => namespace(mutation.ns, 12))
    const host: ConfigurationHost = {
      describeSettings: async () => settings({ permission: namespace('permission', 11) }),
      mutateSettings,
    }

    await setDefaultPermission(host, 'confirm-changes')

    expect(mutateSettings).toHaveBeenCalledWith({
      ns: 'permission',
      ops: [{ op: 'set', path: ['defaultPreset'], value: 'confirm-changes' }],
      expectedRevision: 11,
    })
  })
})
