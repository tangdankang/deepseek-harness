/** VS Code Diff and terminal approval preparation over Host render intent. */

import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { ApprovalResponsePayload, HistoryEntry, RpcId, RpcReceipt } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { PendingInteraction } from './event-fold.ts'
import * as vscode from 'vscode'

/** Approval card sent to the Webview without file content or process handles. */
export interface ApprovalCard {
  /** Host approval identity. */
  approvalId: string
  /** Correlated server request identity. */
  requestId: string
  /** Tool requesting the one-shot decision. */
  toolName: string
  /** Human-readable intent. */
  title: string
  /** Host-supplied reason. */
  reason?: string
  /** Review category. */
  kind: 'diff' | 'shell' | 'preparing' | 'unsupported'
  /** Path, command, or unsupported-path explanation. */
  detail: string
  /** Whether a safe one-shot grant path is available. */
  allowEnabled: boolean
  /** Diff handle understood only by the Extension Host. */
  previewId?: string
  /** Mandatory terminal-effect disclosure. */
  warning?: string
}

interface PreparedApproval {
  card: ApprovalCard
  interaction: Extract<PendingInteraction, { kind: 'approval' }>
  retryWhenHistoryChanges?: boolean
  stale?: { uri: vscode.Uri; existed: boolean; digest: string }
}

interface ApprovalResponder {
  respondApproval(
    requestId: RpcId,
    payload: ApprovalResponsePayload,
    signal?: AbortSignal,
  ): Promise<RpcReceipt>
}

/** In-memory readonly document provider for native VS Code Diff editors. */
class DiffDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly values = new Map<string, string>()
  private readonly registrations: vscode.Disposable[]

  constructor() {
    this.registrations = [
      vscode.workspace.registerTextDocumentContentProvider('dsh-diff-before', this),
      vscode.workspace.registerTextDocumentContentProvider('dsh-diff-after', this),
    ]
  }

  /** Register one immutable diff pair. */
  add(path: string, before: string, after: string): { id: string; before: vscode.Uri; after: vscode.Uri } {
    const id = randomUUID()
    const encodedPath = `/${id}/${encodeURIComponent(path)}`
    const beforeUri = vscode.Uri.from({ scheme: 'dsh-diff-before', path: encodedPath })
    const afterUri = vscode.Uri.from({ scheme: 'dsh-diff-after', path: encodedPath })
    this.values.set(beforeUri.toString(), before)
    this.values.set(afterUri.toString(), after)
    return { id, before: beforeUri, after: afterUri }
  }

  /** Resolve one immutable virtual document. */
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.values.get(uri.toString()) ?? ''
  }

  /** Release virtual documents and their providers. */
  dispose(): void {
    this.values.clear()
    for (const registration of this.registrations) registration.dispose()
  }
}

/** Prepare, review, and settle one-shot approvals fail-closed. */
export class ApprovalCoordinator implements vscode.Disposable {
  private readonly documents = new DiffDocuments()
  private readonly prepared = new Map<string, PreparedApproval>()
  private readonly previews = new Map<string, { before: vscode.Uri; after: vscode.Uri; title: string }>()

  /** @param responder - connected Host approval response path. */
  constructor(private readonly responder: ApprovalResponder) {}

  /** Convert current pending Host requests into safe review cards. */
  async prepare(
    cwd: string,
    entries: readonly HistoryEntry[],
    interactions: readonly PendingInteraction[],
    maxDiffBytes: number,
  ): Promise<ApprovalCard[]> {
    const active = new Set<string>()
    const cards: ApprovalCard[] = []
    for (const interaction of interactions) {
      if (interaction.kind !== 'approval') continue
      const key = interaction.frame.approvalId
      active.add(key)
      let current = this.prepared.get(key)
      if (current === undefined || current.interaction.rpcId !== interaction.rpcId || current.retryWhenHistoryChanges === true) {
        current = await this.prepareOne(cwd, entries, interaction, maxDiffBytes)
        this.prepared.set(key, current)
      }
      cards.push(current.card)
    }
    for (const key of this.prepared.keys()) {
      if (!active.has(key)) this.prepared.delete(key)
    }
    return cards
  }

