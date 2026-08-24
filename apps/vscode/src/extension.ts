/** VS Code extension entry for the DSH runtime and P2.1 configuration surface. */

import * as vscode from 'vscode'
import { configureModelProvider, loadCredentialEnvironment, setDefaultPermission } from './configuration.ts'
import { collectDefaultPermission, collectModelProviderDraft } from './configuration-ui.ts'
import { runtimeEnvironment } from './environment.ts'
import { RuntimeManager, type RuntimeLaunchConfig, type RuntimeState } from './runtime-manager.ts'
import { DshViewProvider } from './view.ts'

/** Activate the DSH activity-bar view, commands, output, and owned runtime. */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('DeepSeek Harness', { log: true })
  const packageJson: unknown = context.extension.packageJSON
  const version = isRecord(packageJson) && typeof packageJson.version === 'string'
    ? packageJson.version
    : '0.0.0'
  const manager = new RuntimeManager(version, output)
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20)
  status.name = 'DeepSeek Harness'
  status.command = 'dsh.showOutput'
  status.show()

  const run = (operation: () => Promise<void>): void => {
    void operation().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      void vscode.window.showErrorMessage(message, 'Show Output').then((selection) => {
        if (selection === 'Show Output') output.show(true)
      })
    })
  }
  const readConfig = (): Promise<RuntimeLaunchConfig> => readLaunchConfig(context.secrets)
  const commands = {
    start: (): void => { run(async () => { await manager.start(await readConfig()) }) },
    stop: (): void => { run(() => manager.stop(readStopTimeout())) },
    restart: (): void => { run(async () => { await manager.restart(await readConfig()) }) },
    showOutput: (): void => { output.show(true) },
    openSettings: (): void => {
      void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:deepseek-ai.dsh-vscode dsh.runtime')
    },
    configureModel: (): void => {
      run(async () => {
        const draft = await collectModelProviderDraft()
        if (draft === undefined) return
        await manager.start(await readConfig())
        const configured = await configureModelProvider(manager, context.secrets, draft)
        await manager.restart(await readConfig())
        await vscode.window.showInformationMessage(
          `Configured ${configured.provider}/${configured.model}. New sessions use this model.`,
        )
      })
    },
    defaultPermission: (): void => {
      run(async () => {
        const mode = await collectDefaultPermission()
        if (mode === undefined) return
        await manager.start(await readConfig())
        await setDefaultPermission(manager, mode)
        await manager.refreshConfiguration()
        await vscode.window.showInformationMessage(`Default DSH permission set to ${mode} for new sessions.`)
      })
    },
  }
  const provider = new DshViewProvider((command) => { commands[command]() }, manager.state)
  const updateState = (state: RuntimeState): void => {
    provider.setState(state)
    status.text = statusText(state)
    status.tooltip = state.kind === 'error' ? state.message : 'DeepSeek Harness runtime'
  }
  updateState(manager.state)

  context.subscriptions.push(
    output,
    status,
    vscode.window.registerWebviewViewProvider('dsh.chat', provider),
    vscode.commands.registerCommand('dsh.start', commands.start),
    vscode.commands.registerCommand('dsh.stop', commands.stop),
    vscode.commands.registerCommand('dsh.restart', commands.restart),
    vscode.commands.registerCommand('dsh.showOutput', commands.showOutput),
    vscode.commands.registerCommand('dsh.openSettings', commands.openSettings),
    vscode.commands.registerCommand('dsh.configureModel', commands.configureModel),
    vscode.commands.registerCommand('dsh.selectDefaultPermission', commands.defaultPermission),
    { dispose: manager.onStateChange(updateState) },
    { dispose: () => { void manager.stop(readStopTimeout()) } },
  )

  if (vscode.workspace.getConfiguration('dsh.runtime').get<boolean>('startOnOpen', false)) commands.start()
}

/** Narrow VS Code manifest data before reading it. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Resolve the stop deadline without requiring otherwise unrelated launch settings. */
function readStopTimeout(): number {
  return vscode.workspace.getConfiguration('dsh.runtime').get<number>('stopTimeoutMs', 5_000)
}

/** Resolve and validate one launch from current workspace settings. */
async function readLaunchConfig(secrets: vscode.SecretStorage): Promise<RuntimeLaunchConfig> {
  const settings = vscode.workspace.getConfiguration('dsh.runtime')
  const command = settings.get<string>('command', 'dsh').trim()
  if (command === '') throw new Error('DSH runtime command must not be empty')
  const args = settings.get<string[]>('args', ['--profile', 'vscode'])
  const configuredCwd = settings.get<string>('cwd', '').trim()
  const cwd = configuredCwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()
  return {
    command,
    args,
    cwd,
    env: runtimeEnvironment(process.env, await loadCredentialEnvironment(secrets)),
    handshakeTimeoutMs: settings.get<number>('handshakeTimeoutMs', 15_000),
    stopTimeoutMs: settings.get<number>('stopTimeoutMs', 5_000),
  }
}

/** Compact status-bar text for each lifecycle state. */
function statusText(state: RuntimeState): string {
  switch (state.kind) {
    case 'stopped': return '$(circle-slash) DSH'
    case 'starting': return '$(sync~spin) DSH starting'
    case 'connected': return '$(pass-filled) DSH'
    case 'stopping': return '$(sync~spin) DSH stopping'
    case 'error': return '$(error) DSH'
    default:
      state satisfies never
      return 'DSH'
  }
}
