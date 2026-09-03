/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-file-reference-local`.
 * @module @deepseek-ai/dsh-file-reference-local/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-file-reference-local'

/** Cordis companion plugin name. */
export const name = 'file-reference-local-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the per-agent fuzzy indexes and the per-agent
 * referenced-file extraction cache are private advisory state whose
 * version-guarded refresh and agent-scoped disposal are observed directly
 * through service tests, not through an owned session-event relation.
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
