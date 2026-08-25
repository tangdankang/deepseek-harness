/**
 * Browser- and extension-safe vocabulary for the Host API stdio carrier.
 * @module @deepseek-ai/dsh-host-apiproxy-stdio/protocol
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ServerRequest } from '@deepseek-ai/dsh-host-apiproxy'

/** Current version of the stdio Host API carrier protocol. */
export const HOST_STDIO_PROTOCOL_VERSION = 2

/** JSON-RPC method names owned by this carrier. */
export const HOST_STDIO_METHODS = {
  initialize: 'dsh/initialize',
  request: 'dsh/request',
  cancel: 'dsh/cancel',
  respond: 'dsh/respond',
  subscribe: 'dsh/subscribe',
  unsubscribe: 'dsh/unsubscribe',
  shutdown: 'dsh/shutdown',
  event: 'dsh/event',
  streamEnd: 'dsh/streamEnd',
} as const

/** Opaque identifier of one carrier-owned event subscription. */
export type HostStdioSubscriptionId = Branded<'host-stdio-subscription-id'>

/**
 * Brand a carrier-minted subscription identifier after wire validation.
 * @param value - non-empty identifier string.
 * @returns the same string with its carrier identity.
 */
export function HostStdioSubscriptionId(value: string): HostStdioSubscriptionId {
  return value as HostStdioSubscriptionId
}

/** Initialization result returned before Host API requests are accepted. */
export interface HostStdioInitializeResult {
  /** Carrier protocol version spoken by this process. */
  protocolVersion: typeof HOST_STDIO_PROTOCOL_VERSION
  /** Stable server identity for diagnostics. */
  serverInfo: { name: 'deepseek-harness-host' }
}

/** Event stream names exposed by the Host API. */
export type HostStdioStream = 'mux' | 'host'

/** Result of opening a carrier-owned Host API stream. */
export interface HostStdioSubscribeResult {
  /** Identifier passed back on notifications and to unsubscribe. */
  subscriptionId: HostStdioSubscriptionId
}

/** Parameters of a `dsh/event` notification. */
export interface HostStdioEventNotification {
  /** Subscription that emitted the frame. */
  subscriptionId: HostStdioSubscriptionId
  /** Logical Host API stream that emitted the frame. */
  stream: HostStdioStream
  /** Full-form server request, including answerable interaction ids. */
  message: ServerRequest
}

/** Parameters of a best-effort `dsh/cancel` notification. */
export interface HostStdioCancelNotification {
  /** Host API client-request id whose local execution should stop. */
  rpcId: ServerRequest['rpcId']
}

/** Parameters emitted once a subscribed Host API iterator settles. */
export interface HostStdioStreamEndNotification {
  /** Subscription whose iterator settled. */
  subscriptionId: HostStdioSubscriptionId
  /** Logical Host API stream that settled. */
  stream: HostStdioStream
  /** Whether the iterator ended itself or was cancelled by its owner. */
  reason: 'completed' | 'cancelled'
}
