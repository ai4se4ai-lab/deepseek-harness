/**
 * Per-request tenant identity for the single shared DSH container: reads the
 * MindPortalix reverse proxy's trusted `x-mp-dsh-tenant` header and carries the
 * resolved tenant id through the request's whole async call chain via
 * `node:async_hooks` `AsyncLocalStorage`. Every other tenant-isolation package
 * (`@mindportalix/dsh-tenant-session-guard`, `@mindportalix/dsh-tenant-sandbox-local`,
 * `@mindportalix/dsh-tenant-credentials-local`) reads tenant identity exclusively
 * through this service's {@link
 * TenantContextService.current} / {@link TenantContextService.requireCurrent} and MUST
 * fail closed when it is absent: this package never defaults an absent or malformed
 * header to a shared/default tenant, and `requireCurrent` is the one primitive that
 * turns "no tenant bound" into a thrown, structured error instead of a silent
 * fall-through. (`dsh-tenant-credentials-local` is the one deliberate exception:
 * with no tenant bound it resolves the shared `$DSH_HOME/.credentials.yaml`, so a
 * bare `dsh` CLI run in the checkout keeps working; on the proxy path a tenant is
 * always bound.)
 * @module @mindportalix/dsh-tenant-context
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { Context, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-request tenant identity, bound for the request/connection's whole async chain. */
    tenantContext: TenantContextService
  }
}

/**
 * The trusted MindPortalix reverse-proxy header carrying the caller's tenant
 * id. DSH's own port is reachable only through that proxy (see
 * `docker-compose.dsh.yml`'s `expose`-only publication), which strips and
 * overwrites any client-supplied value on both the HTTP and WebSocket-upgrade
 * paths — so the header is trusted as authoritative once inside this process.
 * Node's `http.IncomingMessage.headers` and `ws`'s upgrade-request headers are
 * already lowercased, matching this constant.
 */
export const TENANT_HEADER_NAME = 'x-mp-dsh-tenant'

/** The trusted proxy's fixed wire shape: 32 lowercase hex characters (HMAC-SHA256 of the user id, truncated). */
const TENANT_ID_PATTERN = /^[0-9a-f]{32}$/

/**
 * Thrown by {@link TenantContextService.requireCurrent} when no tenant identity
 * is bound to the currently executing async chain. Every tenant-enforcing
 * consumer must let this propagate as a rejection rather than catching it and
 * substituting a default tenant or an unscoped path.
 */
export class TenantRequiredError extends Error {
  constructor() {
    super(
      'dsh-tenant-context: no tenant identity is bound to the current request; '
      + 'refusing to fall back to a shared/default tenant',
    )
    this.name = 'TenantRequiredError'
  }
}

/**
 * The tenant-identity service (`ctx.tenantContext`). Wraps one process-wide
 * `AsyncLocalStorage<string | undefined>` whose store value is the resolved
 * tenant id for the request or connection currently executing. Nothing in
 * this service derives a tenant id from anything except the header value
 * handed to {@link resolveTenant} — no session state, no cookie, no
 * connection-local cache — so every entry point that wants tenant scoping
 * must call `resolveTenant` and `run` itself at the point it first sees the
 * trusted header.
 */
export class TenantContextService extends Service {
  private readonly als = new AsyncLocalStorage<string | undefined>()

  /**
   * @param ctx - owning Cordis context.
   */
  constructor(ctx: Context) {
    super(ctx, 'tenantContext')
  }

  /**
   * Resolve the tenant id from one request's headers. Never throws: an
   * absent header, a duplicated header whose first value fails validation, or
   * a value that does not match the trusted proxy's fixed wire shape all
   * resolve to `undefined` — the fail-closed input `run` and every downstream
   * consumer treat as "no tenant", never "default/shared access".
   * @param headers - the incoming request's (already-lowercased) header map.
   * @returns the validated tenant id, or `undefined` when absent or malformed.
   */
  resolveTenant(headers: Record<string, string | string[] | undefined>): string | undefined {
    const raw = headers[TENANT_HEADER_NAME]
    const value = Array.isArray(raw) ? raw[0] : raw
    if (value === undefined || !TENANT_ID_PATTERN.test(value)) return undefined
    return value
  }

  /**
   * Run `fn` with `tenantId` bound to the active async chain for its whole
   * lifetime, including every `await` inside it and every resumption of an
   * async generator started inside it.
   * @param tenantId - the resolved tenant id, or `undefined` for no tenant.
   * @param fn - the operation to run with that tenant bound.
   * @returns `fn`'s return value.
   */
  run<T>(tenantId: string | undefined, fn: () => T): T {
    return this.als.run(tenantId, fn)
  }

  /**
   * Read the tenant id bound to the currently executing async chain.
   * @returns the bound tenant id, or `undefined` outside any {@link run} call.
   */
  current(): string | undefined {
    return this.als.getStore()
  }

  /**
   * Read the tenant id bound to the currently executing async chain, failing
   * closed when none is bound. Every tenant-enforcing consumer (session
   * scoping, sandbox confinement) calls this instead of {@link current} at its
   * point of enforcement, so a missing tenant id is a thrown error at the
   * exact call site that needed it rather than a silently unscoped operation.
   * @returns the bound tenant id.
   * @throws {@link TenantRequiredError} when no tenant id is bound.
   */
  requireCurrent(): string {
    const tenantId = this.current()
    if (tenantId === undefined) throw new TenantRequiredError()
    return tenantId
  }
}

export default TenantContextService
