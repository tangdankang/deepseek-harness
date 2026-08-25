/** The VS Code bundle declares the minimal Host API stdio composition. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

describe('dsh-vscode-app bundle', () => {
  it('declares its carrier and host dependencies through a parseable patch', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(
      readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    )
    if (!Array.isArray(parsed)) throw new TypeError('vscode app patch must be a patch list')
    const rows = parsed.flatMap((patch): Record<string, unknown>[] =>
      typeof patch === 'object' && patch !== null
        ? (patch as { insert?: Record<string, unknown>[] }).insert ?? []
        : [],
    )
    expect(rows.find(row => row.id === 'api-gateway')?.name).toBe('@deepseek-ai/dsh-host-apiproxy')
    expect(rows.find(row => row.id === 'api-stdio')?.name).toBe('@deepseek-ai/dsh-host-apiproxy-stdio')
    expect(rows.some(row => row.id === 'webserver')).toBe(false)
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-host-apiproxy-stdio')

    const permission = parsed.find((patch): patch is Record<string, unknown> =>
      typeof patch === 'object' && patch !== null && (patch as { id?: unknown }).id === 'permission')
    if (permission === undefined) throw new TypeError('vscode app patch must override the permission row')
    expect(permission).toMatchObject({
      name: '@deepseek-ai/dsh-permission-presets',
      config: {
        defaultPreset: 'confirm-changes',
        presets: {
          'read-only': { sandbox: 'read-only', approval: 'never' },
          'confirm-changes': { sandbox: 'read-only', approval: 'ask' },
          'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
        },
      },
    })
    expect(Object.keys((permission.config as { presets: object }).presets)).toEqual([
      'read-only',
      'confirm-changes',
      'workspace-write',
    ])
    for (const id of ['tool-str-replace-editor', 'tool-subagent', 'tool-subagent-fork', 'tool-workflow', 'tool-ralph']) {
      expect(parsed).toContainEqual(expect.objectContaining({ id, disabled: true }))
    }
  })
})
