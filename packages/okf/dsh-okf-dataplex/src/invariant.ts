/**
 * Package-owned invariant companion for `@mindportalix/dsh-okf-dataplex`.
 * @module @mindportalix/dsh-okf-dataplex/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@mindportalix/dsh-okf-dataplex'

/** Cordis companion plugin name. */
export const name = 'okf-dataplex-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: `ctx.okfDataplex` is pure frontmatter⇄aspect translation plus a thin
 * delegation to an injected `kcmd` runner. It owns no mutable state or event stream; the lossless
 * round-trip is covered by unit tests, and the sync delegation has no runner in this build.
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
