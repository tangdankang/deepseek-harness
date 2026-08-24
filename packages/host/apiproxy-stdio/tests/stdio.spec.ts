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
    await vi.waitFor(() => { expect(notifications).toHaveLength(1) })
    const notification = notifications[0]?.params as HostStdioEventNotification
    expect(notifications[0]?.method).toBe(HOST_STDIO_METHODS.event)
    expect(notification.subscriptionId).toBe(subscribed.subscriptionId)
    expect(notification.message).toEqual({
      type: 'server-request',
      rpcId: 'event-1',
      method: 'session/subscribed',
      payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: -1 },
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
})
