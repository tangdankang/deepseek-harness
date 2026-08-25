/** Host API stdio protocol mapping and stream lifecycle. */

import {
  RpcId,
  type ApiProxy,
  type ClientResponse,
  type MuxFrame,
  type RpcRequest,
} from '@deepseek-ai/dsh-host-apiproxy'
import { describe, expect, it, vi } from 'vitest'
import {
  HOST_STDIO_METHODS,
  HOST_STDIO_PROTOCOL_VERSION,
  HostApiStdioServer,
  type HostStdioEventNotification,
} from '../src/index.ts'

interface Notification {
  method: string
  params?: object
}

/** Make the narrow ApiProxy behavior this carrier suite observes. */
function makeApi(frames: AsyncIterable<RpcRequest<MuxFrame>>): {
  api: ApiProxy
  respond: ReturnType<typeof vi.fn<(message: ClientResponse) => Promise<{ accepted: true }>>>
} {
  const respond = vi.fn<(message: ClientResponse) => Promise<{ accepted: true }>>()
    .mockResolvedValue({ accepted: true })
  const api = {
    host: {
      describe: ({ rpcId }: { rpcId: ReturnType<typeof RpcId> }) => Promise.resolve({
        rpcId,
        result: {
          ok: true as const,
          value: {
            version: 'test-version', cwd: 'C:\\workspace', attachedSessions: 0, canOpenPath: true,
          },
        },
      }),
    },
    events: {
      mux: () => frames,
      host: async function* () {},
    },
    respond,
  } as unknown as ApiProxy
  return { api, respond }
}

/** One finite stream for deterministic notification assertions. */
async function* oneFrame(): AsyncIterable<RpcRequest<MuxFrame>> {
  yield {
    rpcId: RpcId('event-1'),
    payload: { type: 'session/subscribed', sessionId: 'session-1' as never, lastSeq: -1 },
  }
}

