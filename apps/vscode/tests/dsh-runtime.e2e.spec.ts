/** Built DSH profile smoke through the same process manager the extension uses. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
    const launch = {
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
    }
    try {
      await manager.start(launch)

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

      const skillDirectory = resolve(workspace, '.agents', 'skills', 'fixture-skill')
      await mkdir(skillDirectory, { recursive: true })
      await writeFile(resolve(skillDirectory, 'SKILL.md'), [
        '---',
        'name: fixture-skill',
        'description: Built profile discovery fixture.',
        '---',
        '',
        '# Fixture Skill',
        '',
        'Use the assembled profile.',
        '',
      ].join('\n'))
      const created = await manager.request('session.create', { cwd: workspace })
      expect(await manager.request('session.list', {})).toMatchObject({
        items: [expect.objectContaining({ sessionId: created.sessionId, cwd: workspace, blank: true })],
      })
      const initialHistory = await manager.request('session.history', { sessionId: created.sessionId, maxMessages: 20 })
      expect(initialHistory.hasMore).toBe(false)
      expect(initialHistory.events.map(entry => entry.event.type)).not.toContain('user/message')
      expect(initialHistory.events.map(entry => entry.event.type)).not.toContain('turn/start')
      expect(await manager.request('skill.list', { sessionId: created.sessionId })).toMatchObject({
        skills: [expect.objectContaining({ name: 'fixture-skill' })],
      })
      expect(await manager.request('session.models', { sessionId: created.sessionId })).toMatchObject({
        current: { provider: 'fixture-gateway', model: 'fixture-model' },
      })
      expect(await manager.request('session.prompt', {
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: '/fixture-skill confirm briefly' }],
        clientTimeZone: 'UTC',
      })).toEqual({ accepted: true })
      await expect.poll(async () => {
        const history = await manager.request('session.history', { sessionId: created.sessionId, maxMessages: 20 })
        return history.events.some(entry => entry.event.type === 'user/message'
          && entry.event.data.source.kind === 'skill-invocation')
      }).toBe(true)
      await manager.stop(10_000)
      await manager.start(launch)
      expect(manager.state).toMatchObject({ kind: 'connected', host: { attachedSessions: 0 } })
      expect(await manager.request('session.list', {})).toMatchObject({
        items: [expect.objectContaining({ sessionId: created.sessionId, cwd: workspace, blank: false })],
      })
      expect(await manager.request('skill.list', { sessionId: created.sessionId })).toMatchObject({
        skills: [expect.objectContaining({ name: 'fixture-skill' })],
      })
      await manager.request('session.prompt', {
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: '/permission read-only' }],
        clientTimeZone: 'UTC',
      })
      await expect.poll(async () => {
        const summary = (await manager.request('session.list', {})).items.find(item => item.sessionId === created.sessionId)
        const values: unknown = summary?.projections?.values
        const permission = isRecord(values) ? values['permissions'] : undefined
        return isRecord(permission) ? permission['currentValue'] : undefined
      }).toBe('read-only')
      await manager.stop(10_000)
      expect(manager.state).toEqual({ kind: 'stopped' })
    } catch (error) {
      throw new Error(`${String(error)}\n${logger.lines.join('\n')}`)
    } finally {
      await manager.stop(2_000)
    }
  }, 45_000)
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
