/** Built DSH profile smoke through the same process manager the extension uses. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type * as vscode from 'vscode'
import { configureModelProvider } from '../src/configuration.ts'
import { runtimeEnvironment } from '../src/environment.ts'
import { RuntimeManager, type RuntimeLogger } from '../src/runtime-manager.ts'

class TestLogger implements RuntimeLogger {
  readonly lines: string[] = []
  appendLine(line: string): void { this.lines.push(line) }
}

class TestSecrets {
  readonly values = new Map<string, string>()
  async keys(): Promise<string[]> { return [...this.values.keys()] }
  async get(key: string): Promise<string | undefined> { return this.values.get(key) }
  async store(key: string, value: string): Promise<void> { this.values.set(key, value) }
  async delete(key: string): Promise<void> { this.values.delete(key) }
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('VS Code built DSH runtime', () => {
  it('boots the shipped vscode profile, describes the host, and exits gracefully', async () => {
    const dshHome = await mkdtemp(resolve(tmpdir(), 'dsh-vscode-home-'))
    const workspace = await mkdtemp(resolve(tmpdir(), 'dsh-vscode-workspace-'))
    temporaryDirectories.push(dshHome, workspace)
    const logger = new TestLogger()
    const manager = new RuntimeManager('0.1.0', logger)
    try {
      await manager.start({
        command: process.execPath,
        args: [resolve('apps/cli/lib/bin.js'), '--profile', 'vscode'],
        cwd: workspace,
        env: {
          ...runtimeEnvironment(),
          DSH_HOME: dshHome,
          DSH_TELEMETRY_DISABLED: '1',
        },
        handshakeTimeoutMs: 30_000,
        stopTimeoutMs: 10_000,
      })

      expect(manager.state).toMatchObject({
        kind: 'connected',
        host: { cwd: workspace, attachedSessions: 0 },
      })
      const initialSettings = await manager.describeSettings()
      expect(initialSettings.namespaces.find(row => row.ns === 'permission')?.value).toMatchObject({
        defaultPreset: 'confirm-changes',
      })

      const secrets = new TestSecrets()
      await configureModelProvider(manager, secrets as unknown as vscode.SecretStorage, {
        provider: 'fixture-gateway',
        displayName: 'Fixture Gateway',
        baseURL: 'https://fixture.invalid/v1',
        model: 'fixture-model',
        modelDisplayName: 'Fixture Model',
        apiKey: 'fixture-write-only-secret',
      })
      const configuredSettings = await manager.describeSettings()
      expect(configuredSettings.namespaces.find(row => row.ns === 'agent-default-model')?.value).toMatchObject({
        provider: 'fixture-gateway',
        model: 'fixture-model',
      })
      expect(configuredSettings.namespaces.find(row => row.ns === 'llm-pi-ai')?.value).toMatchObject({
        providers: {
          'fixture-gateway': {
            apiKeyEnv: 'DSH_VSCODE_FIXTURE_GATEWAY_API_KEY',
            baseURL: 'https://fixture.invalid/v1',
          },
        },
      })
      expect(JSON.stringify(configuredSettings)).not.toContain('fixture-write-only-secret')
      await manager.stop(10_000)
      expect(manager.state).toEqual({ kind: 'stopped' })
    } catch (error) {
      throw new Error(`${String(error)}\n${logger.lines.join('\n')}`)
    } finally {
      await manager.stop(2_000)
    }
  }, 45_000)
})
