/** P2 conversation orchestration between the owned Host process and Webview. */

import type { SessionSummary, SkillEntry } from '@deepseek-ai/dsh-host-apiproxy/api'
import { micromark } from 'micromark'
import type * as vscode from 'vscode'
import { ApprovalCoordinator, type ApprovalCard } from './approvals.ts'
import { sessionRow, transcriptOf, type ConversationSessionRow, type TranscriptItem } from './conversation-model.ts'
import { ContextCollector, type ContextChip } from './context.ts'
import type { RuntimeManager, RuntimeState } from './runtime-manager.ts'
import type { SkillFiles } from './skills.ts'

const ACTIVE_SESSION_KEY = 'dsh.activeSessionId'

/** One model choice displayed by the compact selector. */
export interface ModelOption {
  /** Stable provider/model pair. */
  value: string
  /** Provider and model display label. */
  label: string
}

/** Complete serializable conversation state sent to the Webview. */
export interface ConversationViewModel {
  /** Runtime lifecycle shown above conversation controls. */
  runtime: RuntimeState
  /** Visible ordinary sessions. */
  sessions: readonly ConversationSessionRow[]
  /** Selected session id. */
  activeSessionId?: string
  /** Selected session transcript. */
  transcript: readonly TranscriptItem[]
  /** Whether an earlier history page is available. */
  hasMore: boolean
  /** Whether history/live reconciliation is active. */
  reconciling: boolean
  /** Selected session running state. */
  running: boolean
  /** Current session permission mode and choices. */
  permission?: { current: string; options: readonly { value: string; name: string }[] }
  /** Current model and routable model catalog. */
  models: { current?: string; options: readonly ModelOption[]; routable: boolean }
  /** Current Host Skill catalog. */
  skills: readonly SkillEntry[]
  /** Removable draft context tags. */
  context: readonly ContextChip[]
  /** Current approval cards. */
  approvals: readonly ApprovalCard[]
  /** Number of pending queued prompts. */
  queued: number
}

/** Deployment-varying conversation and review budgets. */
export interface ConversationLimits {
  historyPageMessages: number
  maxToolOutputChars: number
  maxDiffBytes: number
}

/** Own session selection, history, prompts, Skills, context, and approvals. */
export class ConversationController implements vscode.Disposable {
  private readonly approvals: ApprovalCoordinator
  private readonly listeners = new Set<(model: ConversationViewModel) => void>()
  private sessions: SessionSummary[] = []
  private activeSessionId: string | undefined
  private hasMore = false
  private skills: readonly SkillEntry[] = []
  private models: ConversationViewModel['models'] = { options: [], routable: true }
  private approvalCards: readonly ApprovalCard[] = []
  private runtimeState: RuntimeState
  private projectionGeneration = 0
  private readonly historyRepairs = new Map<string, Promise<void>>()
  private readonly disposeEvents: () => void

  /**
   * @param manager - owned runtime and typed Host API.
   * @param memento - workspace-local active-session storage.
   * @param context - in-memory removable prompt context.
   * @param skillFiles - approved project/user Skill locations.
   * @param limits - validated view/history/Diff budgets.
   */
  constructor(
    private readonly manager: RuntimeManager,
    private readonly memento: Pick<vscode.Memento, 'get' | 'update'>,
    readonly context: ContextCollector,
    readonly skillFiles: SkillFiles,
    private readonly limits: ConversationLimits,
  ) {
    this.runtimeState = manager.state
    this.approvals = new ApprovalCoordinator(manager)
    this.disposeEvents = manager.events.onDidChange(() => { void this.publishFromFold() })
  }

  /** Subscribe to complete serializable view updates. */
  onDidChange(listener: (model: ConversationViewModel) => void): vscode.Disposable {
    this.listeners.add(listener)
    return { dispose: () => { this.listeners.delete(listener) } }
  }

