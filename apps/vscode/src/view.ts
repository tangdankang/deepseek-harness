/** Minimal P1 sidebar for runtime connection control and status. */

import type * as vscode from 'vscode'
import type { RuntimeState } from './runtime-manager.ts'

/** Commands emitted by the sidebar webview. */
type ViewCommand = 'start' | 'stop' | 'restart' | 'showOutput' | 'openSettings'
  | 'configureModel' | 'defaultPermission'

/**
 * Webview provider for the DSH activity-bar view. P1 renders runtime state and
 * lifecycle controls only; conversation content arrives in P2.
 */
export class DshViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined

  /**
   * @param command - trusted command dispatcher.
   * @param state - initial runtime state.
   */
  constructor(
    private readonly command: (command: ViewCommand) => void,
    private state: RuntimeState,
  ) {}

  /** Update the rendered runtime state. */
  setState(state: RuntimeState): void {
    this.state = state
    void this.view?.webview.postMessage({ type: 'state', state })
  }

  /** Configure one newly resolved VS Code webview. */
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true }
    view.webview.html = this.html(view.webview)
    view.webview.onDidReceiveMessage((message: unknown) => {
      if (!isRecord(message) || message.type !== 'command' || !isViewCommand(message.command)) return
      this.command(message.command)
    })
  }

  private html(webview: vscode.Webview): string {
    const nonce = nonceValue()
    const initial = JSON.stringify(this.state).replaceAll('<', '\\u003c')
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    body { padding: 16px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); }
    .status { display: flex; align-items: center; gap: 8px; margin: 8px 0 14px; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
    .connected .dot { background: var(--vscode-testing-iconPassed); }
    .error .dot { background: var(--vscode-testing-iconFailed); }
    .detail { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 16px; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 7px 10px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button:disabled { opacity: .55; cursor: default; }
    h2 { font-size: 14px; font-weight: 600; margin: 0; }
  </style>
</head>
<body>
  <h2>DeepSeek Harness</h2>
  <div id="status"></div>
  <div class="actions">
    <button id="start">Start</button>
    <button id="stop" class="secondary">Stop</button>
    <button id="restart" class="secondary">Restart</button>
    <button id="output" class="secondary">Output</button>
  </div>
  <p><button id="settings" class="secondary">Runtime Settings</button></p>
  <p><button id="model">Configure Model</button></p>
  <p><button id="permission" class="secondary">Default Permission</button></p>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const send = command => vscode.postMessage({ type: 'command', command });
    document.getElementById('start').onclick = () => send('start');
    document.getElementById('stop').onclick = () => send('stop');
    document.getElementById('restart').onclick = () => send('restart');
    document.getElementById('output').onclick = () => send('showOutput');
    document.getElementById('settings').onclick = () => send('openSettings');
    document.getElementById('model').onclick = () => send('configureModel');
    document.getElementById('permission').onclick = () => send('defaultPermission');
    const render = state => {
      const root = document.getElementById('status');
      const label = { stopped: 'Stopped', starting: 'Starting…', connected: 'Connected', stopping: 'Stopping…', error: 'Connection failed' }[state.kind];
      let detail = '';
      if (state.kind === 'connected') {
        const model = state.host.provider && state.host.model ? state.host.provider + '/' + state.host.model : 'Not configured';
        detail = 'DSH ' + state.host.version + '<br>' + escapeHtml(state.host.cwd)
          + '<br>Model: ' + escapeHtml(model)
          + '<br>Default permission: ' + escapeHtml(state.defaultPermission);
      }
      if (state.kind === 'error') detail = escapeHtml(state.message);
      root.innerHTML = '<div class="status ' + state.kind + '"><span class="dot"></span><strong>' + label + '</strong></div><div class="detail">' + detail + '</div>';
      document.getElementById('start').disabled = state.kind === 'starting' || state.kind === 'connected' || state.kind === 'stopping';
      document.getElementById('stop').disabled = state.kind === 'stopped' || state.kind === 'stopping';
      document.getElementById('restart').disabled = state.kind === 'starting' || state.kind === 'stopping';
    };
    const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]);
    render(${initial});
    window.addEventListener('message', event => { if (event.data?.type === 'state') render(event.data.state); });
  </script>
</body>
</html>`
  }
}

/** Validate a webview message object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate the fixed command allowlist. */
function isViewCommand(value: unknown): value is ViewCommand {
  return value === 'start' || value === 'stop' || value === 'restart'
    || value === 'showOutput' || value === 'openSettings'
    || value === 'configureModel' || value === 'defaultPermission'
}

/** Mint a CSP nonce without importing browser-only helpers. */
function nonceValue(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let value = ''
  for (let index = 0; index < 32; index += 1) value += alphabet.charAt(Math.floor(Math.random() * alphabet.length))
  return value
}
