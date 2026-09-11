/**
 * Package-owned invariant companion for `@mindportalix/dsh-tenant-credentials-local`.
 * @module @mindportalix/dsh-tenant-credentials-local/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@mindportalix/dsh-tenant-credentials-local'

/** Cordis companion plugin name. */
export const name = 'tenant-credentials-local-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the provider is a per-call resolver over one document
 * chosen by `ctx.tenantContext.current()` — there is no in-memory registry or
 * event stream to observe beyond `credentials/reference-updated` /
 * `credentials/record-updated`, which the shared `@deepseek-ai/dsh-credentials`
 * seam already contains and fans out. Each `LocalCredentialStore`'s
 * read-modify-write discipline (queue order, cross-process lock, mode 0600,
 * self-write suppression) is covered directly by this package's unit tests
 * against temp directories, and the store's parser and flat-layout migration
 * are `@deepseek-ai/dsh-credentials-local`'s own, covered there. Matches that
 * package's "No runtime invariant" companion for the same reason.
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
