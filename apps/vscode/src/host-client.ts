/** Typed Host API client over the versioned stdio carrier. */

import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import type {
  ApiProxy, ApprovalResponsePayload, ClientResponse, HostFrame, MuxFrame, RpcError,
  RpcId, RpcReceipt, RpcRequest, ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId as rpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { RequestPayload, ResponseValue, RpcMethodMap } from '@deepseek-ai/dsh-host-apiproxy/api/rpc-map'
import { parseResponseValue } from '@deepseek-ai/dsh-host-apiproxy/api/response-values'
import { rpcReceiptSchema, serverRequestSchema, serverResponseSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import { approvalResponsePayloadSchema } from '@deepseek-ai/dsh-host-apiproxy/api/approvals.schema'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import {
  HOST_STDIO_METHODS, HOST_STDIO_PROTOCOL_VERSION,
  type HostStdioEventNotification, type HostStdioInitializeResult, type HostStdioStream,
  type HostStdioStreamEndNotification, type HostStdioSubscriptionId,
} from '@deepseek-ai/dsh-host-apiproxy-stdio/protocol'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'

/** Host facts shown by the connection surface. */
export type HostDescription = ResponseValue<'host.describe'>

/** Redacted settings inventory returned by the Host. */
export type SettingsDescription = ResponseValue<'settings.describe'>

/** One revision-checked settings mutation. */
export type SettingsMutation = RequestPayload<'settings.mutate'>

type MuxSubscriptionPayload = Parameters<ApiProxy['events']['mux']>[0]['payload']

/** Business failure returned by a validated Host API response. */
export class HostApiResponseError extends Error {
  /** @param error - typed Host API business error. */
  constructor(readonly error: RpcError) {
    super(error.message)
    this.name = 'HostApiResponseError'
  }
}

/** One owned long-lived Host stream. */
export interface HostSubscription<F extends MuxFrame | HostFrame> extends AsyncIterable<RpcRequest<F>> {
  /** Carrier subscription identity. */
  readonly id: HostStdioSubscriptionId
  /** Resolves after a normal end and rejects if the connection closes. */
  readonly done: Promise<void>
  /** Cancel the server iterator and await its settlement. */
  unsubscribe(signal?: AbortSignal): Promise<void>
}

interface SubscriptionState<F extends MuxFrame | HostFrame> {
  stream: HostStdioStream
  queue: AsyncQueue<RpcRequest<F>>
  closing: boolean
}

/**
 * One client connection over caller-owned child streams. The caller owns
 * process lifetime; {@link close} only detaches protocol listeners.
 */
export class HostProtocolClient {
  private readonly transport: JsonRpcLineTransport
  private readonly subscriptions = new Map<HostStdioSubscriptionId, SubscriptionState<MuxFrame | HostFrame>>()
  private readonly earlyEvents = new Map<HostStdioSubscriptionId, HostStdioEventNotification[]>()
  private readonly earlyEnds = new Map<HostStdioSubscriptionId, HostStdioStreamEndNotification>()
  private started = false
  private closed = false

  constructor(private readonly input: Readable, output: Writable) {
    this.transport = new JsonRpcLineTransport(input, output)
  }

  /** Attach stream listeners and notification routing. Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true
    this.transport.onNotification((method, params) => {
      try {
        this.onNotification(method, params)
      } catch (error: unknown) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    this.input.on('end', this.onInputEnd)
    this.input.on('error', this.onInputError)
    this.transport.start()
  }

  /** Negotiate the carrier protocol. */
  async initialize(clientVersion: string, signal: AbortSignal): Promise<HostStdioInitializeResult> {
    const value = await this.transport.request(HOST_STDIO_METHODS.initialize, {
      clientInfo: { name: 'dsh-vscode', version: clientVersion },
    }, signal)
    if (!isRecord(value) || value.protocolVersion !== HOST_STDIO_PROTOCOL_VERSION
      || !isRecord(value.serverInfo) || value.serverInfo.name !== 'deepseek-harness-host') {
      throw new Error('DSH returned an incompatible stdio initialization response')
    }
    return value as unknown as HostStdioInitializeResult
  }

  /** Dispatch and validate one unary Host API method. */
  async request<K extends keyof RpcMethodMap>(
    method: K,
    payload: RequestPayload<K>,
    signal: AbortSignal,
  ): Promise<ResponseValue<K>> {
    const requestId = rpcId(randomUUID())
    const onAbort = (): void => {
      try {
        this.transport.notify(HOST_STDIO_METHODS.cancel, { rpcId: requestId })
      } catch {
        // The transport failure already rejects the request waiter.
      }
    }
    if (signal.aborted) throw abortError(signal)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const value = await this.transport.request(HOST_STDIO_METHODS.request, {
        type: 'client-request', rpcId: requestId, method, payload,
      }, signal)
      const response = serverResponseSchema.parse(value)
      if (response.rpcId !== requestId) {
        throw new Error(`rpcId mismatch for ${method}: sent ${requestId}, got ${response.rpcId}`)
      }
      if (!response.result.ok) throw new HostApiResponseError(response.result.error)
      return parseResponseValue(method, response.result.value)
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** Read and validate the running host snapshot. */
  describe(signal: AbortSignal): Promise<HostDescription> {
    return this.request('host.describe', {}, signal)
  }

  /** Read the redacted settings inventory. */
  describeSettings(signal: AbortSignal): Promise<SettingsDescription> {
    return this.request('settings.describe', {}, signal)
  }

  /** Apply one revision-checked settings mutation. */
  mutateSettings(mutation: SettingsMutation, signal: AbortSignal): Promise<ResponseValue<'settings.mutate'>> {
    return this.request('settings.mutate', mutation, signal)
  }

  /** Open the all-session mux stream. */
  subscribeMux(payload: MuxSubscriptionPayload = {}, signal: AbortSignal): Promise<HostSubscription<MuxFrame>> {
    return this.subscribe('mux', payload, signal, muxFrameSchema)
  }

  /** Open the host-level lifecycle stream. */
  subscribeHost(signal: AbortSignal): Promise<HostSubscription<HostFrame>> {
    return this.subscribe('host', {}, signal, hostFrameSchema)
  }

  /** Answer one approval server request with its original rpcId. */
  async respondApproval(requestId: RpcId, payload: ApprovalResponsePayload, signal: AbortSignal): Promise<RpcReceipt> {
    const response: ClientResponse = {
      type: 'client-response',
      rpcId: requestId,
      result: { ok: true, value: approvalResponsePayloadSchema.parse(payload) },
    }
    return rpcReceiptSchema.parse(await this.transport.request(HOST_STDIO_METHODS.respond, response, signal))
  }

  /** Ask the launcher-owned runtime to dispose and exit. */
  async shutdown(signal: AbortSignal): Promise<void> {
    const result = await this.transport.request(HOST_STDIO_METHODS.shutdown, {}, signal)
    if (!isRecord(result) || result.accepted !== true) throw new Error('DSH rejected the stdio shutdown request')
  }

  /** Detach protocol listeners and reject pending requests and streams. */
  close(): void {
    this.fail(new Error('DSH Host connection closed'))
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    for (const state of this.subscriptions.values()) state.queue.fail(error)
    this.subscriptions.clear()
    this.earlyEvents.clear()
    this.earlyEnds.clear()
    this.input.off('end', this.onInputEnd)
    this.input.off('error', this.onInputError)
    this.transport.close()
  }

  private readonly onInputEnd = (): void => {
    this.fail(new Error('DSH Host input closed'))
  }

  private readonly onInputError = (error: Error): void => {
    this.fail(error)
  }

  private async subscribe<F extends MuxFrame | HostFrame>(
    stream: HostStdioStream,
    payload: object,
    signal: AbortSignal,
    frameSchema: { parse(value: unknown): F },
  ): Promise<HostSubscription<F>> {
    const value = await this.transport.request(HOST_STDIO_METHODS.subscribe, { stream, payload }, signal)
    if (!isRecord(value) || typeof value.subscriptionId !== 'string' || value.subscriptionId === '') {
      throw new Error(`DSH returned an invalid ${stream} subscription`)
    }
    const id = value.subscriptionId as HostStdioSubscriptionId
    const queue = new AsyncQueue<RpcRequest<F>>()
    const state: SubscriptionState<F> = { stream, queue, closing: false }
    this.subscriptions.set(id, state as unknown as SubscriptionState<MuxFrame | HostFrame>)
    for (const event of this.earlyEvents.get(id) ?? []) this.acceptEvent(state, event, frameSchema)
    this.earlyEvents.delete(id)
    const end = this.earlyEnds.get(id)
    if (end !== undefined) {
      this.earlyEnds.delete(id)
      this.acceptEnd(id, end)
    }
    return {
      id,
      done: queue.done,
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
      unsubscribe: async (unsubscribeSignal = AbortSignal.timeout(15_000)) => {
        if (state.closing) return queue.done
        state.closing = true
        try {
          const result = await this.transport.request(HOST_STDIO_METHODS.unsubscribe, { subscriptionId: id }, unsubscribeSignal)
          if (!isRecord(result) || typeof result.removed !== 'boolean') {
            throw new Error(`DSH returned an invalid ${stream} unsubscribe receipt`)
          }
          queue.finish()
        } finally {
          this.subscriptions.delete(id)
        }
      },
    }
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (method === HOST_STDIO_METHODS.event) {
      const notification = parseEventNotification(params)
      const state = this.subscriptions.get(notification.subscriptionId)
      if (state === undefined) {
        const buffered = this.earlyEvents.get(notification.subscriptionId) ?? []
        buffered.push(notification)
        this.earlyEvents.set(notification.subscriptionId, buffered)
        return
      }
      this.acceptEvent(state, notification, state.stream === 'mux' ? muxFrameSchema : hostFrameSchema)
      return
    }
    if (method === HOST_STDIO_METHODS.streamEnd) {
      const notification = parseStreamEndNotification(params)
      if (!this.subscriptions.has(notification.subscriptionId)) {
        this.earlyEnds.set(notification.subscriptionId, notification)
        return
      }
      this.acceptEnd(notification.subscriptionId, notification)
    }
  }

  private acceptEvent<F extends MuxFrame | HostFrame>(
    state: SubscriptionState<F>,
    notification: HostStdioEventNotification,
    frameSchema: { parse(value: unknown): F },
  ): void {
    if (notification.stream !== state.stream) throw new Error('DSH stdio event stream identity changed')
    const message: ServerRequest = serverRequestSchema.parse(notification.message)
    const frame = frameSchema.parse(message.payload)
    if (message.method !== frame.type) throw new Error('DSH stdio event method does not match its payload type')
    state.queue.push({ rpcId: message.rpcId, payload: frame })
  }

  private acceptEnd(id: HostStdioSubscriptionId, notification: HostStdioStreamEndNotification): void {
    const state = this.subscriptions.get(id)
    if (state === undefined) return
    if (notification.stream !== state.stream) throw new Error('DSH stdio stream-end identity changed')
    state.queue.finish()
    this.subscriptions.delete(id)
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<{ resolve: (value: IteratorResult<T>) => void; reject: (error: Error) => void }> = []
  private settled = false
  private readonly donePromise: Promise<void>
  private resolveDone: () => void = () => {}
  private rejectDone: (error: Error) => void = () => {}

  constructor() {
    this.donePromise = new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve
      this.rejectDone = reject
    })
    void this.donePromise.catch(() => undefined)
  }

  get done(): Promise<void> { return this.donePromise }

  push(value: T): void {
    if (this.settled) return
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.values.push(value)
    else waiter.resolve({ done: false, value })
  }

  finish(): void {
    if (this.settled) return
    this.settled = true
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined })
    this.resolveDone()
  }

  fail(error: Error): void {
    if (this.settled) return
    this.settled = true
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
    this.rejectDone(error)
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift()
        if (value !== undefined) return Promise.resolve({ done: false, value })
        if (this.settled) return Promise.resolve({ done: true, value: undefined })
        return new Promise<IteratorResult<T>>((resolve, reject) => { this.waiters.push({ resolve, reject }) })
      },
    }
  }
}

function parseEventNotification(params: Record<string, unknown>): HostStdioEventNotification {
  if (typeof params.subscriptionId !== 'string' || (params.stream !== 'mux' && params.stream !== 'host')
    || !isRecord(params.message)) throw new Error('DSH returned an invalid stdio event notification')
  return params as unknown as HostStdioEventNotification
}

function parseStreamEndNotification(params: Record<string, unknown>): HostStdioStreamEndNotification {
  if (typeof params.subscriptionId !== 'string' || (params.stream !== 'mux' && params.stream !== 'host')
    || (params.reason !== 'completed' && params.reason !== 'cancelled')) {
    throw new Error('DSH returned an invalid stdio stream-end notification')
  }
  return params as unknown as HostStdioStreamEndNotification
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))
}
