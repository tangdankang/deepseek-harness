/** VS Code input controls for P2.1 provider and permission configuration. */

import * as vscode from 'vscode'
import {
  PERMISSION_MODES,
  type ModelProviderDraft,
  type PermissionMode,
} from './configuration.ts'

interface PermissionQuickPick extends vscode.QuickPickItem {
  /** Stable permission value written to DSH settings. */
  value: PermissionMode
}

/**
 * Collect one OpenAI-compatible provider without persisting or logging values.
 * @returns the completed draft, or undefined when the user cancels any step.
 */
export async function collectModelProviderDraft(): Promise<ModelProviderDraft | undefined> {
  const provider = await vscode.window.showInputBox({
    title: 'Configure OpenAI-compatible model (1/6)',
    prompt: 'Provider route used inside DSH',
    value: 'custom-openai',
    placeHolder: 'company-gateway',
    ignoreFocusOut: true,
  })
  if (provider === undefined) return undefined
  const displayName = await vscode.window.showInputBox({
    title: 'Configure OpenAI-compatible model (2/6)',
    prompt: 'Provider name shown in model selectors',
    value: provider.trim(),
    ignoreFocusOut: true,
  })
  if (displayName === undefined) return undefined
  const baseURL = await vscode.window.showInputBox({
    title: 'Configure OpenAI-compatible model (3/6)',
    prompt: 'API base URL, usually ending in /v1',
    placeHolder: 'https://gateway.example/v1',
    ignoreFocusOut: true,
  })
  if (baseURL === undefined) return undefined
  const model = await vscode.window.showInputBox({
    title: 'Configure OpenAI-compatible model (4/6)',
    prompt: 'Model ID accepted by the endpoint',
    placeHolder: 'model-id',
    ignoreFocusOut: true,
  })
  if (model === undefined) return undefined
  const modelDisplayName = await vscode.window.showInputBox({
    title: 'Configure OpenAI-compatible model (5/6)',
    prompt: 'Model name shown in selectors',
    value: model.trim(),
    ignoreFocusOut: true,
  })
  if (modelDisplayName === undefined) return undefined
  const apiKey = await vscode.window.showInputBox({
    title: 'Configure OpenAI-compatible model (6/6)',
    prompt: 'API key stored in VS Code SecretStorage',
    password: true,
    ignoreFocusOut: true,
  })
  if (apiKey === undefined) return undefined
  return { provider, displayName, baseURL, model, modelDisplayName, apiKey }
}

/**
 * Ask for the default permission of future VS Code sessions.
 * @returns the selected stable mode, or undefined when cancelled.
 */
export async function collectDefaultPermission(): Promise<PermissionMode | undefined> {
  const items: PermissionQuickPick[] = PERMISSION_MODES.map(mode => ({
    label: mode.label,
    ...mode.value === 'confirm-changes' ? { description: '推荐' } : {},
    detail: mode.description,
    value: mode.value,
  }))
  const selected = await vscode.window.showQuickPick<PermissionQuickPick>(
    items,
    {
      title: 'DSH default permission for new sessions',
      placeHolder: 'Choose how future sessions may change the workspace',
      ignoreFocusOut: true,
    },
  )
  return selected?.value
}
