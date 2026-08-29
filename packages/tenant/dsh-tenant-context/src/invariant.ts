/** Package-owned invariant companion for `@mindportalix/dsh-tenant-context`. @module @mindportalix/dsh-tenant-context/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@mindportalix/dsh-tenant-context'

/** Cordis companion plugin name. */
export const name = 'tenant-context-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package owns one process-wide
 * `AsyncLocalStorage<string | undefined>` with no durable event stream and no
 * mutable registry to observe. Its whole contract — a resolved header either
 * validates to a 32-hex-character tenant id or resolves to `undefined`, and
 * `requireCurrent` throws exactly when `current` is `undefined` — is a pure,
 * fully deterministic function of its input already covered by this
 * package's unit tests (including the async-generator propagation case,
 * where a coincidental pass would be the actual corruption this note would
 * otherwise ask a runtime check to catch); there is no cross-call state to
 * corrupt between two independent reads.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
