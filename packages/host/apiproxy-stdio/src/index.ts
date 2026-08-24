/**
 * Newline-delimited JSON-RPC carrier for the transport-independent Host API.
 * Stdout carries protocol frames only; diagnostics belong on stderr. The
 * `dsh` launcher owns process exit and complete root disposal.
 *
 * @module @deepseek-ai/dsh-host-apiproxy-stdio
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-cmdline'
import {
  dispatchClientRequest,
  RpcId,
  type ApiProxy,
  type ClientResponse,
  type HostFrame,
  type MuxFrame,
  type RpcReceipt,
  type RpcRequest,
  type ServerRequest,
  type ServerResponse,
} from '@deepseek-ai/dsh-host-apiproxy'
import { clientRequestSchema, clientResponseSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import { JsonRpcLineTransport, type JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import { z } from 'zod'
import {
  HOST_STDIO_METHODS,
  HOST_STDIO_PROTOCOL_VERSION,
  HostStdioSubscriptionId,
  type HostStdioEventNotification,
  type HostStdioInitializeResult,
  type HostStdioStream,
  type HostStdioSubscribeResult,
} from './protocol.ts'

export * from './protocol.ts'

const initializeSchema = z.object({
  clientInfo: z.object({ name: z.string().min(1), version: z.string().min(1) }).strict(),
}).strict()
const subscribeSchema = z.discriminatedUnion('stream', [
  z.object({
    stream: z.literal('mux'),
    payload: z.object({ since: z.record(z.string(), z.number().int().min(-1)).optional() }).strict().default({}),
  }).strict(),
  z.object({ stream: z.literal('host'), payload: z.object({}).strict().default({}) }).strict(),
])
const unsubscribeSchema = z.object({ subscriptionId: z.string().min(1) }).strict()
const emptyParamsSchema = z.object({}).strict()

interface Subscription {
  controller: AbortController
  task: Promise<void>
}

/**
 * Host API protocol handler independent of process streams. One instance
 * owns initialization state and all event-stream lifetimes on its carrier.
 */
export class HostApiStdioServer {
  private initialized = false
  private closing = false
  private readonly subscriptions = new Map<HostStdioSubscriptionId, Subscription>()

  /**
   * @param api - transport-independent Host API implementation.
   * @param peer - outbound notification surface of the JSON-RPC carrier.
   */
  constructor(
    private readonly api: ApiProxy,
    private readonly peer: JsonRpcTransportPeer,
  ) {}

