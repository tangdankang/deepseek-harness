/** Extension Development Host smoke loaded by VS Code's extension test entry. */

import { strict as assert } from 'node:assert'
import * as vscode from 'vscode'

/** Activate the packaged extension and verify its complete P2 command surface. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('deepseek-ai.dsh-vscode')
  assert.ok(extension, 'DeepSeek Harness extension must be discoverable')
  const manifest: unknown = extension.packageJSON
  assert.ok(isRecord(manifest), 'DeepSeek Harness manifest must be an object')
  const contributes = manifest['contributes']
  assert.ok(isRecord(contributes), 'DeepSeek Harness must contribute workbench UI')
  const viewContainers = contributes['viewsContainers']
  assert.ok(isRecord(viewContainers), 'DeepSeek Harness must contribute a view container')
  const secondary = viewContainers['secondarySidebar']
  assert.ok(Array.isArray(secondary) && secondary.some(item => isRecord(item) && item['id'] === 'dsh-chat-container'),
    'DeepSeek Harness must live in the Secondary Side Bar')
  await extension.activate()
  const commands = await vscode.commands.getCommands(true)
  for (const command of [
    'dsh.start',
    'dsh.stop',
    'dsh.restart',
    'dsh.showOutput',
    'dsh.openSettings',
    'dsh.configureModel',
    'dsh.selectDefaultPermission',
    'dsh.newSession',
    'dsh.addSelection',
    'dsh.addCurrentFile',
    'dsh.addExplorerFile',
    'dsh.addExplorerFolder',
    'dsh.addWorkspaceContext',
    'dsh.createProjectSkill',
    'dsh.createUserSkill',
    'dsh.openSkillsFolder',
  ]) {
    assert.ok(commands.includes(command), `DeepSeek Harness must register ${command}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
