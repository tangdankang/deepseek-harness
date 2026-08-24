/** Typed client for the Host API stdio handshake and P2.1 settings methods. */

import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import {
  HOST_STDIO_METHODS,
  HOST_STDIO_PROTOCOL_VERSION,
  type HostStdioInitializeResult,
} from '@deepseek-ai/dsh-host-apiproxy-stdio/protocol'
import {
  settingsDescribeValueSchema,
  settingsMutateValueSchema,
} from '@deepseek-ai/dsh-host-apiproxy/api/settings.schema'
import type {
  SettingsNamespaceView,
  SettingsPathOpView,
} from '@deepseek-ai/dsh-host-apiproxy/api/settings'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'

/** Host facts shown by the P1 connection surface. */
export interface HostDescription {
  /** Running DSH version. */
  version: string
  /** Runtime working directory. */
  cwd: string
  /** Configured default provider, when explicit. */
  provider?: string
  /** Configured default model, when explicit. */
  model?: string
  /** Number of sessions currently attached to live agents. */
  attachedSessions: number
  /** Whether the host can open native paths. */
  canOpenPath: boolean
}

/** Redacted settings inventory returned by the Host. */
export interface SettingsDescription {
  /** Whether the mounted settings provider accepts writes. */
  writable: boolean
  /** Whether a local settings document can be opened. */
  hasDocument: boolean
  /** Registered settings namespaces. */
  namespaces: SettingsNamespaceView[]
}

/** One revision-checked settings mutation. */
export interface SettingsMutation {
  /** Registered settings namespace. */
  ns: string
  /** Path-addressed operations over its user section. */
  ops: SettingsPathOpView[]
  /** Revision returned by the descriptor used to construct the edit. */
  expectedRevision?: number
}

/**
 * One client connection over caller-owned child streams. The caller owns
 * process lifetime; {@link close} only detaches protocol listeners.
 */
export class HostProtocolClient {
  private readonly transport: JsonRpcLineTransport

  /**
   * @param input - child stdout, reserved for protocol frames.
   * @param output - child stdin, used for protocol frames.
   */
  constructor(input: Readable, output: Writable) {
    this.transport = new JsonRpcLineTransport(input, output)
  }

  /** Attach stream listeners. Idempotent. */
  start(): void {
    this.transport.start()
  }

  /**
   * Negotiate the carrier protocol.
   * @param clientVersion - VS Code extension version.
   * @param signal - handshake deadline or cancellation.
   * @returns validated server initialization facts.
   */
  async initialize(clientVersion: string, signal: AbortSignal): Promise<HostStdioInitializeResult> {
    const value = await this.transport.request(HOST_STDIO_METHODS.initialize, {
      clientInfo: { name: 'dsh-vscode', version: clientVersion },
    }, signal)
    if (!isRecord(value)
      || value.protocolVersion !== HOST_STDIO_PROTOCOL_VERSION
      || !isRecord(value.serverInfo)
      || value.serverInfo.name !== 'deepseek-harness-host') {
      throw new Error('DSH returned an incompatible stdio initialization response')
    }
    return value as unknown as HostStdioInitializeResult
  }

  /**
   * Read and validate the running host snapshot.
   * @param signal - request deadline or cancellation.
   * @returns host facts used by the connection surface.
   */
  async describe(signal: AbortSignal): Promise<HostDescription> {
    const value = await this.requestHost('host.describe', {}, signal)
    if (!isHostDescription(value)) {
      throw new Error('DSH returned invalid host.describe fields')
    }
    return value
  }

  /**
   * Read the redacted settings inventory.
   * @param signal - request deadline or cancellation.
   * @returns writable state and validated namespace descriptors.
   */
  async describeSettings(signal: AbortSignal): Promise<SettingsDescription> {
    const value = await this.requestHost('settings.describe', {}, signal)
    const parsed = settingsDescribeValueSchema.safeParse(value)
    if (!parsed.success) throw new Error('DSH returned invalid settings.describe fields')
    return parsed.data
  }

  /**
   * Apply one revision-checked path mutation.
   * @param mutation - namespace, path operations, and source revision.
   * @param signal - request deadline or cancellation.
   * @returns the redacted namespace after the committed write.
   */
  async mutateSettings(mutation: SettingsMutation, signal: AbortSignal): Promise<SettingsNamespaceView> {
    const value = await this.requestHost('settings.mutate', mutation, signal)
    const parsed = settingsMutateValueSchema.safeParse(value)
    if (!parsed.success) throw new Error('DSH returned invalid settings.mutate fields')
    return parsed.data
  }

  /**
   * Ask the launcher-owned runtime to dispose and exit.
   * @param signal - graceful-shutdown deadline.
   */
  async shutdown(signal: AbortSignal): Promise<void> {
    const result = await this.transport.request(HOST_STDIO_METHODS.shutdown, {}, signal)
    if (!isRecord(result) || result.accepted !== true) {
      throw new Error('DSH rejected the stdio shutdown request')
    }
  }

  /** Detach protocol listeners and reject pending requests. */
  close(): void {
    this.transport.close()
  }

  /** Dispatch one Host API request and unwrap its business result. */
  private async requestHost(method: string, payload: object, signal: AbortSignal): Promise<unknown> {
    const rpcId = randomUUID()
    const response = await this.transport.request(HOST_STDIO_METHODS.request, {
      type: 'client-request', rpcId, method, payload,
    }, signal)
    if (!isRecord(response) || response.type !== 'server-response' || response.rpcId !== rpcId
      || !isRecord(response.result)) {
      throw new Error(`DSH returned an invalid ${method} response`)
    }
    if (response.result.ok !== true) {
      const error = isRecord(response.result.error) && typeof response.result.error.message === 'string'
        ? response.result.error.message
        : `${method} failed`
      throw new Error(error)
    }
    return response.result.value
  }
}

/** Narrow an external JSON value to a non-array record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate the host.describe success value. */
function isHostDescription(value: unknown): value is HostDescription {
  if (!isRecord(value)
    || typeof value.version !== 'string'
    || typeof value.cwd !== 'string'
    || typeof value.attachedSessions !== 'number'
    || !Number.isInteger(value.attachedSessions)
    || value.attachedSessions < 0
    || typeof value.canOpenPath !== 'boolean') return false
  if (value.provider !== undefined && typeof value.provider !== 'string') return false
  if (value.model !== undefined && typeof value.model !== 'string') return false
  return true
}
