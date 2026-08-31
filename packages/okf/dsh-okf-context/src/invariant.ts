/**
 * Package-owned invariant companion for `@mindportalix/dsh-okf-context`.
 * @module @mindportalix/dsh-okf-context/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@mindportalix/dsh-okf-context'

/** Cordis companion plugin name. */
export const name = 'okf-context-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this plugin registers one prompt section and one pre-step listener that
 * appends a durable snapshot message. It owns no mutable state or event stream of its own — the
 * snapshot lands on the real session log through `createUserMessage`, and the section text is
 * static. Both are covered by unit tests over the pre-step waterfall and the snapshot builder.
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
