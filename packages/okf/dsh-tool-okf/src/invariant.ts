/**
 * Package-owned invariant companion for `@mindportalix/dsh-tool-okf`.
 * @module @mindportalix/dsh-tool-okf/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@mindportalix/dsh-tool-okf'

/** Cordis companion plugin name. */
export const name = 'tool-okf-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: these tools are thin adapters over `ctx.okf` — they translate arguments,
 * call the service, and shape the result. They own no state or event stream; `ctx.okf`'s store owns
 * the bundle and is covered by its own tests, and the argument/error mapping is covered here by
 * per-tool unit tests driven through `ctx.tools.execute`.
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
