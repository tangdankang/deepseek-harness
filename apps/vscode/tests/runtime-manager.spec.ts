/** Real-process tests for the VS Code-owned DSH runtime lifecycle. */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { runtimeEnvironment } from '../src/environment.ts'
import { RuntimeManager, type RuntimeLaunchConfig, type RuntimeLogger } from '../src/runtime-manager.ts'

class TestLogger implements RuntimeLogger {
  readonly lines: string[] = []
  appendLine(line: string): void { this.lines.push(line) }
}

const fixture = fileURLToPath(new URL('./fixtures/stdio-host.mjs', import.meta.url))

/** Build one fixture launch without inheriting credentials from the test host. */
function launch(...args: string[]): RuntimeLaunchConfig {
  return {
    command: process.execPath,
    args: [fixture, ...args],
    cwd: resolve('.'),
    env: runtimeEnvironment(),
    handshakeTimeoutMs: 5_000,
    stopTimeoutMs: 2_000,
  }
}

describe('RuntimeManager', () => {
  it('starts, handshakes, redacts stderr, and stops the owned process', async () => {
    const logger = new TestLogger()
    const manager = new RuntimeManager('0.1.0', logger)

    await manager.start(launch())
    expect(manager.state).toMatchObject({
      kind: 'connected',
      host: { version: 'fixture-version', attachedSessions: 0 },
    })
    expect(logger.lines.join('\n')).not.toContain('fixturecredential123')
    expect(logger.lines.join('\n')).toContain('[redacted]')

    await manager.stop(2_000)
    expect(manager.state).toEqual({ kind: 'stopped' })
  }, 10_000)

  it('reads and mutates redacted settings only while connected', async () => {
    const logger = new TestLogger()
    const manager = new RuntimeManager('0.1.0', logger)
    await expect(manager.describeSettings()).rejects.toThrow('must be connected')

    await manager.start(launch())
    const described = await manager.describeSettings()
    expect(described).toMatchObject({
      writable: true,
      namespaces: [{ ns: 'permission', value: { defaultPreset: 'confirm-changes' }, revision: 0 }],
    })
    const updated = await manager.mutateSettings({
      ns: 'permission',
      ops: [{ op: 'set', path: ['defaultPreset'], value: 'read-only' }],
      expectedRevision: 0,
    })
    expect(updated).toMatchObject({ ns: 'permission', value: { defaultPreset: 'read-only' }, revision: 1 })
    await manager.stop(2_000)
  }, 10_000)

  it('reports an incompatible handshake and terminates the failed child', async () => {
    const logger = new TestLogger()
    const manager = new RuntimeManager('0.1.0', logger)

    await expect(manager.start(launch('--bad-handshake'))).rejects.toThrow('incompatible')
    expect(manager.state).toMatchObject({ kind: 'error' })
    await manager.stop(2_000)
    expect(manager.state).toEqual({ kind: 'stopped' })
  }, 10_000)

  it('gives each startup readiness request an independent deadline', async () => {
    const logger = new TestLogger()
    const manager = new RuntimeManager('0.1.0', logger)

    await manager.start({ ...launch('--slow-readiness'), handshakeTimeoutMs: 2_500 })
    expect(manager.state.kind).toBe('connected')
    await manager.stop(2_000)
  }, 10_000)

  it('preserves the startup timeout when terminating the failed child', async () => {
    const logger = new TestLogger()
    const manager = new RuntimeManager('0.1.0', logger)

    await expect(manager.start({ ...launch('--slow-settings'), handshakeTimeoutMs: 2_000 }))
      .rejects.toThrow('settings description timed out after 2000 ms')
    await vi.waitFor(() => { expect(manager.state.kind).toBe('error') })
    if (manager.state.kind !== 'error') throw new Error('expected a visible runtime error')
    expect(manager.state.message).toContain('settings description timed out after 2000 ms')
    expect(manager.state.message).not.toContain('SIGTERM')
    await manager.stop(2_000)
  }, 10_000)

  it('turns an unexpected child exit into a visible connection error', async () => {
    const logger = new TestLogger()
    const manager = new RuntimeManager('0.1.0', logger)

    await manager.start(launch('--exit-after-handshake'))
    await vi.waitFor(() => { expect(manager.state.kind).toBe('error') })
    if (manager.state.kind !== 'error') throw new Error('expected a visible runtime error')
    expect(manager.state.message).toContain('code 7')
    await manager.stop(2_000)
  }, 10_000)

  it('starts a requested replacement only after the current stop settles', async () => {
    const logger = new TestLogger()
    const manager = new RuntimeManager('0.1.0', logger)
    const config = launch('--slow-shutdown')
    await manager.start(config)

    const stopping = manager.stop(2_000)
    const starting = manager.start(config)
    await Promise.all([stopping, starting])

    expect(manager.state.kind).toBe('connected')
    await manager.stop(2_000)
  }, 10_000)
})
