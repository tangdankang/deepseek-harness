/** Owned DSH child-process lifecycle and P1 connection state. */

import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type {
  ApprovalResponsePayload, HostFrame, MuxFrame, RpcId, RpcReceipt, RpcRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type { RequestPayload, ResponseValue, RpcMethodMap } from '@deepseek-ai/dsh-host-apiproxy/api/rpc-map'
import crossSpawn from 'cross-spawn'
import {
  HostProtocolClient,
  type HostSubscription,
  type HostDescription,
  type SettingsDescription,
  type SettingsMutation,
} from './host-client.ts'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-host-apiproxy/api/settings'
import { redactDiagnostic } from './environment.ts'
import { HostEventFold } from './event-fold.ts'

type SessionId = Extract<MuxFrame, { type: 'session/event' }>['sessionId']

/** Configuration resolved for one runtime launch. */
export interface RuntimeLaunchConfig {
  /** Executable name or absolute path. */
  command: string
  /** Arguments passed without a shell. */
  args: readonly string[]
  /** Child working directory. */
  cwd: string
  /** Scrubbed child environment. */
  env: NodeJS.ProcessEnv
  /** Per-request readiness deadline during startup. */
  handshakeTimeoutMs: number
  /** Graceful shutdown deadline before termination. */
  stopTimeoutMs: number
}

/** Observable runtime lifecycle state. */
export type RuntimeState =
  | { kind: 'stopped' }
  | { kind: 'starting' }
  | { kind: 'connected'; host: HostDescription; defaultPermission: string }
  | { kind: 'stopping' }
  | { kind: 'error'; message: string }

/** Minimal logging surface used by VS Code and tests. */
export interface RuntimeLogger {
  /** Append one already-redacted diagnostic line. */
  appendLine(line: string): void
}

/** Child-spawn seam retained for deterministic lifecycle tests. */
export type RuntimeSpawner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe']; windowsHide: true },
) => ChildProcessWithoutNullStreams

interface ExitResult {
  code: number | null
  signal: NodeJS.Signals | null
}

/**
 * Resolve the project directory used by the coding runtime.
 * @param configuredCwd - explicit advanced-setting value, if any.
 * @param workspaceCwd - first open VS Code workspace folder, if any.
 * @returns the explicit directory or open workspace folder.
 */
export function resolveRuntimeCwd(configuredCwd: string, workspaceCwd: string | undefined): string {
  if (configuredCwd !== '') return configuredCwd
  if (workspaceCwd !== undefined) return workspaceCwd
  throw new Error('尚未打开工作区文件夹。请先选择“文件 → 打开文件夹”，打开要让 DSH 处理的项目，再点击“启动”；也可以在 DSH 高级设置中填写运行时工作目录。')
}

/**
 * Own one DSH process at a time. State changes are synchronous; each async
 * lifecycle method settles only after its owned transition reaches a terminal
 * state.
 */
export class RuntimeManager {
  /** Reconciled Host events retained across owned process generations. */
  readonly events = new HostEventFold()
  private currentState: RuntimeState = { kind: 'stopped' }
  private readonly listeners = new Set<(state: RuntimeState) => void>()
  private child: ChildProcessWithoutNullStreams | undefined
  private client: HostProtocolClient | undefined
  private exitResult: Promise<ExitResult> | undefined
  private generation = 0
  private startTask: Promise<void> | undefined
  private stopTask: Promise<void> | undefined
  private stderrTail = ''

  /**
   * @param extensionVersion - client version reported during initialization.
   * @param logger - redacted runtime output sink.
   * @param spawner - cross-platform process launcher.
   */
  constructor(
    private readonly extensionVersion: string,
    private readonly logger: RuntimeLogger,
    private readonly spawner: RuntimeSpawner = crossSpawn as RuntimeSpawner,
  ) {}

  /** Current immutable lifecycle snapshot. */
  get state(): RuntimeState {
    return this.currentState
  }