  /** Current complete view snapshot. */
  get model(): ConversationViewModel {
    const active = this.activeSummary()
    const snapshot = this.activeSessionId === undefined ? undefined : this.manager.events.snapshot(this.activeSessionId as never)
    const transcript = snapshot === undefined
      ? []
      : transcriptOf(snapshot.entries, this.limits.maxToolOutputChars).map(item =>
        item.kind === 'message' && item.role === 'assistant'
          ? { ...item, html: micromark(item.text) }
          : item)
    const permission = permissionOf(snapshot?.projections['permissions'])
    return {
      runtime: this.runtimeState,
      sessions: this.sessionRows(),
      ...(this.activeSessionId === undefined ? {} : { activeSessionId: this.activeSessionId }),
      transcript,
      hasMore: this.hasMore,
      reconciling: snapshot?.reconciling ?? false,
      running: active?.running ?? false,
      ...(permission === undefined ? {} : { permission }),
      models: this.models,
      skills: this.skills,
      context: this.context.chips,
      approvals: this.approvalCards,
      queued: snapshot?.queue.filter(item => item.placement === 'queued').length ?? 0,
    }
  }

  /** React to runtime lifecycle changes and load the connected Host baseline. */
  async setRuntimeState(state: RuntimeState): Promise<void> {
    this.runtimeState = state
    if (state.kind === 'connected') await this.refreshSessions()
    if (state.kind !== 'connected') {
      this.skills = []
      this.models = { options: [], routable: true }
      this.approvalCards = []
    }
    this.publish()
  }

  /** Refresh the authoritative session list and restore local selection. */
  async refreshSessions(): Promise<void> {
    if (this.runtimeState.kind !== 'connected') return
    const value = await this.manager.request('session.list', {})
    this.sessions = [...value.items]
    for (const summary of this.sessions) this.manager.events.seedProjections(summary.sessionId, summary.projections)
    const stored = this.memento.get<string>(ACTIVE_SESSION_KEY)
    const selected = this.activeSessionId ?? stored
    const next = selected !== undefined && this.sessions.some(row => row.sessionId === selected)
      ? selected
      : this.sessions.find(row => !row.blank && row.origin !== 'subagent')?.sessionId
    if (next !== undefined) await this.selectSession(next)
    else this.publish()
  }

  /** Create or reuse the workspace's blank session and select it. */
  async newSession(cwd: string): Promise<void> {
    this.requireConnected()
    const reusable = this.sessions.find(row => row.blank && row.cwd === cwd && row.origin !== 'subagent')
    const id = reusable?.sessionId ?? (await this.manager.request('session.create', { cwd })).sessionId
    await this.refreshSessions()
    await this.selectSession(id)
  }

  /** Select one durable ordinary session and reconcile its tail. */
  async selectSession(sessionId: string): Promise<void> {
    this.requireConnected()
    if (!this.sessions.some(row => row.sessionId === sessionId && row.origin !== 'subagent')) {
      throw new Error('The selected DSH session is unavailable')
    }
    this.activeSessionId = sessionId
    await this.memento.update(ACTIVE_SESSION_KEY, sessionId)
    await this.loadTail(sessionId)
    await Promise.all([this.refreshSkills(), this.refreshModels()])
    await this.publishFromFold()
  }

  /** Load the next complete older-message history page. */
  async loadOlder(): Promise<void> {
    const sessionId = this.requireSession()
    const snapshot = this.manager.events.snapshot(sessionId as never)
    const beforeSeq = snapshot.entries.at(0)?.event.seq
    if (beforeSeq === undefined) return
    const value = await this.manager.request('session.history', {
      sessionId: sessionId as never,
      beforeSeq,
      maxMessages: this.limits.historyPageMessages,
    })
    this.manager.events.prependHistory(sessionId as never, value.events)
    this.hasMore = value.hasMore
    this.publish()
  }

