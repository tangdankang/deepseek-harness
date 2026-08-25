/** History/live overlap and reconnect reconciliation for the VS Code fold. */

import type { HistoryEntry, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { describe, expect, it } from 'vitest'
import { HostEventFold } from '../src/event-fold.ts'

const sessionId = 'session-1' as never

function entry(seq: number): HistoryEntry {
  return { event: { type: 'test/event', seq, time: seq, data: {} } as never }
}

function mux(rpcId: string, payload: MuxFrame): RpcRequest<MuxFrame> {
  return { rpcId: rpcId as never, payload }
}

describe('HostEventFold', () => {
  it('stitches live frames above history and drops the overlapping sequence', () => {
    const fold = new HostEventFold()
    fold.track(sessionId)
    fold.beginConnection()
    fold.acceptMux(mux('subscribed', { type: 'session/subscribed', sessionId, lastSeq: 3 }))
    fold.acceptMux(mux('live-overlap', { type: 'session/event', sessionId, event: entry(2).event }))
    fold.acceptMux(mux('live-next', { type: 'session/event', sessionId, event: entry(3).event }))

    expect(fold.installHistory(sessionId, [entry(0), entry(1), entry(2)])).toBe(false)
    expect(fold.snapshot(sessionId).entries.map(item => item.event.seq)).toEqual([0, 1, 2, 3])
    expect(fold.snapshot(sessionId).reconciling).toBe(false)
  })

  it('requests a second tail read when the mux baseline is ahead', () => {
    const fold = new HostEventFold()
    fold.track(sessionId)
    fold.beginConnection()
    fold.acceptMux(mux('subscribed', { type: 'session/subscribed', sessionId, lastSeq: 4 }))

    expect(fold.installHistory(sessionId, [entry(0), entry(1)])).toBe(true)
    expect(fold.installHistory(sessionId, [entry(0), entry(1), entry(2), entry(3), entry(4)])).toBe(false)
  })

  it('clears stale interactions and accepts replayed approval ids after reconnect', () => {
    const fold = new HostEventFold()
    fold.track(sessionId)
    fold.acceptMux(mux('old-rpc', {
      type: 'approval/requested', sessionId, approvalId: 'approval-1' as never, toolName: 'write',
    }))
    expect(fold.snapshot(sessionId).interactions).toHaveLength(1)

    fold.beginConnection()
    expect(fold.snapshot(sessionId).interactions).toEqual([])
    fold.acceptMux(mux('replayed-rpc', {
      type: 'approval/requested', sessionId, approvalId: 'approval-1' as never, toolName: 'write',
    }))
    expect(fold.snapshot(sessionId).interactions).toMatchObject([{ rpcId: 'replayed-rpc' }])
  })

  it('folds transient queue/job snapshots, projections, and older pages', () => {
    const fold = new HostEventFold()
    fold.installHistory(sessionId, [entry(2)])
    fold.prependHistory(sessionId, [entry(0), entry(1)])
    fold.seedProjections(sessionId, { asOfSeq: 2, values: { title: 'Baseline' } })
    fold.acceptMux(mux('projection', {
      type: 'session/projection', sessionId, key: 'title', value: 'Live', seq: 3,
    }))
    fold.acceptMux(mux('queue', {
      type: 'session/queue', sessionId, items: [{ id: 'message-1' as never, placement: 'queued', message: {} as never }],
    }))
    fold.acceptMux(mux('jobs', {
      type: 'session/jobs', sessionId, jobs: [{ id: 'job-1' } as never],
    }))

    expect(fold.snapshot(sessionId)).toMatchObject({
      entries: [{ event: { seq: 0 } }, { event: { seq: 1 } }, { event: { seq: 2 } }],
      projections: { title: 'Live' },
      queue: [{ placement: 'queued' }],
      jobs: [{ id: 'job-1' }],
    })
  })
})
