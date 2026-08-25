/** Bounded editor and Explorer context collected before a VS Code prompt. */

import { randomUUID } from 'node:crypto'
import { relative } from 'node:path'
import * as vscode from 'vscode'

/** Deployment-varying context intake limits from VS Code settings. */
export interface ContextLimits {
  /** Maximum bytes accepted from one text file or selection. */
  maxFileBytes: number
  /** Maximum bytes retained across all removable context tags. */
  maxTotalBytes: number
  /** Maximum paths listed for one folder/workspace context. */
  maxFolderFiles: number
}

/** One removable context tag and its exact persistent prompt representation. */
export interface ContextChip {
  /** Draft-local identity. */
  id: string
  /** User-facing source category. */
  kind: 'selection' | 'file' | 'folder' | 'workspace'
  /** Workspace-relative path or workspace label. */
  label: string
  /** Optional one-based inclusive line range. */
  lines?: { start: number; end: number }
  /** Exact model-visible text section. */
  text: string
  /** UTF-8 byte count used for aggregate admission. */
  bytes: number
}

/** Own one in-memory prompt draft's deterministic context tags. */
export class ContextCollector {
  private readonly values = new Map<string, ContextChip>()

  /** @param limits - validated context budgets. */
  constructor(private readonly limits: ContextLimits) {}

  /** Immutable current tag list in insertion order. */
  get chips(): readonly ContextChip[] {
    return [...this.values.values()]
  }

  /** Capture the active non-empty editor selection. */
  addSelection(editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor): ContextChip {
    if (editor === undefined) throw new Error('Open a text editor before adding a selection')
    if (editor.selection.isEmpty) throw new Error('Select text before adding selection context')
    const text = editor.document.getText(editor.selection)
    const start = editor.selection.start.line + 1
    const end = editor.selection.end.line + (editor.selection.end.character === 0 ? 0 : 1)
    return this.addText('selection', displayPath(editor.document.uri), text, { start, end: Math.max(start, end) })
  }

  /** Capture the complete active text document. */
  async addCurrentFile(editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor): Promise<ContextChip> {
    if (editor === undefined) throw new Error('Open a text editor before adding file context')
    return this.addFile(editor.document.uri)
  }

  /** Read and capture one UTF-8 text file without truncation. */
  async addFile(uri: vscode.Uri): Promise<ContextChip> {
    const bytes = await vscode.workspace.fs.readFile(uri)
    if (bytes.byteLength > this.limits.maxFileBytes) {
      throw new Error(`${displayPath(uri)} is ${String(bytes.byteLength)} bytes; the context limit is ${String(this.limits.maxFileBytes)} bytes`)
    }
    if (bytes.includes(0)) throw new Error(`${displayPath(uri)} appears to be binary and cannot be added as context`)
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new Error(`${displayPath(uri)} is not valid UTF-8 text and cannot be added as context`)
    }
    return this.addText('file', displayPath(uri), text)
  }

  /** Add a bounded deterministic file listing for one Explorer folder. */
  async addFolder(uri: vscode.Uri): Promise<ContextChip> {
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(uri, '**/*'),
      '**/{.git,node_modules,.pnpm-store}/**',
      this.limits.maxFolderFiles + 1,
    )
    if (files.length > this.limits.maxFolderFiles) {
      throw new Error(`${displayPath(uri)} contains more than ${String(this.limits.maxFolderFiles)} files; narrow the folder context`)
    }
    const root = displayPath(uri)
    const listing = files.map(file => relative(uri.fsPath, file.fsPath).replaceAll('\\', '/')).sort().join('\n')
    return this.addText('folder', root, listing)
  }

  /** Add bounded listings for every current workspace folder. */
  async addWorkspace(): Promise<ContextChip> {
    const folders = vscode.workspace.workspaceFolders ?? []
    if (folders.length === 0) throw new Error('Open a workspace before adding workspace context')
    const remaining = this.limits.maxFolderFiles + 1
    const files = await vscode.workspace.findFiles(
      '**/*',
      '**/{.git,node_modules,.pnpm-store}/**',
      remaining,
    )
    if (files.length > this.limits.maxFolderFiles) {
      throw new Error(`The workspace contains more than ${String(this.limits.maxFolderFiles)} files; add a narrower folder instead`)
    }
    const listing = files.map(file => displayPath(file)).sort().join('\n')
    return this.addText('workspace', folders.map(folder => folder.name).join(', '), listing)
  }

  /** Remove one draft tag. */
  remove(id: string): void {
    this.values.delete(id)
  }

  /** Clear context only after a prompt is accepted. */
  clear(): void {
    this.values.clear()
  }

  /** Render the exact model-visible user text persisted by session.prompt. */
  renderPrompt(prompt: string): string {
    const invocation = prompt.match(/^\/[a-z0-9]+(?:-[a-z0-9]+)*(?=\s|$)/u)?.[0]
    const task = invocation === undefined ? prompt : prompt.slice(invocation.length).trimStart()
    const sections = invocation === undefined ? [] : [invocation]
    sections.push(...this.chips.map(chip => chip.text))
    sections.push(`<user-task>\n${escapeClosingTag(task, 'user-task')}\n</user-task>`)
    return sections.join('\n\n')
  }

  private addText(
    kind: ContextChip['kind'],
    label: string,
    content: string,
    lines?: ContextChip['lines'],
  ): ContextChip {
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > this.limits.maxFileBytes && kind !== 'folder' && kind !== 'workspace') {
      throw new Error(`${label} is ${String(bytes)} bytes; the context limit is ${String(this.limits.maxFileBytes)} bytes`)
    }
    const lineAttribute = lines === undefined ? '' : ` lines="${String(lines.start)}-${String(lines.end)}"`
    const text = `<dsh-context source="${kind}" path="${escapeAttribute(label)}"${lineAttribute}>\n${escapeClosingTag(content, 'dsh-context')}\n</dsh-context>`
    const renderedBytes = Buffer.byteLength(text, 'utf8')
    const total = this.chips.reduce((sum, chip) => sum + chip.bytes, 0) + renderedBytes
    if (total > this.limits.maxTotalBytes) {
      throw new Error(`Selected context would exceed the ${String(this.limits.maxTotalBytes)} byte draft limit`)
    }
    const chip: ContextChip = {
      id: randomUUID(), kind, label, text, bytes: renderedBytes,
      ...(lines === undefined ? {} : { lines }),
    }
    this.values.set(chip.id, chip)
    return chip
  }
}

function displayPath(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri)
  if (folder === undefined) return uri.fsPath
  const path = relative(folder.uri.fsPath, uri.fsPath).replaceAll('\\', '/')
  return path === '' ? folder.name : path
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

function escapeClosingTag(value: string, tag: 'dsh-context' | 'user-task'): string {
  return value.replaceAll(`</${tag}>`, `<\\/${tag}>`)
}