  /** Submit one prompt with the exact visible context sections. */
  async prompt(text: string): Promise<void> {
    const normalized = text.trim()
    if (normalized === '') throw new Error('Enter a task before sending')
    const sessionId = this.requireSession()
    const persistedText = this.context.renderPrompt(normalized)
    await this.manager.request('session.prompt', {
      sessionId: sessionId as never,
      mode: 'queue',
      content: [{ type: 'text', text: persistedText }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    this.context.clear()
    this.publish()
  }

  /** Cancel only the active session's current turn. */
  async cancel(): Promise<void> {
    await this.manager.request('session.cancel', { sessionId: this.requireSession() as never })
  }

  /** Change the active session permission and the future-session default. */
  async selectPermission(mode: 'read-only' | 'confirm-changes' | 'workspace-write'): Promise<void> {
    const sessionId = this.requireSession()
    await this.manager.request('session.prompt', {
      sessionId: sessionId as never,
      mode: 'queue',
      content: [{ type: 'text', text: `/permission ${mode}` }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    const settings = await this.manager.describeSettings()
    const namespace = settings.namespaces.find(item => item.ns === 'permission')
    if (namespace === undefined) throw new Error('DSH permission settings are unavailable')
    await this.manager.mutateSettings({
      ns: 'permission',
      expectedRevision: namespace.revision,
      ops: [{ op: 'set', path: ['defaultPreset'], value: mode }],
    })
    await this.manager.refreshConfiguration()
  }

  /** Change the exact provider/model used by the active session. */
  async selectModel(value: string): Promise<void> {
    const [provider, model, extra] = value.split('\u0000')
    if (provider === undefined || model === undefined || extra !== undefined || provider === '' || model === '') {
      throw new Error('The selected model is invalid')
    }
    await this.manager.request('session.selectModel', {
      sessionId: this.requireSession() as never,
      provider,
      model,
    })
    await this.refreshModels()
    this.publish()
  }

  /** Refresh slash-completion entries after Host or filesystem change. */
  async refreshSkills(): Promise<void> {
    if (this.runtimeState.kind !== 'connected' || this.activeSessionId === undefined) return
    this.skills = (await this.manager.request('skill.list', { sessionId: this.activeSessionId as never })).skills
    this.publish()
  }

  /** Remove one draft context tag. */
  removeContext(id: string): void {
    this.context.remove(id)
    this.publish()
  }

  /** Notify the view after an external context command adds a tag. */
  contextChanged(): void {
    this.publish()
  }

  /** Open a prepared native Diff preview. */
  openApprovalPreview(id: string): Promise<void> {
    return this.approvals.openPreview(id)
  }

  /** Settle one approval as rejected. */
  async rejectApproval(id: string): Promise<void> {
    await this.approvals.reject(id)
  }

  /** Settle one approval as an exact one-shot grant. */
  async allowApproval(id: string): Promise<void> {
    await this.approvals.allowOnce(id)
  }

  /** Dispose event and Diff resources. */
  dispose(): void {
    this.disposeEvents()
    this.approvals.dispose()
    this.listeners.clear()
  }

  private async loadTail(sessionId: string): Promise<void> {
    const active = this.historyRepairs.get(sessionId)
    if (active !== undefined) return active
    const repair = Promise.resolve().then(async () => { await this.reconcileTail(sessionId) })
    this.historyRepairs.set(sessionId, repair)
    void repair.then(
      () => { this.historyRepairs.delete(sessionId) },
      () => { this.historyRepairs.delete(sessionId) },
    )
    return repair
  }

  private async reconcileTail(sessionId: string): Promise<void> {
    this.manager.events.beginHistory(sessionId as never)
    while (true) {
      const value = await this.manager.request('session.history', {
        sessionId: sessionId as never,
        maxMessages: this.limits.historyPageMessages,
      })
      this.manager.events.seedProjections(sessionId as never, value.projections)
      this.hasMore = value.hasMore
      if (!this.manager.events.installHistory(sessionId as never, value.events)) return
    }
  }

  private async refreshModels(): Promise<void> {
    if (this.activeSessionId === undefined) return
    const value = await this.manager.request('session.models', { sessionId: this.activeSessionId as never })
    this.models = {
      current: `${value.current.provider}\u0000${value.current.model}`,
      routable: value.routable,
      options: value.groups.flatMap(group => group.models.map(model => ({
        value: `${group.id}\u0000${model.id}`,
        label: `${group.name} / ${model.name}`,
      }))),
    }
  }

  private async publishFromFold(): Promise<void> {
    const generation = ++this.projectionGeneration
    this.applyHostFrames()
    if (this.activeSessionId !== undefined) {
      const sessionId = this.activeSessionId
      let snapshot = this.manager.events.snapshot(sessionId as never)
      if (snapshot.reconciling && this.runtimeState.kind === 'connected') {
        await this.loadTail(sessionId)
        if (generation !== this.projectionGeneration) return
        snapshot = this.manager.events.snapshot(sessionId as never)
      }
      const cwd = this.activeSummary()?.cwd
      if (cwd !== undefined) {
        const cards = await this.approvals.prepare(cwd, snapshot.entries, snapshot.interactions, this.limits.maxDiffBytes)
        if (generation !== this.projectionGeneration) return
        this.approvalCards = cards
      }
    }
    this.publish()
  }

  private applyHostFrames(): void {
    for (const frame of this.manager.events.hostSnapshot()) {
      if (frame.type === 'host/session-added') {
        if (!this.sessions.some(item => item.sessionId === frame.sessionId)) {
          this.sessions.push({
            sessionId: frame.sessionId,
            updatedAt: 0,
            running: false,
            blank: frame.blank,
            ...(frame.parentSessionId === undefined ? {} : { parentSessionId: frame.parentSessionId }),
            ...(frame.origin === undefined ? {} : { origin: frame.origin }),
            ...(frame.cwd === undefined ? {} : { cwd: frame.cwd }),
            ...(frame.agentPreset === undefined ? {} : { agentPreset: frame.agentPreset }),
          })
        }
      } else if (frame.type === 'host/session-status') {
        this.sessions = this.sessions.map(item => item.sessionId === frame.sessionId
          ? { ...item, running: frame.running, blank: frame.running ? false : item.blank }
          : item)
      } else if (frame.type === 'host/session-removed') {
        this.sessions = this.sessions.filter(item => item.sessionId !== frame.sessionId)
      }
    }
  }

  private sessionRows(): ConversationSessionRow[] {
    return this.sessions
      .filter(row => row.origin !== 'subagent' && (!row.blank || row.sessionId === this.activeSessionId))
      .map((summary) => {
        const snapshot = this.manager.events.snapshot(summary.sessionId)
        const title = snapshot.projections['title']
        return sessionRow(typeof title === 'string'
          ? { ...summary, projections: { asOfSeq: Number.MAX_SAFE_INTEGER, values: { title } } }
          : summary)
      })
  }

  private activeSummary(): SessionSummary | undefined {
    return this.sessions.find(item => item.sessionId === this.activeSessionId)
  }

  private requireSession(): string {
    this.requireConnected()
    if (this.activeSessionId === undefined) throw new Error('Create or select a DSH session first')
    return this.activeSessionId
  }

  private requireConnected(): void {
    if (this.runtimeState.kind !== 'connected') throw new Error('Start the DSH runtime before using the conversation')
  }

  private publish(): void {
    const model = this.model
    for (const listener of this.listeners) listener(model)
  }
}

function permissionOf(value: unknown): ConversationViewModel['permission'] | undefined {
  if (!isRecord(value) || typeof value['currentValue'] !== 'string' || !Array.isArray(value['options'])) return undefined
  const options = value['options'].flatMap((option) => {
    if (!isRecord(option) || typeof option['value'] !== 'string' || typeof option['name'] !== 'string') return []
    return [{ value: option['value'], name: option['name'] }]
  })
  return { current: value['currentValue'], options }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
