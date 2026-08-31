/**
 * Package-owned invariant companion for `@mindportalix/dsh-okf-attest`.
 * @module @mindportalix/dsh-okf-attest/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@mindportalix/dsh-okf-attest'

/** Cordis companion plugin name. */
export const name = 'okf-attest-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: `ctx.okfAttest` reads a concept through `ctx.okf` and runs pure comparison
 * functions (SQL canonicalization, parameter binding, receipt equality) over their arguments. It
 * owns no mutable state or event stream; the comparison algebra is covered by unit tests, including
 * the tamper cases where a mismatched SQL or value must fail the verdict.
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
