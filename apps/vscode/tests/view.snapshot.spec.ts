/** Keyless product-visible snapshot coverage for the assembled P2 conversation. */

import type * as vscode from 'vscode'
import { Script } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { DshViewProvider } from '../src/view.ts'

describe('DshViewProvider', () => {
  it('renders sessions, transcript, context, Skills, and approval controls', () => {
    const receive = vi.fn()
    const webview = {
      cspSource: 'vscode-webview:',
      html: '',
      options: {},
      onDidReceiveMessage: receive,
      postMessage: vi.fn(),
    }
    const view = { webview, onDidDispose: vi.fn() } as unknown as vscode.WebviewView
    const provider = new DshViewProvider(vi.fn(), {
      runtime: {
        kind: 'connected',
        host: { version: '0.1.0', cwd: 'C:\\repo', provider: 'fixture', model: 'model', attachedSessions: 1, canOpenPath: true },
        defaultPermission: 'confirm-changes',
      },
      sessions: [{ id: 'session-1', title: 'P2 coding loop', cwd: 'C:\\repo', running: true }],
      activeSessionId: 'session-1',
      transcript: [
        { kind: 'message', seq: 1, role: 'user', text: 'Update src/value.ts' },
        { kind: 'message', seq: 2, role: 'assistant', text: 'I will inspect the file.', html: '<p>I will inspect the file.</p>' },
        { kind: 'tool', seq: 3, callId: 'call-read', name: 'read', title: 'Read src/value.ts', card: 'generic', status: 'completed', detail: 'const value = 1' },
        { kind: 'tool', seq: 4, callId: 'call-edit', name: 'edit', title: 'Edit src/value.ts', card: 'diff', status: 'running' },
      ],
      hasMore: true,
      reconciling: false,
      running: true,
      permission: {
        current: 'confirm-changes',
        options: [
          { value: 'read-only', name: 'Read-only' },
          { value: 'confirm-changes', name: 'Confirm changes' },
          { value: 'workspace-write', name: 'Workspace writes' },
        ],
      },
      models: { current: 'fixture\u0000model', routable: true, options: [{ value: 'fixture\u0000model', label: 'Fixture / Model' }] },
      skills: [{ name: 'typed-edits', description: 'Make typed edits.', modelInvocable: true }],
      context: [{ id: 'context-1', kind: 'selection', label: 'src/value.ts', lines: { start: 1, end: 1 }, text: 'context', bytes: 7 }],
      approvals: [{
        approvalId: 'approval-1', requestId: 'rpc-1', toolName: 'edit', title: 'Edit src/value.ts',
        kind: 'diff', detail: 'src/value.ts', allowEnabled: true, previewId: 'preview-1', reason: 'write access',
      }],
      queued: 1,
    })

    provider.resolveWebviewView(view)

    const stableHtml = webview.html
      .replaceAll(/nonce-[A-Za-z0-9_-]+/gu, 'nonce-<nonce>')
      .replaceAll(/nonce="[A-Za-z0-9_-]+"/gu, 'nonce="<nonce>"')
    expect(stableHtml).toMatchSnapshot()
    expect(receive).toHaveBeenCalledOnce()
    const script = webview.html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/u)?.[1]
    expect(script).toBeDefined()
    expect(() => new Script(script)).not.toThrow()
  })
})
