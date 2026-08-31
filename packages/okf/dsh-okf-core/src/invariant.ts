/**
 * Package-owned invariant companion for `@mindportalix/dsh-okf-core`.
 * @module @mindportalix/dsh-okf-core/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@mindportalix/dsh-okf-core'

/** Cordis companion plugin name. */
export const name = 'okf-core-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package is pure functions over their arguments (frontmatter parse,
 * trust/staleness derivation, index/log generation); it owns no event stream or mutable runtime
 * data, and its value algebra is enforced by unit tests.
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