  /** Open the exact native VS Code Diff preview for one card. */
  async openPreview(id: string): Promise<void> {
    const preview = this.previews.get(id)
    if (preview === undefined) throw new Error('此差异预览已失效')
    await vscode.commands.executeCommand('vscode.diff', preview.before, preview.after, preview.title, { preview: true })
  }

  /** Reject one request without invoking its modifying operation. */
  async reject(approvalId: string): Promise<void> {
    const prepared = this.required(approvalId)
    await this.responder.respondApproval(prepared.interaction.rpcId, {
      sessionId: prepared.interaction.frame.sessionId,
      approvalId: prepared.interaction.frame.approvalId,
      outcome: 'rejected',
    })
  }

  /** Grant exactly once after revalidating the reviewed file snapshot. */
  async allowOnce(approvalId: string): Promise<void> {
    const prepared = this.required(approvalId)
    if (!prepared.card.allowEnabled) throw new Error('当前操作不能在 VS Code 中批准')
    if (prepared.stale !== undefined && await snapshotChanged(prepared.stale)) {
      await this.reject(approvalId)
      throw new Error('文件在差异预览生成后发生了变化；DSH 已拒绝这个过期操作')
    }
    await this.responder.respondApproval(prepared.interaction.rpcId, {
      sessionId: prepared.interaction.frame.sessionId,
      approvalId: prepared.interaction.frame.approvalId,
      outcome: 'allowed-once',
    })
  }

  /** Release virtual diff documents. */
  dispose(): void {
    this.prepared.clear()
    this.previews.clear()
    this.documents.dispose()
  }

  private async prepareOne(
    cwd: string,
    entries: readonly HistoryEntry[],
    interaction: Extract<PendingInteraction, { kind: 'approval' }>,
    maxDiffBytes: number,
  ): Promise<PreparedApproval> {
    const callId = interaction.frame.callId
    if (callId === undefined) {
      return unsupported(interaction, '审批请求没有关联的工具调用，只能拒绝。')
    }
    const entry = entries.find(({ event }) =>
      event.type === 'tool/call' && event.data.callId === callId)
    if (entry?.event.type !== 'tool/call') {
      return preparing(interaction)
    }
    const callView = entry.view?.for === 'call' ? entry.view.view : undefined
    if (callView?.card === 'terminal') {
      return {
        interaction,
        card: {
          approvalId: interaction.frame.approvalId,
          requestId: interaction.rpcId,
          toolName: interaction.frame.toolName,
          title: callView.description ?? '运行高权限命令',
          ...(interaction.frame.reason === undefined ? {} : { reason: interaction.frame.reason }),
          kind: 'shell', detail: `${callView.title}\n\ncwd: ${callView.cwd ?? cwd}`, allowEnabled: true,
          warning: '命令可能影响终端和文件系统，这些影响无法提前生成为差异预览。',
        },
      }
    }
    if (callView?.card !== 'diff' || (entry.event.data.name !== 'write' && entry.event.data.name !== 'edit')) {
      return unsupported(interaction, '此修改工具无法生成准确的执行前差异预览，只能拒绝。')
    }
    try {
      const args = parseArguments(entry.event.data.arguments)
      const filePath = requiredString(args, 'file_path')
      const uri = vscode.Uri.file(isAbsolute(filePath) ? filePath : resolve(cwd, filePath))
      const current = await readTextSnapshot(uri, maxDiffBytes)
      const after = entry.event.data.name === 'write'
        ? requiredString(args, 'content')
        : applyEdit(current.text, requiredString(args, 'old_string'), requiredString(args, 'new_string'), args['replace_all'] === true)
      if (Buffer.byteLength(after, 'utf8') > maxDiffBytes) {
        throw new Error(`The proposed result exceeds the ${String(maxDiffBytes)} byte Diff limit`)
      }
      const docs = this.documents.add(filePath, current.text, after)
      this.previews.set(docs.id, { before: docs.before, after: docs.after, title: callView.title })
      return {
        interaction,
        card: {
          approvalId: interaction.frame.approvalId,
          requestId: interaction.rpcId,
          toolName: interaction.frame.toolName,
          title: callView.title,
          ...(interaction.frame.reason === undefined ? {} : { reason: interaction.frame.reason }),
          kind: 'diff', detail: filePath, allowEnabled: true, previewId: docs.id,
        },
        stale: { uri, existed: current.existed, digest: digest(current.text) },
      }
    } catch (error: unknown) {
      return unsupported(interaction, error instanceof Error ? error.message : String(error))
    }
  }

