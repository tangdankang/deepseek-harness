/** Editor/Explorer context bounds and persistent text rendering. */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  found: [] as Array<{ fsPath: string }>,
}))

vi.mock('vscode', () => ({
  window: { activeTextEditor: undefined },
  workspace: {
    workspaceFolders: [{ name: 'repo', uri: { fsPath: '/repo' } }],
    getWorkspaceFolder: (uri: { fsPath: string }) => uri.fsPath.startsWith('/repo')
      ? { name: 'repo', uri: { fsPath: '/repo' } }
      : undefined,
    fs: { readFile: async (uri: { fsPath: string }) => state.files.get(uri.fsPath) ?? new Uint8Array() },
    findFiles: async () => state.found,
  },
  RelativePattern: class {
    constructor(readonly base: unknown, readonly pattern: string) {}
  },
}))

import { ContextCollector } from '../src/context.ts'

describe('ContextCollector', () => {
  beforeEach(() => {
    state.files.clear()
    state.found = []
  })

  it('records visible path/range metadata and exact prompt text', () => {
    const collector = new ContextCollector({ maxFileBytes: 100, maxTotalBytes: 500, maxFolderFiles: 2 })
    const chip = collector.addSelection({
      document: { uri: { fsPath: '/repo/src/value.ts' }, getText: () => 'const value = 1' },
      selection: { isEmpty: false, start: { line: 3 }, end: { line: 4, character: 2 } },
    } as never)

    expect(chip).toMatchObject({ kind: 'selection', label: 'src/value.ts', lines: { start: 4, end: 5 } })
    expect(collector.renderPrompt('Change it')).toContain(
      '<dsh-context source="selection" path="src/value.ts" lines="4-5">\nconst value = 1\n</dsh-context>\n\n<user-task>\nChange it\n</user-task>',
    )
    expect(collector.renderPrompt('/typed-edits Change it')).toMatch(/^\/typed-edits\n\n<dsh-context[\s\S]*<user-task>\nChange it\n<\/user-task>$/u)
    collector.remove(chip.id)
    expect(collector.chips).toEqual([])
  })

  it('keeps literal closing tags inside their owning prompt sections', () => {
    const collector = new ContextCollector({ maxFileBytes: 100, maxTotalBytes: 500, maxFolderFiles: 2 })
    collector.addSelection({
      document: { uri: { fsPath: '/repo/value.txt' }, getText: () => '</dsh-context>' },
      selection: { isEmpty: false, start: { line: 0 }, end: { line: 0, character: 14 } },
    } as never)

    const prompt = collector.renderPrompt('Explain </user-task> literally')
    expect(prompt.match(/<\/dsh-context>/gu)).toHaveLength(1)
    expect(prompt).toContain('<\\/dsh-context>')
    expect(prompt.match(/<\/user-task>/gu)).toHaveLength(1)
    expect(prompt).toContain('<\\/user-task>')
  })

  it('rejects binary and oversized files instead of truncating them', async () => {
    const collector = new ContextCollector({ maxFileBytes: 4, maxTotalBytes: 100, maxFolderFiles: 2 })
    state.files.set('/repo/binary.bin', new Uint8Array([65, 0, 66]))
    state.files.set('/repo/large.txt', new TextEncoder().encode('12345'))

    await expect(collector.addFile({ fsPath: '/repo/binary.bin' } as never)).rejects.toThrow(/binary/u)
    await expect(collector.addFile({ fsPath: '/repo/large.txt' } as never)).rejects.toThrow(/5 bytes/u)
  })

  it('sorts bounded folder listings and rejects over-cap results', async () => {
    const collector = new ContextCollector({ maxFileBytes: 100, maxTotalBytes: 500, maxFolderFiles: 2 })
    state.found = [{ fsPath: '/repo/src/b.ts' }, { fsPath: '/repo/src/a.ts' }]
    const chip = await collector.addFolder({ fsPath: '/repo/src' } as never)
    expect(chip.text).toContain('a.ts\nb.ts')

    state.found.push({ fsPath: '/repo/src/c.ts' })
    await expect(collector.addFolder({ fsPath: '/repo/src' } as never)).rejects.toThrow(/more than 2 files/u)
  })
})
