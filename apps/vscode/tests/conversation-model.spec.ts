/** Pure transcript projection tests for P2 conversation rendering. */

import type { HistoryEntry, SessionSummary } from '@deepseek-ai/dsh-host-apiproxy/api'
import { describe, expect, it } from 'vitest'
import { sessionRow, transcriptOf } from '../src/conversation-model.ts'

function entry(event: unknown, view?: HistoryEntry['view']): HistoryEntry {
  return { event: event as never, ...(view === undefined ? {} : { view }) }
}

describe('conversation model', () => {
  it('renders visible messages, streaming status, and tool lifecycle without reasoning text', () => {
    const entries: HistoryEntry[] = [
      entry({
        type: 'user/message', seq: 0, time: 0, surfaceOp: 'append',
        data: { role: 'user', id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'Change it' }] },
      }),
      entry({
        type: 'assistant/chunk', seq: 1, time: 1,
        data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'private reasoning' } },
      }),
      entry({
        type: 'assistant/chunk', seq: 2, time: 2,
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'Working' } },
      }),
      entry({
        type: 'tool/call', seq: 3, time: 3,
        data: { turn: 1, step: 1, callId: 'call-1', name: 'pwsh', arguments: '{"command":"pnpm test"}' },
      }, { for: 'call', view: { card: 'terminal', title: 'pnpm test', cwd: 'C:\\repo' } }),
      entry({
        type: 'tool/result', seq: 4, time: 4, surfaceOp: 'append',
        data: {
          turn: 1, step: 1,
          message: {
            id: 'r', role: 'user', source: { kind: 'tool', callId: 'call-1', name: 'pwsh' },
            content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] }],
          },
        },
      }, { for: 'result', view: { card: 'terminal', output: 'ok', exitCode: 0 } }),
    ]

    const transcript = transcriptOf(entries, 100)
    expect(transcript).toMatchObject([
      { kind: 'message', role: 'user', text: 'Change it' },
      { kind: 'message', role: 'assistant', text: 'Working', streaming: true, reasoning: true },
      { kind: 'tool', card: 'terminal', title: 'pnpm test', status: 'completed', detail: 'ok', exit: 'exit 0' },
    ])
    expect(JSON.stringify(transcript)).not.toContain('private reasoning')
  })

  it('suppresses finalized chunk sources and uses Host diff render intent', () => {
    const transcript = transcriptOf([
      entry({
        type: 'assistant/chunk', seq: 0, time: 0,
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'partial' } },
      }),
      entry({
        type: 'assistant/message', seq: 1, time: 1, surfaceOp: 'append', sourceEventSeqs: [0],
        data: {
          turn: 1, step: 1,
          message: { id: 'a', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'final' }] },
        },
      }),
      entry({
        type: 'tool/call', seq: 2, time: 2,
        data: { turn: 1, step: 1, callId: 'edit-1', name: 'edit', arguments: '{}' },
      }, { for: 'call', view: { card: 'diff', title: 'Edit value.ts', diffs: [{ path: 'value.ts', oldText: '1', newText: '2' }] } }),
    ], 100)

    expect(transcript).toMatchObject([
      { kind: 'message', text: 'final' },
      { kind: 'tool', card: 'diff', title: 'Edit value.ts', status: 'running' },
    ])
  })

  it('uses projected titles before path and id fallbacks', () => {
    const summary = {
      sessionId: 'session-12345678', updatedAt: 1, running: false, blank: false, cwd: 'C:\\repo',
      projections: { asOfSeq: 2, values: { title: 'Typed edits' } },
    } as unknown as SessionSummary
    expect(sessionRow(summary)).toEqual({ id: 'session-12345678', title: 'Typed edits', cwd: 'C:\\repo', running: false })
  })
})
