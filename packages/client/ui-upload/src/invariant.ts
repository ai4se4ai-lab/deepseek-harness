/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-upload`.
 * @module @deepseek-ai/dsh-client-ui-upload/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-upload'

/** Cordis companion plugin name. */
export const name = 'client-ui-upload-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the `/` upload source, its hidden file input, and the
 * locale dictionary are registry- and effect-owned registrations whose
 * disposal is proven by the HMR-safety spec. They emit no cordis events and
 * own no cross-plugin mutable state.
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
