import { createInterface } from 'node:readline'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const badHandshake = process.argv.includes('--bad-handshake')
const exitAfterHandshake = process.argv.includes('--exit-after-handshake')
const slowShutdown = process.argv.includes('--slow-shutdown')
const slowReadiness = process.argv.includes('--slow-readiness')
const slowSettings = process.argv.includes('--slow-settings')
const endStreamAfterHandshake = process.argv.includes('--end-stream-after-handshake')
process.stderr.write(`fixture token=${'sk-' + 'fixturecredential123'}\n`)
let settingsRevision = 0
let subscriptionSequence = 0
const subscriptions = new Map()
const sessionId = 'fixture-session'
const history = []
let sessionBlank = true
let approvalRound = 0

function emit(stream, message) {
  for (const [subscriptionId, current] of subscriptions) {
    if (current !== stream) continue
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0', method: 'dsh/event', params: { subscriptionId, stream, message },
    })}\n`)
  }
}

function emitMux(payload, rpcId = `fixture-mux-${Date.now()}-${Math.random()}`) {
  emit('mux', { type: 'server-request', rpcId, method: payload.type, payload })
}

function appendEvent(type, data, view, extra = {}, publish = true) {
  const event = { type, seq: history.length, time: 1_700_000_000_000 + history.length, data, ...extra }
  if (type === 'user/message' || type === 'assistant/message' || type === 'tool/result') event.surfaceOp = 'append'
  const entry = { event, ...(view === undefined ? {} : { view }) }
  history.push(entry)
  if (publish) emitMux({ type: 'session/event', sessionId, event, ...(view === undefined ? {} : { view }) })
  return event
}

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const message = JSON.parse(line)
  const respond = (result, delay = 0) => {
    setTimeout(() => {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
    }, delay)
  }
  if (message.method === 'dsh/initialize') {
    respond(badHandshake
      ? { protocolVersion: 999, serverInfo: { name: 'incompatible' } }
      : { protocolVersion: 2, serverInfo: { name: 'deepseek-harness-host' } }, slowReadiness ? 1000 : 0)
    return
  }
  if (message.method === 'dsh/subscribe') {
    const subscriptionId = `fixture-${message.params.stream}-${++subscriptionSequence}`
    subscriptions.set(subscriptionId, message.params.stream)
    respond({ subscriptionId })
    if (message.params.stream === 'mux') {
      setTimeout(() => {
        process.stdout.write(`${JSON.stringify({
          jsonrpc: '2.0', method: 'dsh/event', params: {
            subscriptionId, stream: 'mux', message: {
              type: 'server-request', rpcId: `baseline-${subscriptionId}`, method: 'session/subscribed',
              payload: { type: 'session/subscribed', sessionId, lastSeq: history.length - 1 },
            },
          },
        })}\n`)
      }, 5)
      if (endStreamAfterHandshake) {
        setTimeout(() => {
          process.stdout.write(`${JSON.stringify({
            jsonrpc: '2.0', method: 'dsh/streamEnd', params: {
              subscriptionId, stream: 'mux', reason: 'completed',
            },
          })}\n`)
          subscriptions.delete(subscriptionId)
        }, 25)
      }
    }
    return
  }
  if (message.method === 'dsh/unsubscribe') {
    const stream = subscriptions.get(message.params.subscriptionId)
    subscriptions.delete(message.params.subscriptionId)
    respond({ removed: stream !== undefined })
    if (stream !== undefined) {
      setTimeout(() => {
        process.stdout.write(`${JSON.stringify({
          jsonrpc: '2.0', method: 'dsh/streamEnd', params: {
            subscriptionId: message.params.subscriptionId, stream, reason: 'cancelled',
          },
        })}\n`)
      }, 0)
    }
    return
  }
  if (message.method === 'dsh/request') {
    const method = message.params.method
    let value
    if (method === 'host.describe') {
      value = {
        version: 'fixture-version',
        cwd: process.cwd(),
        attachedSessions: 0,
        canOpenPath: false,
      }
    } else if (method === 'settings.describe') {
      value = {
        writable: true,
        hasDocument: true,
        namespaces: [{
          ns: 'permission', schema: {}, value: { defaultPreset: 'confirm-changes' },
          applies: 'live', secrets: [], revision: settingsRevision,
        }],
      }
    } else if (method === 'settings.mutate') {
      settingsRevision += 1
      value = {
        ns: message.params.payload.ns,
        schema: {},
        value: { defaultPreset: message.params.payload.ops[0]?.value },
        applies: 'live',
        secrets: [],
        revision: settingsRevision,
      }
    } else if (method === 'session.history') {
      value = {
        events: message.params.payload.beforeSeq === undefined
          ? history
          : history.filter(entry => entry.event.seq < message.params.payload.beforeSeq),
        hasMore: false,
        ...(message.params.payload.beforeSeq === undefined ? {
          projections: {
            asOfSeq: history.length - 1,
            values: {
              title: 'Fixture coding session',
              permissions: {
                currentValue: 'confirm-changes',
                options: [
                  { value: 'read-only', name: 'Read-only' },
                  { value: 'confirm-changes', name: 'Confirm changes' },
                  { value: 'workspace-write', name: 'Workspace writes' },
                ],
              },
            },
          },
        } : {}),
      }
    } else if (method === 'session.list') {
      value = {
        items: [{
          sessionId, updatedAt: 1_700_000_000_000, running: false, blank: sessionBlank, cwd: process.cwd(),
          projections: { asOfSeq: history.length - 1, values: { title: 'Fixture coding session' } },
        }],
      }
    } else if (method === 'session.create') {
      value = { sessionId }
    } else if (method === 'session.models') {
      value = {
        current: { provider: 'fixture', model: 'fixture-model' }, routable: true, failures: [],
        groups: [{ id: 'fixture', name: 'Fixture', models: [{ id: 'fixture-model', name: 'Fixture Model' }] }],
      }
    } else if (method === 'session.selectModel') {
      value = { selected: { provider: message.params.payload.provider, model: message.params.payload.model } }
    } else if (method === 'skill.list') {
      value = { skills: [{ name: 'fixture-skill', description: 'Apply the deterministic fixture rule.', modelInvocable: true }] }
    } else if (method === 'session.cancel') {
      value = { accepted: true }
    } else if (method === 'session.prompt') {
      const text = message.params.payload.content[0]?.text ?? ''
      if (text.startsWith('/permission ')) {
        const currentValue = text.slice('/permission '.length).trim()
        value = { accepted: true, command: { kind: 'success', text: `preset ${currentValue}` } }
        emitMux({
          type: 'session/projection', sessionId, key: 'permissions', seq: history.length,
          value: {
            currentValue,
            options: [
              { value: 'read-only', name: 'Read-only' },
              { value: 'confirm-changes', name: 'Confirm changes' },
              { value: 'workspace-write', name: 'Workspace writes' },
            ],
          },
        })
      } else {
        sessionBlank = false
        approvalRound += 1
        appendEvent('turn/start', { turn: approvalRound })
        appendEvent('user/message', {
          id: `fixture-user-${approvalRound}`, role: 'user', source: { kind: 'user', rpcId: message.params.rpcId },
          content: [{ type: 'text', text }],
        })
        appendEvent('step/start', { turn: approvalRound, step: 1 })
        const reasoning = appendEvent('assistant/chunk', { turn: approvalRound, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'fixture-private-reasoning' } })
        const textChunk = appendEvent('assistant/chunk', { turn: approvalRound, step: 1, chunk: { type: 'text-delta', index: 1, text: 'I found the requested change.' } })
        appendEvent('assistant/message', {
          turn: approvalRound, step: 1,
          message: {
            id: `fixture-assistant-call-${approvalRound}`, role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture-model' },
            content: [{ type: 'text', text: 'I found the requested change.' }],
          },
        }, undefined, { sourceEventSeqs: [reasoning.seq, textChunk.seq] })
        const callId = `fixture-call-${approvalRound}`
        const callView = { for: 'call', view: { card: 'diff', title: 'Edit value.txt', diffs: [{ path: 'value.txt', oldText: 'alpha', newText: 'beta' }] } }
        const callEvent = appendEvent('tool/call', {
          turn: approvalRound, step: 1, callId, name: 'edit',
          arguments: JSON.stringify({ file_path: 'value.txt', old_string: 'alpha', new_string: 'beta' }),
        }, callView, {}, false)
        emitMux({
          type: 'approval/requested', sessionId, approvalId: `fixture-approval-${approvalRound}`,
          toolName: 'edit', callId, reason: 'The session is in confirm-changes mode.',
        }, `fixture-approval-rpc-${approvalRound}`)
        emitMux({ type: 'session/event', sessionId, event: callEvent, view: callView })
        appendEvent('approval/asked', {
          id: `fixture-approval-${approvalRound}`, toolName: 'edit', callId,
          reason: 'The session is in confirm-changes mode.',
        })
        value = { accepted: true }
      }
    } else {
      respond({
        type: 'server-response',
        rpcId: message.params.rpcId,
        result: { ok: false, error: { code: 'bad-request', message: `unsupported fixture method ${method}`, details: { issues: [] } } },
      })
      return
    }
    const readinessDelay = slowSettings && method === 'settings.describe'
      ? 3000
      : slowReadiness && (method === 'host.describe' || method === 'settings.describe') ? 1000 : 0
    respond({
      type: 'server-response',
      rpcId: message.params.rpcId,
      result: {
        ok: true,
        value,
      },
    }, readinessDelay)
    if (exitAfterHandshake) setTimeout(() => process.exit(7), 50)
    return
  }
  if (message.method === 'dsh/respond') {
    const decision = message.params.result.value
    const round = Number(String(decision.approvalId).split('-').at(-1))
    const callId = `fixture-call-${round}`
    if (decision.outcome === 'allowed-once') {
      const target = resolve(process.cwd(), 'value.txt')
      writeFileSync(target, readFileSync(target, 'utf8').replace('alpha', 'beta'))
    }
    emitMux({
      type: 'approval/resolved', sessionId, approvalId: decision.approvalId, outcome: decision.outcome,
    })
    appendEvent('approval/decided', { id: decision.approvalId, outcome: decision.outcome })
    appendEvent('tool/result', {
      turn: round, step: 1,
      message: {
        id: `fixture-result-${round}`, role: 'user', source: { kind: 'tool', callId, name: 'edit' },
        content: [{
          type: 'tool-result', toolCallId: callId,
          content: [{ type: 'text', text: decision.outcome === 'allowed-once' ? 'Updated value.txt' : 'Edit rejected by user' }],
          ...(decision.outcome === 'allowed-once' ? {} : { isError: true }),
        }],
      },
    }, decision.outcome === 'allowed-once'
      ? { for: 'result', view: { card: 'diff', title: 'Edit value.txt', diffs: [{ path: 'value.txt', oldText: 'alpha', newText: 'beta' }] } }
      : undefined)
    appendEvent('step/end', { turn: round, step: 1 })
    appendEvent('step/start', { turn: round, step: 2 })
    appendEvent('assistant/message', {
      turn: round, step: 2,
      message: {
        id: `fixture-assistant-${round}`, role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture-model' },
        content: [{ type: 'text', text: decision.outcome === 'allowed-once' ? 'The reviewed change was applied.' : 'The reviewed change was not applied.' }],
      },
    })
    appendEvent('step/end', { turn: round, step: 2 })
    appendEvent('turn/end', { turn: round, reason: { kind: 'completed' } })
    respond({ accepted: true })
    return
  }
  if (message.method === 'dsh/shutdown') {
    respond({ accepted: true })
    for (const [subscriptionId, stream] of subscriptions) {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', method: 'dsh/streamEnd', params: { subscriptionId, stream, reason: 'cancelled' },
      })}\n`)
    }
    subscriptions.clear()
    setTimeout(() => process.exit(0), slowShutdown ? 100 : 0)
  }
})
