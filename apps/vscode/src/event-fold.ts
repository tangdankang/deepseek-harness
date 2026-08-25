/** Pure Host history and live-event reconciliation for the VS Code client. */

import type {
  HistoryEntry, HostFrame, MuxFrame, RpcId, RpcRequest, SessionProjectionsBlock,
} from '@deepseek-ai/dsh-host-apiproxy/api'

type SessionId = Extract<MuxFrame, { type: 'session/event' }>['sessionId']

/** One answerable interaction retained until the Host publishes resolution. */
export type PendingInteraction =
  | { kind: 'approval'; rpcId: RpcId; frame: Extract<MuxFrame, { type: 'approval/requested' }> }
  | { kind: 'question'; rpcId: RpcId; frame: Extract<MuxFrame, { type: 'question/requested' }> }

/** Immutable session facts exposed to later VS Code presentation work. */
export interface SessionEventSnapshot {
  /** Ordered, sequence-deduplicated durable event window. */
  entries: readonly HistoryEntry[]
  /** Latest baseline from the current mux generation. */
  subscribedLastSeq: number | null
  /** Whether a tail history read must finish before live events are complete. */
  reconciling: boolean
  /** Current answerable server requests. */
  interactions: readonly PendingInteraction[]
  /** Current transient queued work. */
  queue: Extract<MuxFrame, { type: 'session/queue' }>['items']
  /** Current transient background jobs. */
  jobs: Extract<MuxFrame, { type: 'session/jobs' }>['jobs']
  /** Latest value per generic projection key. */
  projections: Readonly<Record<string, unknown>>
}

interface SessionState {
  entries: HistoryEntry[]
  subscribedLastSeq: number | null
  reconciling: boolean
  live: HistoryEntry[]
  interactions: Map<RpcId, PendingInteraction>
  queue: Extract<MuxFrame, { type: 'session/queue' }>['items']
  jobs: Extract<MuxFrame, { type: 'session/jobs' }>['jobs']
  projections: Map<string, { seq: number; value: unknown }>
}

/**
 * Fold one connection generation without depending on VS Code or browser UI.
 * History replaces the durable tail; frames received during that read stitch
 * above it by event sequence, so replay overlap is emitted only once.
 */
export class HostEventFold {
  private readonly sessions = new Map<SessionId, SessionState>()
  private readonly listeners = new Set<() => void>()
  private readonly tracked = new Set<SessionId>()
  private readonly hostFrames = new Map<string, HostFrame>()

  /** Sessions whose tail page is re-read on every process generation. */
  get trackedSessionIds(): readonly SessionId[] {
    return [...this.tracked]
  }

  /** Begin a fresh process generation and discard process-local state. */
  beginConnection(): void {
    this.hostFrames.clear()
    for (const [sessionId, state] of this.sessions) {
      state.subscribedLastSeq = null
      state.interactions.clear()
      state.queue = []
      state.jobs = []
      state.live = []
      state.reconciling = this.tracked.has(sessionId)
    }
    this.publish()
  }

  /** Retain a session for history repair across process restarts. */
  track(sessionId: SessionId): void {
    this.tracked.add(sessionId)
    this.stateFor(sessionId).reconciling = true
  }

  /** Mark a tail history read as active without discarding buffered live frames. */
  beginHistory(sessionId: SessionId): void {
    this.track(sessionId)
    this.stateFor(sessionId).reconciling = true
  }

  /**
   * Install a tail history page and stitch current-generation live events.
   * @returns whether the mux baseline or a sequence gap requires one more tail read.
   */
  installHistory(sessionId: SessionId, entries: readonly HistoryEntry[]): boolean {
    const state = this.stateFor(sessionId)
    const bySeq = new Map<number, HistoryEntry>()
    for (const entry of entries) bySeq.set(entry.event.seq, entry)
    const ordered = [...entries].sort((left, right) => left.event.seq - right.event.seq)
    let tail = ordered.at(-1)?.event.seq ?? -1
    let gap = false
    for (const entry of [...state.live].sort((left, right) => left.event.seq - right.event.seq)) {
      if (entry.event.seq <= tail) continue
      if (entry.event.seq !== tail + 1) {
        gap = true
        continue
      }
      bySeq.set(entry.event.seq, entry)
      tail = entry.event.seq
    }
    state.entries = [...bySeq.values()].sort((left, right) => left.event.seq - right.event.seq)
    const baselineAhead = state.subscribedLastSeq !== null && state.subscribedLastSeq > tail
    const needsRefresh = gap || baselineAhead
    if (!needsRefresh) {
      state.live = []
      state.reconciling = false
    }
    this.publish()
    return needsRefresh
  }

