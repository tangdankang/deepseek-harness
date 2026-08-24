/** Keyless snapshot coverage for the P1 sidebar surface. */

import type * as vscode from 'vscode'
import { describe, expect, it, vi } from 'vitest'
import { DshViewProvider } from '../src/view.ts'

describe('DshViewProvider', () => {
  it('renders the runtime lifecycle controls and initial status', () => {
    const receive = vi.fn()
    const webview = {
      cspSource: 'vscode-webview:',
      html: '',
      options: {},
      onDidReceiveMessage: receive,
      postMessage: vi.fn(),
    }
    const view = { webview } as unknown as vscode.WebviewView
    const provider = new DshViewProvider(vi.fn(), { kind: 'stopped' })

    provider.resolveWebviewView(view)

    expect(webview.html.replaceAll(/[A-Za-z0-9]{32}/g, '<nonce>')).toMatchSnapshot()
    expect(receive).toHaveBeenCalledOnce()
  })
})
