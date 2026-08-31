/**
 * Package-owned invariant companion for `@mindportalix/dsh-okf-bundle`.
 * @module @mindportalix/dsh-okf-bundle/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@mindportalix/dsh-okf-bundle'

/** Cordis companion plugin name. */
export const name = 'okf-bundle-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: `ctx.okf` is a stateless resolver over the filesystem — every method builds
 * a fresh store for the caller's current tenant and returns; there is no in-memory registry or event
 * stream to observe. The bundle on disk is the state, and its operations are covered by the store's
 * unit tests against a temp directory.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