  /** Seed generic projections from a list or tail-history baseline. */
  seedProjections(sessionId: SessionId, block: SessionProjectionsBlock | undefined): void {
    if (block === undefined) return
    const state = this.stateFor(sessionId)
    for (const [key, value] of Object.entries(block.values)) {
      const current = state.projections.get(key)
      if (current === undefined || block.asOfSeq >= current.seq) state.projections.set(key, { seq: block.asOfSeq, value })
    }
    this.publish()
  }

  /** Prepend an older history page while preserving the reconciled tail. */
  prependHistory(sessionId: SessionId, entries: readonly HistoryEntry[]): void {
    const state = this.stateFor(sessionId)
    const bySeq = new Map(state.entries.map(entry => [entry.event.seq, entry]))
    for (const entry of entries) bySeq.set(entry.event.seq, entry)
    state.entries = [...bySeq.values()].sort((left, right) => left.event.seq - right.event.seq)
    this.publish()
  }

  /** Fold one validated mux envelope. */
  acceptMux(envelope: RpcRequest<MuxFrame>): void {
    const frame = envelope.payload
    if (frame.type === 'stream/error') return
    const state = this.stateFor(frame.sessionId)
    switch (frame.type) {
      case 'session/subscribed':
        state.subscribedLastSeq = frame.lastSeq
        state.interactions.clear()
        break
      case 'session/event':
        this.acceptEvent(state, { event: frame.event, ...(frame.view === undefined ? {} : { view: frame.view }) })
        break
      case 'approval/requested':
        state.interactions.set(envelope.rpcId, { kind: 'approval', rpcId: envelope.rpcId, frame })
        break
      case 'approval/resolved':
        this.deleteApproval(state, frame.approvalId)
        break
      case 'question/requested':
        state.interactions.set(envelope.rpcId, { kind: 'question', rpcId: envelope.rpcId, frame })
        break
      case 'question/resolved':
        state.interactions.delete(frame.questionRpcId)
        break
      case 'session/queue':
        state.queue = [...frame.items]
        break
      case 'session/jobs':
        state.jobs = [...frame.jobs]
        break
      case 'session/projection':
        if ((state.projections.get(frame.key)?.seq ?? -1) < frame.seq) {
          state.projections.set(frame.key, { seq: frame.seq, value: frame.value })
        }
        break
      default:
        assertNever(frame)
    }
    this.publish()
  }

  /** Fold the latest host-wide full-state or per-session frame. */
  acceptHost(envelope: RpcRequest<HostFrame>): void {
    const frame = envelope.payload
    if (frame.type === 'stream/error') return
    this.hostFrames.set(hostFrameKey(frame), frame)
    this.publish()
  }

  /** Read one session snapshot without exposing mutable fold state. */
  snapshot(sessionId: SessionId): SessionEventSnapshot {
    const state = this.stateFor(sessionId)
    return {
      entries: [...state.entries],
      subscribedLastSeq: state.subscribedLastSeq,
      reconciling: state.reconciling,
      interactions: [...state.interactions.values()],
      queue: [...state.queue],
      jobs: [...state.jobs],
      projections: Object.fromEntries([...state.projections].map(([key, entry]) => [key, entry.value])),
    }
  }

  /** Read the current process-local Host frame set. */
  hostSnapshot(): readonly HostFrame[] {
    return [...this.hostFrames.values()]
  }

  /** Subscribe to folded-state changes. Listener failures are contained. */
  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private acceptEvent(state: SessionState, entry: HistoryEntry): void {
    if (state.reconciling) {
      if (!state.live.some(current => current.event.seq === entry.event.seq)) state.live.push(entry)
      return
    }
    const tail = state.entries.at(-1)?.event.seq ?? -1
    if (entry.event.seq <= tail) return
    if (entry.event.seq !== tail + 1) {
      state.live.push(entry)
      state.reconciling = true
      return
    }
    state.entries.push(entry)
  }

  private deleteApproval(state: SessionState, approvalId: string): void {
    for (const [requestId, interaction] of state.interactions) {
      if (interaction.kind === 'approval' && interaction.frame.approvalId === approvalId) {
        state.interactions.delete(requestId)
      }
    }
  }

  private stateFor(sessionId: SessionId): SessionState {
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      state = {
        entries: [], subscribedLastSeq: null, reconciling: true, live: [], interactions: new Map(),
        queue: [], jobs: [], projections: new Map(),
      }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  private publish(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // Presentation listeners cannot break protocol reconciliation.
      }
    }
  }
}

function hostFrameKey(frame: Exclude<HostFrame, { type: 'stream/error' }>): string {
  if ('sessionId' in frame) return `${frame.type}:${frame.sessionId}`
  if ('workspaceId' in frame) return `${frame.type}:${frame.workspaceId}`
  return frame.type
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Host mux frame: ${JSON.stringify(value)}`)
}
