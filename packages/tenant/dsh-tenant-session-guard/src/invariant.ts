/**
 * Package-owned invariant companion for `@mindportalix/dsh-tenant-session-guard`.
 * @module @mindportalix/dsh-tenant-session-guard/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@mindportalix/dsh-tenant-session-guard'

/** Cordis companion plugin name. */
export const name = 'tenant-session-guard-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package's whole effect is a one-time method
 * reassignment on `ctx.apiProxy.sessions`/`ctx.apiProxy.workspace` at plugin
 * activation, restored verbatim by its own `ctx.effect` disposer — there is no
 * durable event stream and no mutable registry here to observe for
 * corruption between two independent reads (per the package-invariant policy:
 * confirming that a wrapped method is present, or that disposal restored the
 * original, is a plugin-shape/effect-disposal fact, not a runtime data
 * relation). That disposal-restores-the-original contract is proven directly
 * by this package's own HMR-safety unit test (dispose the fiber, observe the
 * original method back), matching every other registry-contribution package
 * in this codebase.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
