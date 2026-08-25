/** Keyless assembled stdio-to-Webview P2 coding-loop snapshot. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const vscodeState = vi.hoisted(() => ({ workspaceRoot: '' }))

vi.mock('vscode', () => {
  class Uri {
    constructor(readonly scheme: string, readonly path: string, readonly fsPath: string) {}
    static file(path: string): Uri { return new Uri('file', path, path) }
    static from(value: { scheme: string; path: string }): Uri { return new Uri(value.scheme, value.path, value.path) }
    toString(): string { return `${this.scheme}:${this.path}` }
  }
  class FileSystemError extends Error {
    constructor(message: string, readonly code: string) { super(message) }
  }
  return {
    Uri,
    FileSystemError,
    workspace: {
      getWorkspaceFolder: () => ({ name: 'workspace', uri: { fsPath: vscodeState.workspaceRoot } }),
      registerTextDocumentContentProvider: () => ({ dispose() {} }),
      fs: {
        readFile: async (uri: { fsPath: string }) => {
          try { return await readFile(uri.fsPath) } catch { throw new FileSystemError('missing', 'FileNotFound') }
        },
      },
    },
    commands: { executeCommand: vi.fn() },
  }
})

import { ConversationController } from '../src/conversation.ts'
import { ContextCollector } from '../src/context.ts'
import { RuntimeManager } from '../src/runtime-manager.ts'

const temporary: string[] = []
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true })
})

describe('assembled P2 conversation flow', () => {
  it('records context and Skill text, rejection, one-shot approval, tool lifecycle, and recovery', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'dsh-vscode-flow-'))
    vscodeState.workspaceRoot = workspace
    temporary.push(workspace)
    await writeFile(resolve(workspace, 'value.txt'), 'alpha\n')
    const manager = new RuntimeManager('0.1.0', { appendLine() {} })
    const context = new ContextCollector({ maxFileBytes: 2_000, maxTotalBytes: 5_000, maxFolderFiles: 10 })
    const controller = new ConversationController(manager, {
      get: () => 'fixture-session', update: async () => {},
    } as never, context, {} as never, {
      historyPageMessages: 20, maxToolOutputChars: 2_000, maxDiffBytes: 2_000,
    })
    try {
      await manager.start({
        command: process.execPath,
        args: [resolve('apps/vscode/tests/fixtures/stdio-host.mjs')],
        cwd: workspace,
        env: { ...process.env },
        handshakeTimeoutMs: 5_000,
        stopTimeoutMs: 2_000,
      })
      await controller.setRuntimeState(manager.state)
      context.addSelection({
        document: { uri: { fsPath: resolve(workspace, 'value.txt') }, getText: () => 'alpha' },
        selection: { isEmpty: false, start: { line: 0 }, end: { line: 0, character: 5 } },
      } as never)
      controller.contextChanged()
      await controller.prompt('/fixture-skill Replace alpha with beta')
      await waitFor(() => controller.model.approvals.some(item => item.approvalId === 'fixture-approval-1' && item.kind === 'diff'))
      const beforeReject = evidence(controller)
      await controller.rejectApproval('fixture-approval-1')
      await waitFor(() => controller.model.approvals.length === 0 && controller.model.transcript.some(item =>
        item.kind === 'message' && item.text === 'The reviewed change was not applied.'))
      const afterReject = evidence(controller)
      expect(await readFile(resolve(workspace, 'value.txt'), 'utf8')).toBe('alpha\n')

      await controller.prompt('Try the same reviewed edit again')
      await waitFor(() => controller.model.approvals.some(item => item.approvalId === 'fixture-approval-2' && item.kind === 'diff'))
      await controller.allowApproval('fixture-approval-2')
      await waitFor(() => controller.model.approvals.length === 0 && controller.model.transcript.some(item =>
        item.kind === 'message' && item.text === 'The reviewed change was applied.'))
      const afterAllow = evidence(controller)

      expect({ beforeReject, afterReject, afterAllow, file: await readFile(resolve(workspace, 'value.txt'), 'utf8') }).toMatchSnapshot()
      expect(JSON.stringify(afterAllow)).not.toContain('fixture-private-reasoning')
    } finally {
      controller.dispose()
      await manager.stop(2_000)
    }
  }, 20_000)
})

function evidence(controller: ConversationController): unknown {
  const model = controller.model
  return {
    session: model.sessions.map(item => ({ title: item.title, running: item.running })),
    permission: model.permission?.current,
    model: model.models.current?.replace('\u0000', '/'),
    skills: model.skills.map(item => item.name),
    contextCount: model.context.length,
    transcript: model.transcript.map((item) => {
      if (item.kind === 'message') return { kind: item.kind, role: item.role, text: item.text, reasoning: item.reasoning ?? false }
      if (item.kind === 'tool') return { kind: item.kind, name: item.name, card: item.card, status: item.status, detail: item.detail }
      return item
    }),
    approvals: model.approvals.map(item => ({
      toolName: item.toolName, kind: item.kind, detail: item.detail, allowEnabled: item.allowEnabled,
    })),
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the assembled fixture state')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