  /**
   * Subscribe to state changes.
   * @param listener - invoked synchronously after each transition.
   * @returns disposer for this subscription.
   */
  onStateChange(listener: (state: RuntimeState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Start and handshake one DSH child. Concurrent starts share one task.
   * @param config - fully resolved launch configuration.
   */
  start(config: RuntimeLaunchConfig): Promise<void> {
    if (this.currentState.kind === 'connected') return Promise.resolve()
    if (this.startTask !== undefined) return this.startTask
    if (this.stopTask !== undefined) return this.stopTask.then(() => this.start(config))
    const generation = ++this.generation
    const task = this.startInternal(config, generation).finally(() => {
      if (this.startTask === task) this.startTask = undefined
    })
    this.startTask = task
    return task
  }

  /** Stop the owned child, escalating only after the configured deadline. */
  stop(stopTimeoutMs = 5_000): Promise<void> {
    if (this.stopTask !== undefined) return this.stopTask
    const generation = ++this.generation
    const task = this.stopInternal(stopTimeoutMs, generation).finally(() => {
      if (this.stopTask === task) this.stopTask = undefined
    })
    this.stopTask = task
    return task
  }

  /**
   * Stop the current child and start a new one with fresh configuration.
   * @param config - fully resolved launch configuration.
   */
  async restart(config: RuntimeLaunchConfig): Promise<void> {
    await this.stop(config.stopTimeoutMs)
    await this.start(config)
  }

  /**
   * Read the connected Host's redacted settings inventory.
   * @param signal - request deadline or cancellation.
   * @returns validated settings descriptors.
   */
  async describeSettings(signal: AbortSignal = AbortSignal.timeout(15_000)): Promise<SettingsDescription> {
    return this.connectedClient().describeSettings(signal)
  }

  /**
   * Commit one settings mutation through the connected Host.
   * @param mutation - revision-checked path operations.
   * @param signal - request deadline or cancellation.
   * @returns the namespace descriptor after commit.
   */
  async mutateSettings(
    mutation: SettingsMutation,
    signal: AbortSignal = AbortSignal.timeout(15_000),
  ): Promise<SettingsNamespaceView> {
    return this.connectedClient().mutateSettings(mutation, signal)
  }

  /** Dispatch one validated Host API call through the connected process. */
  request<K extends keyof RpcMethodMap>(
    method: K,
    payload: RequestPayload<K>,
    signal: AbortSignal = AbortSignal.timeout(30_000),
  ): Promise<ResponseValue<K>> {
    return this.connectedClient().request(method, payload, signal)
  }

  /**
   * Track and reconcile one session tail against current mux delivery.
   * @param sessionId - durable session selected by later presentation work.
   * @param signal - history request deadline or cancellation.
   */
  async reconcileSession(
    sessionId: SessionId,
    signal: AbortSignal = AbortSignal.timeout(30_000),
  ): Promise<void> {
    await this.reconcileWithClient(this.connectedClient(), sessionId, signal)
  }

  /** Answer one pending approval interaction by its server-request id. */
  respondApproval(
    requestId: RpcId,
    payload: ApprovalResponsePayload,
    signal: AbortSignal = AbortSignal.timeout(30_000),
  ): Promise<RpcReceipt> {
    return this.connectedClient().respondApproval(requestId, payload, signal)
  }

  /** Refresh configuration facts displayed beside the connected runtime. */
  async refreshConfiguration(signal: AbortSignal = AbortSignal.timeout(15_000)): Promise<void> {
    if (this.currentState.kind !== 'connected') {
      throw new Error('DSH runtime must be connected before refreshing its configuration')
    }
    const settings = await this.connectedClient().describeSettings(signal)
    this.setState({
      kind: 'connected',
      host: this.currentState.host,
      defaultPermission: defaultPermissionOf(settings),
    })
  }

  private async startInternal(config: RuntimeLaunchConfig, generation: number): Promise<void> {
    this.setState({ kind: 'starting' })
    this.stderrTail = ''
    this.logger.appendLine(`[runtime] starting ${config.command} (${config.args.length} arguments) in ${config.cwd}`)
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.spawner(config.command, config.args, {
        cwd: config.cwd,
        env: config.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error: unknown) {
      const message = `Could not start DSH: ${errorMessage(error)}`
      this.setState({ kind: 'error', message })
      throw new Error(message)
    }

    this.child = child
    this.exitResult = new Promise((resolve) => {
      child.once('exit', (code, signal) => { resolve({ code, signal }) })
    })
    const processFailure: Promise<never> = Promise.race([
      new Promise<never>((_resolve, reject) => { child.once('error', reject) }),
      this.exitResult.then((exit) => {
        throw new Error(`DSH exited before becoming ready with ${describeExit(exit)}`)
      }),
    ])
    child.stderr.on('data', (chunk: Buffer | string) => { this.captureStderr(chunk) })
    const client = new HostProtocolClient(child.stdout, child.stdin)
    this.client = client
    client.start()
    void this.observeExit(child, this.exitResult, generation)
    let failStream: (error: Error) => void = () => {}
    const streamFailure = new Promise<never>((_resolve, reject) => { failStream = reject })

    try {
      await readinessRequest(
        'protocol initialization',
        config.handshakeTimeoutMs,
        signal => client.initialize(this.extensionVersion, signal),
        processFailure,
      )
      this.events.beginConnection()
      const mux = await readinessRequest(
        'mux subscription',
        config.handshakeTimeoutMs,
        signal => client.subscribeMux({}, signal),
        processFailure,
      )
      const hostEvents = await readinessRequest(
        'host subscription',
        config.handshakeTimeoutMs,
        signal => client.subscribeHost(signal),
        processFailure,
      )
      void this.pumpStream(mux, (envelope) => { this.events.acceptMux(envelope) }, failStream)
      void this.pumpStream(hostEvents, (envelope) => { this.events.acceptHost(envelope) }, failStream)
      void streamFailure.catch((error: unknown) => {
        void this.handleStreamFailure(child, generation, error)
      })
      const host = await readinessRequest(
        'Host description',
        config.handshakeTimeoutMs,
        signal => client.describe(signal),
        Promise.race([processFailure, streamFailure]),
      )
      const settings = await readinessRequest(
        'settings description',
        config.handshakeTimeoutMs,
        signal => client.describeSettings(signal),
        Promise.race([processFailure, streamFailure]),
      )
      for (const sessionId of this.events.trackedSessionIds) {
        await this.reconcileWithClient(client, sessionId, AbortSignal.timeout(config.handshakeTimeoutMs))
      }
      if (generation !== this.generation || this.child !== child) throw new Error('DSH start was cancelled')
      this.logger.appendLine(`[runtime] connected to DSH ${host.version}`)
      this.setState({ kind: 'connected', host, defaultPermission: defaultPermissionOf(settings) })
    } catch (error: unknown) {
      if (generation !== this.generation) return
      const detail = this.stderrTail.trim()
      const message = `DSH did not become ready: ${errorMessage(error)}${detail === '' ? '' : ` — ${detail}`}`
      this.setState({ kind: 'error', message })
      await this.terminate(child)
      if (this.child === child) this.clearChild()
      throw new Error(message)
    }
  }

  /** Return the owned client only after the runtime completed its handshake. */
  private connectedClient(): HostProtocolClient {
    if (this.currentState.kind !== 'connected' || this.client === undefined) {
      throw new Error('DSH runtime must be connected before using the Host API')
    }
    return this.client
  }

  private async stopInternal(stopTimeoutMs: number, generation: number): Promise<void> {
    const child = this.child
    const client = this.client
    const exitResult = this.exitResult
    if (child === undefined || exitResult === undefined) {
      this.clearChild()
      this.setState({ kind: 'stopped' })
      return
    }
    this.setState({ kind: 'stopping' })
    this.logger.appendLine('[runtime] stopping DSH')

    if (client !== undefined) {
      try {
        await client.shutdown(AbortSignal.timeout(stopTimeoutMs))
      } catch (error: unknown) {
        this.logger.appendLine(`[runtime] graceful shutdown failed: ${redactDiagnostic(errorMessage(error))}`)
      }
    }
    const exited = await settleBefore(exitResult, stopTimeoutMs)
    if (!exited) {
      this.logger.appendLine('[runtime] graceful shutdown timed out; terminating the child process')
      child.kill()
      await settleBefore(exitResult, Math.min(stopTimeoutMs, 2_000))
    }
    if (this.child === child) this.clearChild()
    if (generation === this.generation) this.setState({ kind: 'stopped' })
  }

  private async observeExit(
    child: ChildProcessWithoutNullStreams,
    result: Promise<ExitResult>,
    generation: number,
  ): Promise<void> {
    const exit = await result
    if (this.child !== child) return
    this.clearChild()
    if (this.currentState.kind !== 'connected' || generation !== this.generation) return
    const detail = this.stderrTail.trim()
    const message = `DSH exited unexpectedly with ${describeExit(exit)}${detail === '' ? '' : ` — ${detail}`}`
    this.logger.appendLine(`[runtime] ${message}`)
    this.setState({ kind: 'error', message })
  }

  private async pumpStream<F extends MuxFrame | HostFrame>(
    subscription: HostSubscription<F>,
    accept: (envelope: RpcRequest<F>) => void,
    fail: (error: Error) => void,
  ): Promise<void> {
    try {
      for await (const envelope of subscription) {
        if (envelope.payload.type === 'stream/error') {
          throw new Error(envelope.payload.error.message)
        }
        accept(envelope)
      }
      fail(new Error(`${subscription.id} ended`))
    } catch (error: unknown) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private async handleStreamFailure(
    child: ChildProcessWithoutNullStreams,
    generation: number,
    error: unknown,
  ): Promise<void> {
    if (error instanceof Error && error.message === 'DSH Host input closed' && this.exitResult !== undefined) {
      const exited = await settleBefore(this.exitResult, 100)
      if (exited) return
    }
    if (this.child !== child || generation !== this.generation || this.currentState.kind !== 'connected') return
    const message = `DSH event stream ended unexpectedly: ${errorMessage(error)}`
    this.logger.appendLine(`[runtime] ${message}`)
    this.setState({ kind: 'error', message })
    this.client?.close()
    child.kill()
  }

  private async reconcileWithClient(
    client: HostProtocolClient,
    sessionId: SessionId,
    signal: AbortSignal,
  ): Promise<void> {
    this.events.beginHistory(sessionId)
    while (true) {
      const history = await client.request('session.history', { sessionId }, signal)
      this.events.seedProjections(sessionId, history.projections)
      if (!this.events.installHistory(sessionId, history.events)) return
    }
  }

  private async terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill()
    if (this.exitResult !== undefined) await settleBefore(this.exitResult, 2_000)
  }

  private captureStderr(chunk: Buffer | string): void {
    const text = redactDiagnostic(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    this.stderrTail = (this.stderrTail + text).slice(-8_192)
    for (const line of text.split(/\r?\n/)) {
      if (line !== '') this.logger.appendLine(`[dsh] ${line}`)
    }
  }

  private clearChild(): void {
    this.client?.close()
    this.client = undefined
    this.child = undefined
    this.exitResult = undefined
  }

  private setState(state: RuntimeState): void {
    this.currentState = state
    for (const listener of this.listeners) {
      try {
        listener(state)
      } catch (error: unknown) {
        this.logger.appendLine(`[extension] state listener failed: ${redactDiagnostic(errorMessage(error))}`)
      }
    }
  }
}

/** Give each startup request an independent deadline and name timeout failures. */
async function readinessRequest<T>(
  subject: string,
  timeoutMs: number,
  request: (signal: AbortSignal) => Promise<T>,
  processFailure: Promise<never>,
): Promise<T> {
  try {
    return await Promise.race([request(AbortSignal.timeout(timeoutMs)), processFailure])
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`${subject} timed out after ${timeoutMs} ms; increase dsh.runtime.handshakeTimeoutMs for slower startup`)
    }
    throw error
  }
}

/** Describe a child-process exit without exposing process arguments. */
function describeExit(exit: ExitResult): string {
  return exit.signal === null ? `code ${String(exit.code)}` : `signal ${exit.signal}`
}

/** Wait for a promise without leaving a rejecting timer task behind. */
async function settleBefore(result: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      result.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => { resolve(false) }, timeoutMs) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Normalize an unknown failure to safe text. */
function errorMessage(error: unknown): string {
  return redactDiagnostic(error instanceof Error ? error.message : String(error))
}

/** Read the profile-owned default permission from a redacted settings view. */
function defaultPermissionOf(settings: SettingsDescription): string {
  const value = settings.namespaces.find(namespace => namespace.ns === 'permission')?.value
  if (!isRecord(value) || typeof value['defaultPreset'] !== 'string') {
    throw new Error('DSH permission settings are unavailable in the vscode profile')
  }
  return value['defaultPreset']
}

/** Narrow an unknown value to a non-array record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
