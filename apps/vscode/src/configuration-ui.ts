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
    title: '配置 OpenAI 兼容模型（1/6）',
    prompt: 'DSH 内部使用的提供方标识',
    value: 'custom-openai',
    placeHolder: 'company-gateway',
    ignoreFocusOut: true,
  })
  if (provider === undefined) return undefined
  const displayName = await vscode.window.showInputBox({
    title: '配置 OpenAI 兼容模型（2/6）',
    prompt: '模型选择器中显示的提供方名称',
    value: provider.trim(),
    ignoreFocusOut: true,
  })
  if (displayName === undefined) return undefined
  const baseURL = await vscode.window.showInputBox({
    title: '配置 OpenAI 兼容模型（3/6）',
    prompt: 'API 基础地址，通常以 /v1 结尾',
    placeHolder: 'https://gateway.example/v1',
    ignoreFocusOut: true,
  })
  if (baseURL === undefined) return undefined
  const model = await vscode.window.showInputBox({
    title: '配置 OpenAI 兼容模型（4/6）',
    prompt: '接口接受的模型 ID',
    placeHolder: 'model-id',
    ignoreFocusOut: true,
  })
  if (model === undefined) return undefined
  const modelDisplayName = await vscode.window.showInputBox({
    title: '配置 OpenAI 兼容模型（5/6）',
    prompt: '模型选择器中显示的模型名称',
    value: model.trim(),
    ignoreFocusOut: true,
  })
  if (modelDisplayName === undefined) return undefined
  const apiKey = await vscode.window.showInputBox({
    title: '配置 OpenAI 兼容模型（6/6）',
    prompt: 'API 密钥将保存到 VS Code 的加密存储中',
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
      title: '设置 DSH 新对话的默认权限',
      placeHolder: '选择以后新对话可以怎样修改工作区',
      ignoreFocusOut: true,
    },
  )
  return selected?.value
}
