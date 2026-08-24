/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-vscode-app`.
 * @module @deepseek-ai/dsh-vscode-app/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-vscode-app'

/** Cordis companion plugin name. */
export const name = 'vscode-app-bundle-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package is a static patch-list carrier. Each
 * mounted row's owning package registers the mutable relationships it can
 * observe.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