describe('HostApiStdioServer', () => {
  it('requires initialization, then dispatches full Host API messages', async () => {
    const notifications: Notification[] = []
    const { api } = makeApi(oneFrame())
    const server = new HostApiStdioServer(api, {
      request: () => Promise.resolve(undefined),
      notify: (method, params) => { notifications.push(params === undefined ? { method } : { method, params }) },
    })

    await expect(server.handleRequest(HOST_STDIO_METHODS.request, {}))
      .rejects.toThrow('requires dsh/initialize first')
    await expect(server.handleRequest(HOST_STDIO_METHODS.initialize, {
      clientInfo: { name: 'dsh-vscode', version: '0.1.0' },
    })).resolves.toEqual({
      protocolVersion: HOST_STDIO_PROTOCOL_VERSION,
      serverInfo: { name: 'deepseek-harness-host' },
    })

    await expect(server.handleRequest(HOST_STDIO_METHODS.request, {
      type: 'client-request', rpcId: 'request-1', method: 'host.describe', payload: {},
    })).resolves.toEqual({
      type: 'server-response',
      rpcId: 'request-1',
      result: {
        ok: true,
        value: { version: 'test-version', cwd: 'C:\\workspace', attachedSessions: 0, canOpenPath: true },
      },
    })
    expect(notifications).toEqual([])
    await server.shutdown()
  })

  it('preserves server-request ids on stream notifications and forwards responses', async () => {
    const notifications: Notification[] = []
    const { api, respond } = makeApi(oneFrame())
    const server = new HostApiStdioServer(api, {
      request: () => Promise.resolve(undefined),
      notify: (method, params) => { notifications.push(params === undefined ? { method } : { method, params }) },
    })
    await server.handleRequest(HOST_STDIO_METHODS.initialize, {
      clientInfo: { name: 'dsh-vscode', version: '0.1.0' },
    })

    const subscribed = await server.handleRequest(HOST_STDIO_METHODS.subscribe, { stream: 'mux' }) as {
      subscriptionId: string
    }
    await vi.waitFor(() => { expect(notifications).toHaveLength(2) })
    const notification = notifications[0]?.params as HostStdioEventNotification
    expect(notifications[0]?.method).toBe(HOST_STDIO_METHODS.event)
    expect(notification.subscriptionId).toBe(subscribed.subscriptionId)
    expect(notification.message).toEqual({
      type: 'server-request',
      rpcId: 'event-1',
      method: 'session/subscribed',
      payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: -1 },
    })
    expect(notifications[1]).toEqual({
      method: HOST_STDIO_METHODS.streamEnd,
      params: { subscriptionId: subscribed.subscriptionId, stream: 'mux', reason: 'completed' },
    })

    const response = {
      type: 'client-response' as const,
      rpcId: RpcId('event-1'),
      result: { ok: true as const, value: { outcome: 'approved' } },
    }
    await expect(server.handleRequest(HOST_STDIO_METHODS.respond, response))
      .resolves.toEqual({ accepted: true })
    expect(respond).toHaveBeenCalledWith(response)
    await expect(server.handleRequest(HOST_STDIO_METHODS.unsubscribe, {
      subscriptionId: subscribed.subscriptionId,
    })).resolves.toEqual({ removed: false })
    await server.shutdown()
  })

  it('rejects malformed stream payloads at the carrier boundary', async () => {
    const { api } = makeApi(oneFrame())
    const server = new HostApiStdioServer(api, {
      request: () => Promise.resolve(undefined),
      notify: () => {},
    })
    await server.handleRequest(HOST_STDIO_METHODS.initialize, {
      clientInfo: { name: 'dsh-vscode', version: '0.1.0' },
    })

    await expect(server.handleRequest(HOST_STDIO_METHODS.subscribe, {
      stream: 'mux', payload: { since: { session: 1.5 } },
    })).rejects.toThrow()
    await server.shutdown()
  })

  it('validates initialization and rejects unknown or closing operations', async () => {
    const { api } = makeApi(oneFrame())
    const server = new HostApiStdioServer(api, { request: () => Promise.resolve(undefined), notify: () => {} })
    const initialization = { clientInfo: { name: 'dsh-vscode', version: '0.1.0' } }
    await server.handleRequest(HOST_STDIO_METHODS.initialize, initialization)
    await expect(server.handleRequest(HOST_STDIO_METHODS.initialize, initialization))
      .rejects.toThrow('already initialized')
    await expect(server.handleRequest('dsh/unknown', {})).rejects.toThrow('unknown Host API stdio method')
    expect(() => { server.handleNotification('dsh/unknown', {}) }).toThrow('unknown Host API stdio notification')
    expect(() => { server.handleNotification(HOST_STDIO_METHODS.cancel, { rpcId: 'already-settled' }) }).not.toThrow()
    await expect(server.handleRequest(HOST_STDIO_METHODS.shutdown, {})).resolves.toEqual({ accepted: true })
    await server.shutdown()
    await server.shutdown()
    await expect(server.handleRequest(HOST_STDIO_METHODS.shutdown, {})).rejects.toThrow('shutting down')
  })

  it('passes mux cursors, opens the host stream, and settles explicit unsubscribe', async () => {
    const notifications: Notification[] = []
    let muxPayload: unknown
    let hostOpened = false
    const waitForAbort = (signal: AbortSignal): Promise<void> => new Promise((resolve) => {
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
    const api = {
      events: {
        mux: async function* (request: { payload: unknown }, signal: AbortSignal) {
          muxPayload = request.payload
          await waitForAbort(signal)
        },
        host: async function* (_request: unknown, signal: AbortSignal) {
          hostOpened = true
          await waitForAbort(signal)
        },
      },
      respond: () => Promise.resolve({ accepted: true }),
    } as unknown as ApiProxy
    const server = new HostApiStdioServer(api, {
      request: () => Promise.resolve(undefined),
      notify: (method, params) => { notifications.push(params === undefined ? { method } : { method, params }) },
    })
    await server.handleRequest(HOST_STDIO_METHODS.initialize, {
      clientInfo: { name: 'dsh-vscode', version: '0.1.0' },
    })
    const mux = await server.handleRequest(HOST_STDIO_METHODS.subscribe, {
      stream: 'mux', payload: { since: { 'session-1': 4 } },
    }) as { subscriptionId: string }
    const host = await server.handleRequest(HOST_STDIO_METHODS.subscribe, { stream: 'host' }) as {
      subscriptionId: string
    }
    await vi.waitFor(() => {
      expect(muxPayload).toEqual({ since: { 'session-1': 4 } })
      expect(hostOpened).toBe(true)
    })
    await expect(server.handleRequest(HOST_STDIO_METHODS.unsubscribe, { subscriptionId: mux.subscriptionId }))
      .resolves.toEqual({ removed: true })
    await expect(server.handleRequest(HOST_STDIO_METHODS.unsubscribe, { subscriptionId: mux.subscriptionId }))
      .resolves.toEqual({ removed: false })
    await server.shutdown()
    expect(notifications).toContainEqual({
      method: HOST_STDIO_METHODS.streamEnd,
      params: { subscriptionId: mux.subscriptionId, stream: 'mux', reason: 'cancelled' },
    })
    expect(notifications).toContainEqual({
      method: HOST_STDIO_METHODS.streamEnd,
      params: { subscriptionId: host.subscriptionId, stream: 'host', reason: 'cancelled' },
    })
  })

  it('reports an iterator failure as a domain stream error before settlement', async () => {
    const notifications: Notification[] = []
    const api = {
      events: {
        mux: async function* () { throw new Error('stream exploded') },
        host: async function* () {},
      },
      respond: () => Promise.resolve({ accepted: true }),
    } as unknown as ApiProxy
    const server = new HostApiStdioServer(api, {
      request: () => Promise.resolve(undefined),
      notify: (method, params) => { notifications.push(params === undefined ? { method } : { method, params }) },
    })
    await server.handleRequest(HOST_STDIO_METHODS.initialize, {
      clientInfo: { name: 'dsh-vscode', version: '0.1.0' },
    })
    await server.handleRequest(HOST_STDIO_METHODS.subscribe, { stream: 'mux' })
    await vi.waitFor(() => { expect(notifications).toHaveLength(2) })
    expect(notifications[0]).toMatchObject({
      method: HOST_STDIO_METHODS.event,
      params: { message: { method: 'stream/error', payload: { error: { message: 'Error: stream exploded' } } } },
    })
    expect(notifications[1]).toMatchObject({
      method: HOST_STDIO_METHODS.streamEnd,
      params: { reason: 'completed' },
    })
    await server.shutdown()
  })

  it('contains output failures while reporting iterator settlement', async () => {
    const api = {
      events: {
        mux: async function* () { throw new Error('stream exploded') },
        host: async function* () {},
      },
      respond: () => Promise.resolve({ accepted: true }),
    } as unknown as ApiProxy
    const server = new HostApiStdioServer(api, {
      request: () => Promise.resolve(undefined),
      notify: () => { throw new Error('output closed') },
    })
    await server.handleRequest(HOST_STDIO_METHODS.initialize, {
      clientInfo: { name: 'dsh-vscode', version: '0.1.0' },
    })
    await server.handleRequest(HOST_STDIO_METHODS.subscribe, { stream: 'mux' })
    await expect(server.shutdown()).resolves.toBeUndefined()
  })

  it('aborts the matching in-flight Host request on a cancel notification', async () => {
    let observedSignal: AbortSignal | undefined
    const api = {
      host: {
        pickDirectory: ({ rpcId }: { rpcId: ReturnType<typeof RpcId> }, signal: AbortSignal) => {
          observedSignal = signal
          return new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              resolve({
                rpcId,
                result: { ok: false, error: { code: 'cancelled', message: 'cancelled', details: {} } },
              })
            }, { once: true })
          })
        },
      },
      events: { mux: async function* () {}, host: async function* () {} },
      respond: () => Promise.resolve({ accepted: true }),
    } as unknown as ApiProxy
    const server = new HostApiStdioServer(api, { request: () => Promise.resolve(undefined), notify: () => {} })
    await server.handleRequest(HOST_STDIO_METHODS.initialize, {
      clientInfo: { name: 'dsh-vscode', version: '0.1.0' },
    })

    const pending = server.handleRequest(HOST_STDIO_METHODS.request, {
      type: 'client-request', rpcId: 'cancel-me', method: 'host.pickDirectory', payload: {},
    })
    await vi.waitFor(() => { expect(observedSignal).toBeDefined() })
    server.handleNotification(HOST_STDIO_METHODS.cancel, { rpcId: 'cancel-me' })

    await expect(pending).resolves.toMatchObject({
      rpcId: 'cancel-me',
      result: { ok: false, error: { code: 'cancelled' } },
    })
    expect(observedSignal?.aborted).toBe(true)
    await server.shutdown()
  })

  it('rejects duplicate request ids and aborts active requests during shutdown', async () => {
    let observedSignal: AbortSignal | undefined
    const api = {
      host: {
        pickDirectory: ({ rpcId }: { rpcId: ReturnType<typeof RpcId> }, signal: AbortSignal) => {
          observedSignal = signal
          return new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              resolve({
                rpcId,
                result: { ok: false, error: { code: 'cancelled', message: 'cancelled', details: {} } },
              })
            }, { once: true })
          })
        },
      },
      events: { mux: async function* () {}, host: async function* () {} },
      respond: () => Promise.resolve({ accepted: true }),
    } as unknown as ApiProxy
    const server = new HostApiStdioServer(api, { request: () => Promise.resolve(undefined), notify: () => {} })
    await server.handleRequest(HOST_STDIO_METHODS.initialize, {
      clientInfo: { name: 'dsh-vscode', version: '0.1.0' },
    })
    const request = {
      type: 'client-request', rpcId: 'duplicate', method: 'host.pickDirectory', payload: {},
    }
    const pending = server.handleRequest(HOST_STDIO_METHODS.request, request)
    await vi.waitFor(() => { expect(observedSignal).toBeDefined() })
    await expect(server.handleRequest(HOST_STDIO_METHODS.request, request)).rejects.toThrow('already pending')

    await server.shutdown()
    await expect(pending).resolves.toMatchObject({ result: { ok: false, error: { code: 'cancelled' } } })
    expect(observedSignal?.aborted).toBe(true)
  })
})
