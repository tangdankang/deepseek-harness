/** VS Code stdio Host client framing, correlation, cancellation, and streams. */

import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { HostProtocolClient } from '../src/host-client.ts'
import { HOST_STDIO_METHODS, HOST_STDIO_PROTOCOL_VERSION } from '@deepseek-ai/dsh-host-apiproxy-stdio/protocol'

interface JsonRpcMessage {
  id?: string
  method?: string
  params?: Record<string, unknown>
}

function harness(): {
  client: HostProtocolClient
  input: PassThrough
  messages: JsonRpcMessage[]
  reply(request: JsonRpcMessage, result: unknown, split?: boolean): void
  notify(method: string, params: object): string
} {
  const input = new PassThrough()
  const output = new PassThrough()
  const messages: JsonRpcMessage[] = []
  let buffer = ''
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const boundary = buffer.indexOf('\n')
      if (boundary < 0) break
      const line = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 1)
      messages.push(JSON.parse(line) as JsonRpcMessage)
    }
  })
  const write = (frame: string, split = false): void => {
    if (!split) {
      input.write(frame)
      return
    }
    const cut = Math.max(1, Math.floor(frame.length / 2))
    input.write(frame.slice(0, cut))
    input.write(frame.slice(cut))
  }
  const client = new HostProtocolClient(input, output)
  client.start()
  return {
    client,
    input,
    messages,
    reply(request, result, split = false) {
      write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`, split)
    },
    notify(method, params) {
      return `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`
    },
  }
}

async function messageAt(messages: JsonRpcMessage[], index: number): Promise<JsonRpcMessage> {
  await vi.waitFor(() => { expect(messages.length).toBeGreaterThan(index) })
  const message = messages[index]
  if (message === undefined) throw new Error(`missing JSON-RPC message ${index}`)
  return message
}

describe('HostProtocolClient', () => {
  it('accepts a protocol response split across input chunks', async () => {
    const wire = harness()
    const initialized = wire.client.initialize('0.1.0', AbortSignal.timeout(2_000))
    const request = await messageAt(wire.messages, 0)
    wire.reply(request, {
      protocolVersion: HOST_STDIO_PROTOCOL_VERSION,
      serverInfo: { name: 'deepseek-harness-host' },
    }, true)

    await expect(initialized).resolves.toMatchObject({ protocolVersion: HOST_STDIO_PROTOCOL_VERSION })
    wire.client.close()
  })

  it('validates typed unary values and rejects a mismatched Host rpcId', async () => {
    const wire = harness()
    const described = wire.client.describe(AbortSignal.timeout(2_000))
    const first = await messageAt(wire.messages, 0)
    const requestId = first.params?.rpcId
    wire.reply(first, {
      type: 'server-response', rpcId: requestId, result: {
        ok: true,
        value: { version: 'fixture', cwd: 'C:\\workspace', attachedSessions: 1, canOpenPath: false },
      },
    })
    await expect(described).resolves.toMatchObject({ version: 'fixture', attachedSessions: 1 })

    const mismatched = wire.client.describe(AbortSignal.timeout(2_000))
    const second = await messageAt(wire.messages, 1)
    wire.reply(second, {
      type: 'server-response', rpcId: 'different', result: {
        ok: true,
        value: { version: 'fixture', cwd: 'C:\\workspace', attachedSessions: 1, canOpenPath: false },
      },
    })
    await expect(mismatched).rejects.toThrow('rpcId mismatch')
    wire.client.close()
  })

  it('buffers stream frames adjacent to the subscribe response and observes stream end', async () => {
    const wire = harness()
    const opening = wire.client.subscribeMux({}, AbortSignal.timeout(2_000))
    const request = await messageAt(wire.messages, 0)
    const subscriptionId = 'mux-1'
    const response = `${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { subscriptionId } })}\n`
    const event = wire.notify(HOST_STDIO_METHODS.event, {
      subscriptionId,
      stream: 'mux',
      message: {
        type: 'server-request', rpcId: 'baseline-1', method: 'session/subscribed',
        payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 4 },
      },
    })
    const end = wire.notify(HOST_STDIO_METHODS.streamEnd, {
      subscriptionId, stream: 'mux', reason: 'completed',
    })
    wire.input.write(response + event + end)

    const subscription = await opening
    const frames = []
    for await (const frame of subscription) frames.push(frame)
    expect(frames).toEqual([{
      rpcId: 'baseline-1',
      payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 4 },
    }])
    await expect(subscription.done).resolves.toBeUndefined()
    wire.client.close()
  })

  it('echoes approval correlation and validates the carrier receipt', async () => {
    const wire = harness()
    const responding = wire.client.respondApproval('approval-rpc' as never, {
      sessionId: 'session-1' as never,
      approvalId: 'approval-1' as never,
      outcome: 'allowed-once',
    }, AbortSignal.timeout(2_000))
    const request = await messageAt(wire.messages, 0)
    expect(request).toMatchObject({
      method: HOST_STDIO_METHODS.respond,
      params: { type: 'client-response', rpcId: 'approval-rpc', result: { ok: true } },
    })
    wire.reply(request, { accepted: true })
    await expect(responding).resolves.toEqual({ accepted: true })
    wire.client.close()
  })

  it('notifies cancellation and rejects pending operations when input closes', async () => {
    const wire = harness()
    const controller = new AbortController()
    const pending = wire.client.request('host.pickDirectory', {}, controller.signal)
    await messageAt(wire.messages, 0)
    controller.abort(new Error('cancelled by test'))
    await expect(pending).rejects.toThrow('cancelled by test')
    const cancellation = await messageAt(wire.messages, 1)
    expect(cancellation).toMatchObject({ method: HOST_STDIO_METHODS.cancel })

    const stranded = wire.client.describe(AbortSignal.timeout(2_000))
    await messageAt(wire.messages, 2)
    wire.input.end()
    await expect(stranded).rejects.toThrow('JSON-RPC transport closed')
    wire.client.close()
  })

  it('releases a live subscription with dsh/unsubscribe', async () => {
    const wire = harness()
    const opening = wire.client.subscribeHost(AbortSignal.timeout(2_000))
    const subscribe = await messageAt(wire.messages, 0)
    wire.reply(subscribe, { subscriptionId: 'host-1' })
    const subscription = await opening

    const closing = subscription.unsubscribe(AbortSignal.timeout(2_000))
    const unsubscribe = await messageAt(wire.messages, 1)
    expect(unsubscribe).toMatchObject({
      method: HOST_STDIO_METHODS.unsubscribe,
      params: { subscriptionId: 'host-1' },
    })
    wire.reply(unsubscribe, { removed: true })
    await expect(closing).resolves.toBeUndefined()
    await expect(subscription.done).resolves.toBeUndefined()
    wire.client.close()
  })
})