  /**
   * Handle one JSON-RPC request. Invalid external values reject before they
   * reach typed Host API methods.
   * @param method - JSON-RPC method name.
   * @param params - normalized object parameters.
   * @returns the method result.
   */
  async handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closing) throw new Error('Host API stdio server is shutting down')
    if (method === HOST_STDIO_METHODS.initialize) return this.initialize(params)
    if (!this.initialized) throw new Error(`Host API stdio method ${method} requires dsh/initialize first`)

    switch (method) {
      case HOST_STDIO_METHODS.request:
        return this.request(params)
      case HOST_STDIO_METHODS.respond:
        return this.respond(params)
      case HOST_STDIO_METHODS.subscribe:
        return this.subscribe(params)
      case HOST_STDIO_METHODS.unsubscribe:
        return this.unsubscribe(params)
      case HOST_STDIO_METHODS.shutdown:
        emptyParamsSchema.parse(params)
        return { accepted: true }
      default:
        throw new Error(`unknown Host API stdio method: ${method}`)
    }
  }

  /** Stop accepting work, cancel every stream, and await stream quiescence. */
  async shutdown(): Promise<void> {
    if (this.closing) return
    this.closing = true
    const subscriptions = [...this.subscriptions.values()]
    this.subscriptions.clear()
    for (const subscription of subscriptions) subscription.controller.abort(new Error('Host API stdio server stopped'))
    await Promise.allSettled(subscriptions.map(subscription => subscription.task))
  }

  private initialize(params: Record<string, unknown>): HostStdioInitializeResult {
    initializeSchema.parse(params)
    if (this.initialized) throw new Error('Host API stdio server is already initialized')
    this.initialized = true
    return {
      protocolVersion: HOST_STDIO_PROTOCOL_VERSION,
      serverInfo: { name: 'deepseek-harness-host' },
    }
  }

  private request(params: Record<string, unknown>): Promise<ServerResponse> {
    const message = clientRequestSchema.parse(params)
    return dispatchClientRequest(this.api, message, new AbortController().signal)
  }

  private respond(params: Record<string, unknown>): Promise<RpcReceipt> {
    const message: ClientResponse = clientResponseSchema.parse(params)
    return this.api.respond(message)
  }

  private subscribe(params: Record<string, unknown>): HostStdioSubscribeResult {
    const parsed = subscribeSchema.parse(params)
    const subscriptionId = HostStdioSubscriptionId(randomUUID())
    const controller = new AbortController()
    const muxPayload: Parameters<ApiProxy['events']['mux']>[0]['payload'] = parsed.stream === 'mux'
      ? parsed.payload.since === undefined ? {} : {
        // The wire schema validates every map key and integer cursor before
        // the typed Host API receives the map.
        since: parsed.payload.since,
      }
      : {}
    const frames = parsed.stream === 'mux'
      ? this.api.events.mux({ rpcId: RpcId(randomUUID()), payload: muxPayload }, controller.signal)
      : this.api.events.host({ rpcId: RpcId(randomUUID()), payload: parsed.payload }, controller.signal)
    const subscription: Subscription = { controller, task: Promise.resolve() }
    this.subscriptions.set(subscriptionId, subscription)
    subscription.task = this.pump(subscriptionId, parsed.stream, frames, controller.signal)
    return { subscriptionId }
  }

  private async unsubscribe(params: Record<string, unknown>): Promise<{ removed: boolean }> {
    const { subscriptionId: rawId } = unsubscribeSchema.parse(params)
    const subscriptionId = HostStdioSubscriptionId(rawId)
    const subscription = this.subscriptions.get(subscriptionId)
    if (subscription === undefined) return { removed: false }
    this.subscriptions.delete(subscriptionId)
    subscription.controller.abort(new Error('Host API stdio subscription removed'))
    await subscription.task
    return { removed: true }
  }

  private async pump(
    subscriptionId: HostStdioSubscriptionId,
    stream: HostStdioStream,
    frames: AsyncIterable<RpcRequest<MuxFrame | HostFrame>>,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      for await (const frame of frames) {
        this.notify(subscriptionId, stream, {
          type: 'server-request',
          rpcId: frame.rpcId,
          method: frame.payload.type,
          payload: frame.payload,
        })
      }
    } catch (error: unknown) {
      if (!signal.aborted && !this.closing) {
        try {
          this.notify(subscriptionId, stream, {
            type: 'server-request',
            rpcId: RpcId(randomUUID()),
            method: 'stream/error',
            payload: {
              type: 'stream/error',
              error: { code: 'internal', message: String(error), details: {} },
            } satisfies MuxFrame | HostFrame,
          })
        } catch {
          // The output failed while reporting a stream failure; no live peer
          // remains to receive a second diagnostic.
        }
      }
    } finally {
      this.subscriptions.delete(subscriptionId)
    }
  }

  private notify(
    subscriptionId: HostStdioSubscriptionId,
    stream: HostStdioStream,
    message: ServerRequest,
  ): void {
    const notification: HostStdioEventNotification = { subscriptionId, stream, message }
    this.peer.notify(HOST_STDIO_METHODS.event, notification)
  }
}

/** Cordis plugin name. */
export const name = 'host-apiproxy-stdio'

/** Services required before the carrier can reserve process stdio. */
export const inject = ['apiProxy', 'appExit']

/**
 * Reserve process stdio for the Host API carrier. Protocol shutdown and input
 * closure both stop subscriptions before requesting bounded launcher exit.
 * @param ctx - context carrying `apiProxy` and launcher-owned `appExit`.
 */
export function apply(ctx: Context): void {
  const appExit = ctx.get('appExit')
  if (appExit === undefined) throw new Error('host-apiproxy-stdio: the launcher must provide ctx.appExit before the tree mounts')
  /* v8 ignore next -- production stream wiring is covered by the built-process smoke */
  const input = process.stdin
  /* v8 ignore next -- production stream wiring is covered by the built-process smoke */
  const output = process.stdout
  const transport = new JsonRpcLineTransport(input, output)
  const server = new HostApiStdioServer(ctx.apiProxy, transport)
  let exitTask: Promise<void> | undefined

  const requestExit = (): Promise<void> => {
    exitTask ??= (async () => {
      await Promise.allSettled([transport.flush(), server.shutdown()])
      appExit(0)
    })()
    return exitTask
  }

  transport.onRequest(async (method, params) => {
    const result = await server.handleRequest(method, params)
    if (method === HOST_STDIO_METHODS.shutdown) setImmediate(() => { void requestExit() })
    return result
  })

  const onInputEnd = (): void => { void requestExit() }
  const onInputError = (): void => { void requestExit() }
  ctx.effect(() => {
    input.on('end', onInputEnd)
    input.on('error', onInputError)
    transport.start()
    return async () => {
      input.off('end', onInputEnd)
      input.off('error', onInputError)
      await server.shutdown()
      transport.close()
    }
  }, 'host-apiproxy-stdio.serve')
}
