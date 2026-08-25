/** Safe project/user Skill skeleton creation tests. */

import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

const shown = vi.hoisted(() => vi.fn())
vi.mock('vscode', () => ({
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  workspace: {
    openTextDocument: async (uri: unknown) => uri,
    createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {} }),
  },
  window: { showTextDocument: shown, showQuickPick: vi.fn() },
  commands: { executeCommand: vi.fn() },
  RelativePattern: class {
    constructor(readonly base: string, readonly pattern: string) {}
  },
  Disposable: { from: (...values: unknown[]) => ({ dispose: () => values }) },
}))

import { SkillFiles, skillRoots, validateSkillName } from '../src/skills.ts'

const temporary: string[] = []
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true })
})

describe('SkillFiles', () => {
  it('resolves project and user scopes independently', () => {
    expect(skillRoots('/repo', { DSH_HOME: '/dsh-home' })).toEqual({
      project: join('/repo', '.agents', 'skills'),
      user: join('/dsh-home', 'skills'),
    })
  })

  it('creates the exact skeleton and refuses to overwrite it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-vscode-skills-'))
    temporary.push(root)
    const files = new SkillFiles({ project: join(root, 'project'), user: join(root, 'user') })
    const uri = await files.create('project', 'typed-edits')

    expect(await readFile(uri.fsPath, 'utf8')).toBe(
      '---\nname: typed-edits\ndescription: Describe when this Skill should be used.\n---\n\n# typed-edits\n\nWrite the reusable workflow here.\n',
    )
    await expect(files.create('project', 'typed-edits')).rejects.toThrow(/already exists/u)
    expect(await readFile(uri.fsPath, 'utf8')).toContain('Write the reusable workflow here.')
  })

  it('rejects names outside lowercase kebab-case', () => {
    expect(() => { validateSkillName('Bad Name') }).toThrow(/kebab-case/u)
    expect(() => { validateSkillName('good-name') }).not.toThrow()
  })
})
