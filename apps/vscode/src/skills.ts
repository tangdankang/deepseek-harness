/** Safe local Skill locations and skeleton creation for the VS Code client. */

import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as vscode from 'vscode'

/** Skill storage owned by the current project or the current Harness user. */
export type SkillScope = 'project' | 'user'

/** Local Skill roots displayed by VS Code. */
export interface SkillRoots {
  /** Shared project workflow directory. */
  project: string
  /** Cross-project user workflow directory. */
  user: string
}

/** Resolve the two approved filesystem Skill roots. */
export function skillRoots(workspacePath: string, env: NodeJS.ProcessEnv = process.env): SkillRoots {
  const dshHome = env['DSH_HOME']?.trim() || join(homedir(), '.dsh')
  return {
    project: join(workspacePath, '.agents', 'skills'),
    user: join(dshHome, 'skills'),
  }
}

/** Create and open exact non-overwriting Skill skeletons. */
export class SkillFiles {
  /** @param roots - resolved local roots. */
  constructor(readonly roots: SkillRoots) {}

  /**
   * Create one previously absent Skill directory and SKILL.md.
   * @param scope - project or user storage.
   * @param name - kebab-case Skill id.
   * @returns the created document URI.
   */
  async create(scope: SkillScope, name: string): Promise<vscode.Uri> {
    validateSkillName(name)
    const root = this.roots[scope]
    await mkdir(root, { recursive: true })
    const directory = join(root, name)
    try {
      await mkdir(directory)
    } catch (error: unknown) {
      if (isNodeError(error, 'EEXIST')) throw new Error(`Skill "${name}" already exists in ${scope} scope`)
      throw error
    }
    const target = join(directory, 'SKILL.md')
    await writeFile(target, skeleton(name), { encoding: 'utf8', flag: 'wx' })
    const uri = vscode.Uri.file(target)
    const document = await vscode.workspace.openTextDocument(uri)
    await vscode.window.showTextDocument(document)
    return uri
  }

  /** Let the user choose and reveal an approved Skill root. */
  async openRoot(): Promise<void> {
    const selected = await vscode.window.showQuickPick([
      { label: 'Project Skills', description: this.roots.project, path: this.roots.project },
      { label: 'User Skills', description: this.roots.user, path: this.roots.user },
    ], { placeHolder: 'Choose a Skill folder' })
    if (selected === undefined) return
    await mkdir(selected.path, { recursive: true })
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(selected.path))
  }

  /** Watch both roots for hot catalog refresh. */
  watch(onChange: () => void): vscode.Disposable {
    const watchers = [this.roots.project, this.roots.user].map((root) => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '*/SKILL.md'))
      watcher.onDidCreate(onChange)
      watcher.onDidChange(onChange)
      watcher.onDidDelete(onChange)
      return watcher
    })
    return vscode.Disposable.from(...watchers)
  }
}

/** Validate the shared user-visible Skill identifier. */
export function validateSkillName(name: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) {
    throw new Error('Skill name must use lowercase kebab-case')
  }
}

function skeleton(name: string): string {
  return `---\nname: ${name}\ndescription: Describe when this Skill should be used.\n---\n\n# ${name}\n\nWrite the reusable workflow here.\n`
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
