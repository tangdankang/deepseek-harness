/** P2 session selection, pagination, prompt persistence, and permission orchestration. */

import { describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => {
  class Uri {
    constructor(readonly scheme: string, readonly path: string, readonly fsPath: string) {}
    static file(path: string): Uri { return new Uri('file', path, path) }
    static from(value: { scheme: string; path: string }): Uri { return new Uri(value.scheme, value.path, value.path) }
    toString(): string { return `${this.scheme}:${this.path}` }
  }
  return {
    Uri,
    workspace: {
      getWorkspaceFolder: () => ({ name: 'repo', uri: { fsPath: '/repo' } }),
      registerTextDocumentContentProvider: () => ({ dispose() {} }),
    },
    commands: { executeCommand: vi.fn() },
  }
})

import { ConversationController } from '../src/conversation.ts'
import { ContextCollector } from '../src/context.ts'
import { HostEventFold } from '../src/event-fold.ts'
import type { RuntimeState } from '../src/runtime-manager.ts'

const connected: RuntimeState = {
  kind: 'connected',
  host: { version: '1', cwd: '/repo', attachedSessions: 1, canOpenPath: true, provider: 'fixture', model: 'model' },
  defaultPermission: 'confirm-changes',
}

describe('ConversationController', () => {
  it('restores a session, paginates, and persists exact context text in the prompt', async () => {
    const events = new HostEventFold()
    const requests: Array<{ method: string; payload: Record<string, unknown> }> = []
    const request = vi.fn(async (method: string, payload: Record<string, unknown>) => {
      requests.push({ method, payload })
      if (method === 'session.list') return {
        items: [{
          sessionId: 'session-1', updatedAt: 1, running: false, blank: false, cwd: '/repo',
          projections: { asOfSeq: 0, values: { title: 'Restored', permissions: {
            currentValue: 'confirm-changes', options: [
              { value: 'read-only', name: 'Read-only' },
              { value: 'confirm-changes', name: 'Confirm changes' },
              { value: 'workspace-write', name: 'Workspace writes' },
            ],
          } } },
        }],
      }
      if (method === 'session.history' && payload['beforeSeq'] !== undefined) return {
        events: [{ event: {
          type: 'user/message', seq: 0, time: 0, surfaceOp: 'append',
          data: { id: 'old', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'older' }] },
        } }],
        hasMore: false,
      }
      if (method === 'session.history') return {
        events: [{ event: {
          type: 'assistant/message', seq: 2, time: 2, surfaceOp: 'append',
          data: { turn: 1, step: 1, message: { id: 'a', role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'model' }, content: [{ type: 'text', text: '**ready**' }] } },
        } }],
        hasMore: true,
        projections: { asOfSeq: 2, values: {} },
      }
      if (method === 'skill.list') return { skills: [{ name: 'typed-edits', description: 'Typed edits', modelInvocable: true }] }
      if (method === 'session.models') return {
        current: { provider: 'fixture', model: 'model' }, routable: true, failures: [],
        groups: [{ id: 'fixture', name: 'Fixture', models: [{ id: 'model', name: 'Model' }] }],
      }
      if (method === 'session.prompt') return { accepted: true }
      throw new Error(`unexpected ${method}`)
    })
    const manager = {
      state: connected, events, request,
      respondApproval: vi.fn(),
    }
    const memory = new Map<string, unknown>([['dsh.activeSessionId', 'session-1']])
    const memento = { get: (key: string) => memory.get(key), update: async (key: string, value: unknown) => { memory.set(key, value) } }
    const context = new ContextCollector({ maxFileBytes: 1_000, maxTotalBytes: 5_000, maxFolderFiles: 10 })
    context.addSelection({
      document: { uri: { fsPath: '/repo/src/value.ts' }, getText: () => 'const value = 1' },
      selection: { isEmpty: false, start: { line: 0 }, end: { line: 0, character: 15 } },
    } as never)
    const controller = new ConversationController(manager as never, memento as never, context, {} as never, {
      historyPageMessages: 20, maxToolOutputChars: 1_000, maxDiffBytes: 1_000,
    })

    await controller.setRuntimeState(connected)
    expect(controller.model).toMatchObject({
      activeSessionId: 'session-1', hasMore: true,
      transcript: [{ kind: 'message', role: 'assistant', text: '**ready**', html: '<p><strong>ready</strong></p>' }],
      skills: [{ name: 'typed-edits' }],
      permission: { current: 'confirm-changes' },
    })

    await controller.loadOlder()
    expect(controller.model.transcript.map(item => item.kind === 'message' ? item.text : '')).toEqual(['older', '**ready**'])
    await controller.prompt('Change it')
    const promptRequest = requests.at(-1)
    if (promptRequest === undefined) throw new Error('expected prompt request')
    const content = promptRequest.payload['content']
    const firstPart = isUnknownArray(content) ? content[0] : undefined
    if (!isRecord(firstPart) || typeof firstPart['text'] !== 'string') throw new Error('expected persisted prompt text')
    expect(promptRequest.method).toBe('session.prompt')
    expect(firstPart['text']).toContain('<dsh-context source="selection" path="src/value.ts" lines="1-1">')
    expect(firstPart['text']).toContain('<user-task>\nChange it\n</user-task>')
    expect(controller.model.context).toEqual([])
    controller.dispose()
  })

  it('keeps repairing a stale history baseline until later live approvals can correlate', async () => {
    const events = new HostEventFold()
    events.acceptMux({
      rpcId: 'subscribed' as never,
      payload: { type: 'session/subscribed', sessionId: 'session-1' as never, lastSeq: 2 },
    })
    let historyReads = 0
    const request = vi.fn(async (method: string) => {
      if (method === 'session.list') return {
        items: [{
          sessionId: 'session-1', updatedAt: 1, running: true, blank: false, cwd: '/repo',
          projections: { asOfSeq: 0, values: {} },
        }],
      }
      if (method === 'session.history') {
        historyReads += 1
        return {
          events: Array.from({ length: historyReads }, (_, seq) => ({ event: {
            type: 'user/message', seq, time: seq, surfaceOp: 'append',
            data: {
              id: `message-${seq}`, role: 'user', source: { kind: 'user' },
              content: [{ type: 'text', text: `message ${seq}` }],
            },
          } })),
          hasMore: false,
          projections: { asOfSeq: historyReads - 1, values: {} },
        }
      }
      if (method === 'skill.list') return { skills: [] }
      if (method === 'session.models') return {
        current: { provider: 'fixture', model: 'model' }, routable: true, failures: [],
        groups: [{ id: 'fixture', name: 'Fixture', models: [{ id: 'model', name: 'Model' }] }],
      }
      throw new Error(`unexpected ${method}`)
    })
    const controller = new ConversationController({
      state: connected, events, request, respondApproval: vi.fn(),
    } as never, { get: () => undefined, update: async () => {} } as never,
    new ContextCollector({ maxFileBytes: 100, maxTotalBytes: 500, maxFolderFiles: 5 }), {} as never,
    { historyPageMessages: 20, maxToolOutputChars: 100, maxDiffBytes: 100 })

    await controller.setRuntimeState(connected)

    expect(historyReads).toBe(3)
    expect(controller.model.reconciling).toBe(false)
    expect(controller.model.transcript).toHaveLength(3)

    events.acceptMux({
      rpcId: 'live-gap' as never,
      payload: { type: 'session/event', sessionId: 'session-1' as never, event: {
        type: 'user/message', seq: 4, time: 4, surfaceOp: 'append',
        data: {
          id: 'message-4', role: 'user', source: { kind: 'user' },
          content: [{ type: 'text', text: 'message 4' }],
        },
      } },
    })
    await vi.waitFor(() => { expect(controller.model.reconciling).toBe(false) })
    expect(historyReads).toBe(4)
    expect(controller.model.transcript).toHaveLength(5)
    controller.dispose()
  })

  it('switches the active permission and future default through authoritative Host paths', async () => {
    const events = new HostEventFold()
    const request = vi.fn(async (method: string) => {
      if (method === 'session.prompt') return { accepted: true }
      throw new Error(`unexpected ${method}`)
    })
    const mutateSettings = vi.fn().mockResolvedValue({})
    const manager = {
      state: connected, events, request, respondApproval: vi.fn(),
      describeSettings: vi.fn().mockResolvedValue({ namespaces: [{ ns: 'permission', revision: 3 }] }),
      mutateSettings,
      refreshConfiguration: vi.fn().mockResolvedValue(undefined),
    }
    const controller = new ConversationController(manager as never, { get: () => undefined, update: async () => {} } as never,
      new ContextCollector({ maxFileBytes: 100, maxTotalBytes: 500, maxFolderFiles: 5 }), {} as never,
      { historyPageMessages: 20, maxToolOutputChars: 100, maxDiffBytes: 100 })
    const selected = controller as unknown as { activeSessionId: string }
    selected.activeSessionId = 'session-1'

    await controller.selectPermission('read-only')
    expect(request).toHaveBeenCalledWith('session.prompt', expect.objectContaining({
      content: [{ type: 'text', text: '/permission read-only' }],
    }))
    expect(mutateSettings).toHaveBeenCalledWith({
      ns: 'permission', expectedRevision: 3, ops: [{ op: 'set', path: ['defaultPreset'], value: 'read-only' }],
    })
    controller.dispose()
  })

  it('projects host session additions and makes a running blank session visible', async () => {
    const events = new HostEventFold()
    const manager = {
      state: connected,
      events,
      request: vi.fn(),
      respondApproval: vi.fn(),
    }
    const controller = new ConversationController(manager as never, { get: () => undefined, update: async () => {} } as never,
      new ContextCollector({ maxFileBytes: 100, maxTotalBytes: 500, maxFolderFiles: 5 }), {} as never,
      { historyPageMessages: 20, maxToolOutputChars: 100, maxDiffBytes: 100 })

    events.acceptHost({
      rpcId: 'added' as never,
      payload: { type: 'host/session-added', sessionId: 'session-2' as never, blank: true, cwd: '/repo/other' },
    })
    expect(controller.model.sessions).toEqual([])

    events.acceptHost({
      rpcId: 'running' as never,
      payload: { type: 'host/session-status', sessionId: 'session-2' as never, running: true },
    })
    await vi.waitFor(() => {
      expect(controller.model.sessions).toEqual([expect.objectContaining({ id: 'session-2', title: 'other', running: true })])
    })
    controller.dispose()
  })
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}
