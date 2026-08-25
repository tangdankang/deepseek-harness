/** VS Code extension entry for the complete P2 local coding loop. */

import * as vscode from 'vscode'
import { configureModelProvider, loadCredentialEnvironment, setDefaultPermission } from './configuration.ts'
import { collectDefaultPermission, collectModelProviderDraft } from './configuration-ui.ts'
import { ContextCollector } from './context.ts'
import { ConversationController } from './conversation.ts'
import { runtimeEnvironment } from './environment.ts'
import { resolveRuntimeCwd, RuntimeManager, type RuntimeLaunchConfig, type RuntimeState } from './runtime-manager.ts'
import { SkillFiles, skillRoots, type SkillScope } from './skills.ts'
import { DshViewProvider, type ViewAction, type ViewCommand } from './view.ts'

const SECONDARY_SIDEBAR_SHOWN_KEY = 'dsh.secondarySidebarShown'

/** Activate the DSH conversation, commands, output, and owned runtime. */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('DeepSeek Harness', { log: true })
  const packageJson: unknown = context.extension.packageJSON
  const version = isRecord(packageJson) && typeof packageJson.version === 'string' ? packageJson.version : '0.0.0'
  const manager = new RuntimeManager(version, output)
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
  const contextCollector = new ContextCollector(readContextLimits())
  const skillFiles = new SkillFiles(skillRoots(workspacePath))
  const controller = new ConversationController(manager, context.workspaceState, contextCollector, skillFiles, readConversationLimits())
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20)
  status.name = 'DeepSeek Harness'
  status.command = 'dsh.showOutput'
  status.show()

  const report = (operation: () => Promise<void>): void => {
    void operation().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      void vscode.window.showErrorMessage(message, '查看输出').then((selection) => {
        if (selection === '查看输出') output.show(true)
      })
    })
  }
  const readConfig = (): Promise<RuntimeLaunchConfig> => readLaunchConfig(context.secrets)
  const start = async (): Promise<void> => { await manager.start(await readConfig()) }
  const withRuntime = async (operation: () => Promise<void>): Promise<void> => {
    await start()
    await operation()
  }
  const createSkill = async (scope: SkillScope): Promise<void> => {
    const name = await vscode.window.showInputBox({
      title: scope === 'project' ? '创建项目 Skill' : '创建用户 Skill',
      prompt: '请输入小写 kebab-case 格式的 Skill 名称',
      validateInput: value => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) ? undefined : '请使用小写 kebab-case 格式',
    })
    if (name === undefined) return
    await skillFiles.create(scope, name)
    await controller.refreshSkills()
  }

  let skillRefreshTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleSkillRefresh = (): void => {
    if (skillRefreshTimer !== undefined) clearTimeout(skillRefreshTimer)
    skillRefreshTimer = setTimeout(() => {
      skillRefreshTimer = undefined
      void controller.refreshSkills().catch((error: unknown) => {
        output.appendLine(`[extension] Skill catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, 100)
  }

  const dispatch = (action: ViewAction): void => {
    report(async () => {
      switch (action.type) {
        case 'command':
          await dispatchCommand(action.command)
          break
        case 'newSession':
          await withRuntime(async () => { await controller.newSession((await readConfig()).cwd) })
          break
        case 'selectSession':
          await controller.selectSession(action.sessionId)
          break
        case 'loadOlder':
          await controller.loadOlder()
          break
        case 'prompt':
          await controller.prompt(action.text)
          provider.clearPrompt()
          break
        case 'cancel':
          await controller.cancel()
          break
        case 'selectPermission':
          await controller.selectPermission(action.value)
          break
        case 'selectModel':
          await controller.selectModel(action.value)
          break
        case 'removeContext':
          controller.removeContext(action.id)
          break
        case 'openDiff':
          await controller.openApprovalPreview(action.id)
          break
        case 'allowApproval':
          await controller.allowApproval(action.id)
          break
        case 'rejectApproval':
          await controller.rejectApproval(action.id)
          break
        default:
          action satisfies never
      }
    })
  }

  const dispatchCommand = async (command: ViewCommand): Promise<void> => {
    switch (command) {
      case 'start': await start(); break
      case 'stop': await manager.stop(readStopTimeout()); break
      case 'restart': await manager.restart(await readConfig()); break
      case 'showOutput': output.show(true); break
      case 'openSettings': await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:deepseek-ai.dsh-vscode dsh.runtime'); break
      case 'configureModel': await configureModel(); break
      case 'selectDefaultPermission': await selectFuturePermission(); break
      case 'addSelection': contextCollector.addSelection(); controller.contextChanged(); break
      case 'addCurrentFile': await contextCollector.addCurrentFile(); controller.contextChanged(); break
      case 'addWorkspace': await contextCollector.addWorkspace(); controller.contextChanged(); break
      case 'createProjectSkill': await createSkill('project'); break
      case 'createUserSkill': await createSkill('user'); break
      case 'openSkills': await skillFiles.openRoot(); break
      default: command satisfies never
    }
  }

  const configureModel = async (): Promise<void> => {
    const draft = await collectModelProviderDraft()
    if (draft === undefined) return
    await start()
    const configured = await configureModelProvider(manager, context.secrets, draft)
    await manager.restart(await readConfig())
    await vscode.window.showInformationMessage(`已保存模型 ${configured.provider}/${configured.model}，新对话会使用此模型。`)
  }

  const selectFuturePermission = async (): Promise<void> => {
    const mode = await collectDefaultPermission()
    if (mode === undefined) return
    await start()
    await setDefaultPermission(manager, mode)
    await manager.refreshConfiguration()
    await vscode.window.showInformationMessage(`已保存新对话的默认 DSH 权限：${mode}。`)
  }

  const provider = new DshViewProvider(dispatch, controller.model)
  const updateState = (state: RuntimeState): void => {
    status.text = statusText(state)
    status.tooltip = state.kind === 'error' ? state.message : 'DeepSeek Harness runtime'
    void controller.setRuntimeState(state).catch((error: unknown) => {
      output.appendLine(`[extension] conversation refresh failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  updateState(manager.state)

  const addFileContext = async (uri: vscode.Uri | undefined): Promise<void> => {
    if (uri === undefined) await contextCollector.addCurrentFile()
    else await contextCollector.addFile(uri)
    controller.contextChanged()
  }
  const addFolderContext = async (uri: vscode.Uri | undefined): Promise<void> => {
    if (uri === undefined) throw new Error('Select an Explorer folder before adding folder context')
    await contextCollector.addFolder(uri)
    controller.contextChanged()
  }

  context.subscriptions.push(
    output,
    status,
    controller,
    skillFiles.watch(scheduleSkillRefresh),
    controller.onDidChange((model) => { provider.setModel(model) }),
    vscode.window.registerWebviewViewProvider('dsh.chat', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('dsh.start', () => { report(start) }),
    vscode.commands.registerCommand('dsh.stop', () => { report(() => manager.stop(readStopTimeout())) }),
    vscode.commands.registerCommand('dsh.restart', () => { report(async () => { await manager.restart(await readConfig()) }) }),
    vscode.commands.registerCommand('dsh.showOutput', () => { output.show(true) }),
    vscode.commands.registerCommand('dsh.openSettings', () => { void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:deepseek-ai.dsh-vscode dsh.runtime') }),
    vscode.commands.registerCommand('dsh.configureModel', () => { report(configureModel) }),
    vscode.commands.registerCommand('dsh.selectDefaultPermission', () => { report(selectFuturePermission) }),
    vscode.commands.registerCommand('dsh.newSession', () => { dispatch({ type: 'newSession' }) }),
    vscode.commands.registerCommand('dsh.addSelection', () => { report(() => { contextCollector.addSelection(); controller.contextChanged(); return Promise.resolve() }) }),
    vscode.commands.registerCommand('dsh.addCurrentFile', (uri?: vscode.Uri) => { report(() => addFileContext(uri)) }),
    vscode.commands.registerCommand('dsh.addExplorerFile', (uri?: vscode.Uri) => { report(() => addFileContext(uri)) }),
    vscode.commands.registerCommand('dsh.addExplorerFolder', (uri?: vscode.Uri) => { report(() => addFolderContext(uri)) }),
    vscode.commands.registerCommand('dsh.addWorkspaceContext', () => { report(async () => { await contextCollector.addWorkspace(); controller.contextChanged() }) }),
    vscode.commands.registerCommand('dsh.createProjectSkill', () => { report(() => createSkill('project')) }),
    vscode.commands.registerCommand('dsh.createUserSkill', () => { report(() => createSkill('user')) }),
    vscode.commands.registerCommand('dsh.openSkillsFolder', () => { report(() => skillFiles.openRoot()) }),
    { dispose: manager.onStateChange(updateState) },
    { dispose: () => {
      if (skillRefreshTimer !== undefined) clearTimeout(skillRefreshTimer)
      void manager.stop(readStopTimeout())
    } },
  )

  if (vscode.workspace.getConfiguration('dsh.runtime').get<boolean>('startOnOpen', false)) report(start)
  if (!context.workspaceState.get<boolean>(SECONDARY_SIDEBAR_SHOWN_KEY, false)) {
    report(async () => {
      await vscode.commands.executeCommand('dsh.chat.focus')
      await context.workspaceState.update(SECONDARY_SIDEBAR_SHOWN_KEY, true)
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readStopTimeout(): number {
  return vscode.workspace.getConfiguration('dsh.runtime').get<number>('stopTimeoutMs', 5_000)
}

async function readLaunchConfig(secrets: vscode.SecretStorage): Promise<RuntimeLaunchConfig> {
  const settings = vscode.workspace.getConfiguration('dsh.runtime')
  const command = settings.get<string>('command', 'dsh').trim()
  if (command === '') throw new Error('DSH runtime command must not be empty')
  const args = settings.get<string[]>('args', ['--profile', 'vscode'])
  const configuredCwd = settings.get<string>('cwd', '').trim()
  const cwd = resolveRuntimeCwd(configuredCwd, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)
  return {
    command,
    args,
    cwd,
    env: runtimeEnvironment(process.env, await loadCredentialEnvironment(secrets)),
    handshakeTimeoutMs: settings.get<number>('handshakeTimeoutMs', 15_000),
    stopTimeoutMs: settings.get<number>('stopTimeoutMs', 5_000),
  }
}

function readContextLimits(): ConstructorParameters<typeof ContextCollector>[0] {
  const settings = vscode.workspace.getConfiguration('dsh.context')
  return {
    maxFileBytes: settings.get<number>('maxFileBytes', 131_072),
    maxTotalBytes: settings.get<number>('maxTotalBytes', 524_288),
    maxFolderFiles: settings.get<number>('maxFolderFiles', 200),
  }
}

function readConversationLimits(): ConstructorParameters<typeof ConversationController>[4] {
  const settings = vscode.workspace.getConfiguration('dsh.conversation')
  return {
    historyPageMessages: settings.get<number>('historyPageMessages', 40),
    maxToolOutputChars: settings.get<number>('maxToolOutputChars', 16_000),
    maxDiffBytes: settings.get<number>('maxDiffBytes', 524_288),
  }
}

function statusText(state: RuntimeState): string {
  switch (state.kind) {
    case 'stopped': return '$(circle-slash) DSH'
    case 'starting': return '$(sync~spin) DSH 正在启动'
    case 'connected': return '$(pass-filled) DSH'
    case 'stopping': return '$(sync~spin) DSH 正在停止'
    case 'error': return '$(error) DSH'
    default: state satisfies never; return 'DSH'
  }
}
