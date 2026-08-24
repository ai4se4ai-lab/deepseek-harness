/**
 * Package-owned invariant companion for `@mindportalix/dsh-tenant-sandbox-local`.
 * @module @mindportalix/dsh-tenant-sandbox-local/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@mindportalix/dsh-tenant-sandbox-local'

/** Cordis companion plugin name. */
export const name = 'tenant-sandbox-local-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: `bwrapProfileArgs`/`landlockProfileArgs` are pure
 * functions of `(policy, tenantRoot)` with no durable event stream or mutable
 * registry, and `confine()`'s fail-closed contract (throw with no bound
 * tenant identity, throw when `policy.workspaceRoot` escapes the resolved
 * tenant root) is deterministic per call — there is no cross-call state to
 * corrupt between two independent confinements. Both are covered directly by
 * this package's unit tests (fixed-argv assertions and the no-tenant-context
 * refusal case), matching the sibling `dsh-sandbox-local` package's own
 * "No runtime invariant" companion for the identical reason.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