  private required(approvalId: string): PreparedApproval {
    const prepared = this.prepared.get(approvalId)
    if (prepared === undefined) throw new Error('此审批已经不在等待处理')
    return prepared
  }
}

function preparing(
  interaction: Extract<PendingInteraction, { kind: 'approval' }>,
): PreparedApproval {
  return {
    interaction,
    retryWhenHistoryChanges: true,
    card: {
      approvalId: interaction.frame.approvalId,
      requestId: interaction.rpcId,
      toolName: interaction.frame.toolName,
      title: `正在准备 ${interaction.frame.toolName} 审阅`,
      ...(interaction.frame.reason === undefined ? {} : { reason: interaction.frame.reason }),
      kind: 'preparing',
      detail: '正在同步关联的工具调用和审阅信息。准备完成前可以选择拒绝。',
      allowEnabled: false,
    },
  }
}

function unsupported(
  interaction: Extract<PendingInteraction, { kind: 'approval' }>,
  detail: string,
): PreparedApproval {
  return {
    interaction,
    card: {
      approvalId: interaction.frame.approvalId,
      requestId: interaction.rpcId,
      toolName: interaction.frame.toolName,
      title: `审阅 ${interaction.frame.toolName}`,
      ...(interaction.frame.reason === undefined ? {} : { reason: interaction.frame.reason }),
      kind: 'unsupported', detail, allowEnabled: false,
    },
  }
}

async function readTextSnapshot(uri: vscode.Uri, maxBytes: number): Promise<{ existed: boolean; text: string }> {
  let value: Uint8Array
  try {
    value = await vscode.workspace.fs.readFile(uri)
  } catch (error: unknown) {
    if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') return { existed: false, text: '' }
    throw error
  }
  if (value.byteLength > maxBytes) throw new Error(`The current file exceeds the ${String(maxBytes)} byte Diff limit`)
  if (value.includes(0)) throw new Error('The current file is binary and cannot be reviewed as a text Diff')
  try {
    return { existed: true, text: new TextDecoder('utf-8', { fatal: true }).decode(value) }
  } catch {
    throw new Error('The current file is not valid UTF-8 and cannot be reviewed as a text Diff')
  }
}

async function snapshotChanged(snapshot: { uri: vscode.Uri; existed: boolean; digest: string }): Promise<boolean> {
  try {
    const current = await readTextSnapshot(snapshot.uri, Number.MAX_SAFE_INTEGER)
    return current.existed !== snapshot.existed || digest(current.text) !== snapshot.digest
  } catch {
    return true
  }
}

function applyEdit(content: string, oldText: string, newText: string, replaceAll: boolean): string {
  if (oldText === '') throw new Error('The proposed edit has an empty match and cannot be reviewed')
  const occurrences = content.split(oldText).length - 1
  if (occurrences === 0) throw new Error('The proposed edit no longer matches the current file')
  if (!replaceAll && occurrences !== 1) throw new Error('The proposed edit does not identify one unique current-file match')
  return replaceAll ? content.replaceAll(oldText, newText) : content.replace(oldText, newText)
}

function parseArguments(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Tool arguments are not an object')
  return parsed as Record<string, unknown>
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string') throw new Error(`Tool argument ${key} is unavailable`)
  return field
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
