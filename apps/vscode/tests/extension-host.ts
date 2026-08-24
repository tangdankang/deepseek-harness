/** Extension Development Host smoke loaded by VS Code's extension test entry. */

import { strict as assert } from 'node:assert'
import * as vscode from 'vscode'

/** Activate the packaged extension and verify its P1 command surface. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('deepseek-ai.dsh-vscode')
  assert.ok(extension, 'DeepSeek Harness extension must be discoverable')
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
  ]) {
    assert.ok(commands.includes(command), `DeepSeek Harness must register ${command}`)
  }
}
