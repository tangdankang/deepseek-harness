/** Exact Diff, one-shot response, and stale-preview approval tests. */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'

const state = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  commands: vi.fn(),
}))

vi.mock('vscode', () => {
  class Uri {
    constructor(readonly scheme: string, readonly path: string, readonly fsPath: string) {}
    static file(path: string): Uri { return new Uri('file', path, path) }
    static from(value: { scheme: string; path: string }): Uri { return new Uri(value.scheme, value.path, value.path) }
    toString(): string { return `${this.scheme}:${this.path}` }
  }
  class FileSystemError extends Error {
    constructor(message: string, readonly code: string) { super(message) }
  }
  return {
    Uri,
    FileSystemError,
    workspace: {
      registerTextDocumentContentProvider: () => ({ dispose() {} }),
      fs: {
        readFile: async (uri: { fsPath: string }) => {
          const value = state.files.get(uri.fsPath)
          if (value === undefined) throw new FileSystemError('missing', 'FileNotFound')
          return value
        },
      },
    },
    commands: { executeCommand: state.commands },
  }
})

import type { HistoryEntry } from '@deepseek-ai/dsh-host-apiproxy/api'
import { ApprovalCoordinator } from '../src/approvals.ts'
import type { PendingInteraction } from '../src/event-fold.ts'

function call(
  callId: string,
  name: string,
  args: object,
  view: NonNullable<HistoryEntry['view']>,
): HistoryEntry {
  return {
    event: { type: 'tool/call', seq: 1, time: 1, data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) } } as never,
    view,
  }
}

function approval(id: string, callId: string, toolName = 'edit'): Extract<PendingInteraction, { kind: 'approval' }> {
  return {
    kind: 'approval', rpcId: `rpc-${id}` as never,
    frame: { type: 'approval/requested', sessionId: 'session-1' as never, approvalId: id as never, callId: callId as never, toolName },
  }
}

describe('ApprovalCoordinator', () => {
  beforeEach(() => {
    state.files.clear()
    state.commands.mockReset()
  })

  it('prepares and opens an exact edit Diff before allowing once', async () => {
    state.files.set(resolve('/repo', 'value.ts'), new TextEncoder().encode('const value = 1\n'))
    const respondApproval = vi.fn().mockResolvedValue({ accepted: true })
    const coordinator = new ApprovalCoordinator({ respondApproval })
    const interaction = approval('approval-1', 'call-1')

    const cards = await coordinator.prepare('/repo', [call('call-1', 'edit', {
      file_path: 'value.ts', old_string: '1', new_string: '2',
    }, { for: 'call', view: { card: 'diff', title: 'Edit value.ts', diffs: [{ path: 'value.ts', oldText: '1', newText: '2' }] } })], [interaction], 1_000)

    expect(cards).toMatchObject([{ kind: 'diff', detail: 'value.ts', allowEnabled: true }])
    const previewId = cards[0]?.previewId
    if (previewId === undefined) throw new Error('expected Diff preview')
    await coordinator.openPreview(previewId)
    expect(state.commands).toHaveBeenCalledWith('vscode.diff', expect.anything(), expect.anything(), 'Edit value.ts', { preview: true })
    await coordinator.allowOnce('approval-1')
    expect(respondApproval).toHaveBeenCalledWith('rpc-approval-1', {
      sessionId: 'session-1', approvalId: 'approval-1', outcome: 'allowed-once',
    })
    coordinator.dispose()
  })

  it('upgrades a preparing approval after reconciled history supplies its tool call', async () => {
    state.files.set(resolve('/repo', 'value.txt'), new TextEncoder().encode('alpha'))
    const coordinator = new ApprovalCoordinator({ respondApproval: vi.fn() })
    const interaction = approval('approval-reconciled', 'call-reconciled')

    await expect(coordinator.prepare('/repo', [], [interaction], 1_000)).resolves.toMatchObject([{
      kind: 'preparing', allowEnabled: false,
    }])
    const reconciled = await coordinator.prepare('/repo', [call('call-reconciled', 'edit', {
      file_path: 'value.txt', old_string: 'alpha', new_string: 'beta',
    }, {
      for: 'call', view: {
        card: 'diff', title: 'Edit value.txt',
        diffs: [{ path: 'value.txt', oldText: 'alpha', newText: 'beta' }],
      },
    })], [interaction], 1_000)
    expect(reconciled).toMatchObject([{
      title: 'Edit value.txt', kind: 'diff', detail: 'value.txt', allowEnabled: true,
    }])
    expect(typeof reconciled[0]?.previewId).toBe('string')
    coordinator.dispose()
  })

  it('rejects a stale file snapshot instead of granting it', async () => {
    state.files.set(resolve('/repo', 'value.ts'), new TextEncoder().encode('before'))
    const respondApproval = vi.fn().mockResolvedValue({ accepted: true })
    const coordinator = new ApprovalCoordinator({ respondApproval })
    const interaction = approval('approval-stale', 'call-stale', 'write')
    await coordinator.prepare('/repo', [call('call-stale', 'write', {
      file_path: 'value.ts', content: 'after',
    }, { for: 'call', view: { card: 'diff', title: 'Write value.ts', diffs: [{ path: 'value.ts', oldText: null, newText: 'after' }] } })], [interaction], 1_000)
    state.files.set(resolve('/repo', 'value.ts'), new TextEncoder().encode('changed elsewhere'))

    await expect(coordinator.allowOnce('approval-stale')).rejects.toThrow(/已拒绝这个过期操作/u)
    expect(respondApproval).toHaveBeenCalledWith('rpc-approval-stale', {
      sessionId: 'session-1', approvalId: 'approval-stale', outcome: 'rejected',
    })
    coordinator.dispose()
  })

  it('offers rejection only when a modifying tool has no supported preview', async () => {
    const respondApproval = vi.fn().mockResolvedValue({ accepted: true })
    const coordinator = new ApprovalCoordinator({ respondApproval })
    const interaction = approval('approval-unsupported', 'call-unsupported', 'str_replace_editor')
    const cards = await coordinator.prepare('/repo', [call('call-unsupported', 'str_replace_editor', {}, {
      for: 'call', view: { card: 'generic', title: 'Replace text' },
    })], [interaction], 1_000)

    expect(cards).toMatchObject([{ kind: 'unsupported', allowEnabled: false }])
    await expect(coordinator.allowOnce('approval-unsupported')).rejects.toThrow(/不能在 VS Code 中批准/u)
    await coordinator.reject('approval-unsupported')
    expect(respondApproval).toHaveBeenCalledWith('rpc-approval-unsupported', expect.objectContaining({ outcome: 'rejected' }))
    coordinator.dispose()
  })
})
