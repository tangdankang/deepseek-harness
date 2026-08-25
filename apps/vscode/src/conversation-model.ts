/** Pure projection of Host session history into the VS Code conversation view. */

import type { HistoryEntry, SessionSummary, ToolCallView, ToolResultView } from '@deepseek-ai/dsh-host-apiproxy/api'

/** One session row displayed in the conversation header. */
export interface ConversationSessionRow {
  /** Durable Host session id. */
  id: string
  /** Projected title or deterministic path/id fallback. */
  title: string
  /** Session working directory, when persisted. */
  cwd?: string
  /** Whether the Host currently runs this session. */
  running: boolean
}

/** One transcript item understood by the native Webview renderer. */
export type TranscriptItem =
  | { kind: 'message'; seq: number; role: 'user' | 'assistant'; text: string; html?: string; streaming?: boolean; reasoning?: boolean }
  | {
    kind: 'tool'
    seq: number
    callId: string
    name: string
    title: string
    card: 'generic' | 'terminal' | 'diff'
    status: 'running' | 'completed' | 'failed'
    detail?: string
    exit?: string
  }
  | { kind: 'notice'; seq: number; tone: 'info' | 'error'; text: string }

/** Build one session-list row from a Host summary and its title projection. */
export function sessionRow(summary: SessionSummary): ConversationSessionRow {
  const projected = summary.projections?.values['title']
  const title = typeof projected === 'string' && projected.trim() !== ''
    ? projected
    : summary.cwd?.split(/[\\/]/u).filter(Boolean).at(-1) ?? `Session ${String(summary.sessionId).slice(0, 8)}`
  return {
    id: summary.sessionId,
    title,
    ...(summary.cwd === undefined ? {} : { cwd: summary.cwd }),
    running: summary.running,
  }
}

/**
 * Project durable events and the unfinished assistant tail without exposing
 * reasoning text. Tool render intent remains authoritative for card selection.
 * @param entries - ordered reconciled history entries.
 * @param maxToolOutputChars - maximum generic/terminal detail retained by the view.
 * @returns ordered transcript items.
 */
export function transcriptOf(entries: readonly HistoryEntry[], maxToolOutputChars: number): TranscriptItem[] {
  const citedChunks = new Set<number>()
  for (const { event } of entries) {
    if (event.type === 'assistant/message') {
      for (const seq of event.sourceEventSeqs ?? []) citedChunks.add(seq)
    }
  }

  const tools = new Map<string, Extract<TranscriptItem, { kind: 'tool' }>>()
  const streaming = new Map<string, Extract<TranscriptItem, { kind: 'message' }>>()
  const items: TranscriptItem[] = []
  for (const entry of entries) {
    const { event } = entry
    switch (event.type) {
      case 'user/message': {
        if (event.data.source.kind !== 'user') break
        const text = visibleText(event.data.content)
        if (text !== '') items.push({ kind: 'message', seq: event.seq, role: 'user', text })
        break
      }
      case 'assistant/chunk': {
        if (citedChunks.has(event.seq)) break
        const key = `${event.data.turn}:${event.data.step}`
        let node = streaming.get(key)
        if (node === undefined) {
          node = { kind: 'message', seq: event.seq, role: 'assistant', text: '', streaming: true }
          streaming.set(key, node)
          items.push(node)
        }
        if (event.data.chunk.type === 'text-delta') node.text += event.data.chunk.text
        if (event.data.chunk.type === 'reasoning-delta') node.reasoning = true
        break
      }
      case 'assistant/message': {
        const text = visibleText(event.data.message.content)
        if (text !== '') items.push({ kind: 'message', seq: event.seq, role: 'assistant', text })
        break
      }
      case 'tool/call': {
        const callView = entry.view?.for === 'call' ? entry.view.view : undefined
        const node = toolCallItem(event.seq, event.data.callId, event.data.name, event.data.arguments, callView)
        tools.set(event.data.callId, node)
        items.push(node)
        break
      }
      case 'tool/result': {
        const result = event.data.message.content[0]
        const node = tools.get(result.toolCallId)
        if (node === undefined) break
        node.status = result.isError || event.data.error !== undefined ? 'failed' : 'completed'
        const resultView = entry.view?.for === 'result' ? entry.view.view : undefined
        applyResultView(node, resultView, visibleText(result.content), maxToolOutputChars)
        break
      }
      case 'turn/end':
        if (event.data.reason.kind === 'error') {
          items.push({ kind: 'notice', seq: event.seq, tone: 'error', text: event.data.reason.error.message })
        } else if (event.data.reason.kind === 'aborted') {
          items.push({ kind: 'notice', seq: event.seq, tone: 'info', text: 'Generation cancelled.' })
        } else if (event.data.reason.kind === 'max-tokens') {
          items.push({ kind: 'notice', seq: event.seq, tone: 'error', text: 'The model reached its output limit.' })
        }
        break
      default:
        break
    }
  }
  return items.sort((left, right) => left.seq - right.seq)
}

function toolCallItem(
  seq: number,
  callId: string,
  name: string,
  rawArguments: string,
  view: ToolCallView | undefined,
): Extract<TranscriptItem, { kind: 'tool' }> {
  if (view?.card === 'terminal') {
    return {
      kind: 'tool', seq, callId, name, title: view.title, card: 'terminal', status: 'running',
      ...(view.cwd === undefined ? {} : { detail: view.cwd }),
    }
  }
  if (view?.card === 'diff') {
    return { kind: 'tool', seq, callId, name, title: view.title, card: 'diff', status: 'running' }
  }
  return {
    kind: 'tool', seq, callId, name, title: view?.title ?? name, card: 'generic', status: 'running',
    detail: displayValue(view?.rawInput ?? parseJson(rawArguments)),
  }
}

function applyResultView(
  node: Extract<TranscriptItem, { kind: 'tool' }>,
  view: ToolResultView | undefined,
  fallback: string,
  maxChars: number,
): void {
  if (view?.title !== undefined) node.title = view.title
  if (view?.card === 'terminal') {
    node.card = 'terminal'
    node.detail = bound(view.output ?? fallback, maxChars)
    const exit = view.exitCode === undefined ? view.signal : `exit ${String(view.exitCode)}`
    if (exit !== undefined) node.exit = exit
    return
  }
  if (view?.card === 'diff') {
    node.card = 'diff'
    node.detail = `${String(view.diffs.length)} applied change${view.diffs.length === 1 ? '' : 's'}`
    return
  }
  node.detail = bound(fallback, maxChars)
}

function visibleText(content: readonly unknown[]): string {
  return content.flatMap((block) => {
    if (!isRecord(block) || block['type'] !== 'text' || typeof block['text'] !== 'string') return []
    return [block['text']]
  }).join('\n')
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function bound(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
