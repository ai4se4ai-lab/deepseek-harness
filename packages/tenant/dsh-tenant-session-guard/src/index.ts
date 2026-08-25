/**
 * Tenant-scoping wrapper over `ctx.apiProxy`'s session, workspace, and
 * directory-browse RPC methods, for the single shared DSH container: every
 * caller carries a `ctx.tenantContext`-bound tenant id (see
 * `@mindportalix/dsh-tenant-context`), and this plugin clamps
 * `session.create`'s `cwd`/`workspaceId`, filters `session.list`/`session.search`
 * results, clamps or filters every `workspace.*` method, and clamps
 * `host.listDirectory`/`host.createDirectory` — the "Add workspace" folder
 * browser's backend, otherwise unaware of tenant scoping and rooted at the
 * container OS user's home directory — to that caller's
 * `$DSH_HOME/tenants/<tenantId>` root, so two tenants sharing this process can
 * never read, enumerate, browse, or mutate each other's sessions, workspaces,
 * or filesystem through the API gateway.
 *
 * Every wrapped method calls `ctx.tenantContext.requireCurrent()` before doing
 * anything else and turns its `TenantRequiredError` into a structured
 * `tenant-required` RPC error — never a silent unscoped fallback. Monkey-patching
 * (reassigning the plain closure properties `ctx.apiProxy.sessions.create` etc.
 * returns from `createApiProxy`) is the pattern used here because `ApiProxy`'s
 * `sessions`/`workspace` members are plain objects of closures, not a Cordis
 * waterfall event or a class whose methods `ctx.plugin` composes — no closer
 * existing "wrap one service method" idiom was found elsewhere in this
 * codebase; every original method is captured and restored on disposal so a
 * dev HMR reload of this plugin cannot leave a session doubly wrapped or
 * permanently unwrapped.
 * @module @mindportalix/dsh-tenant-session-guard
 */

import { mkdirSync } from 'node:fs'
import { resolve as resolvePath, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {
  ApiProxy, DirectoryListing, RpcId, RpcResponse, SessionSearchItem, SessionSummary, WorkspaceView,
} from '@deepseek-ai/dsh-host-apiproxy/api'
// Type-only: resolves ctx.apiProxy (the Context merge lives at the package root, not ./api).
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { WorkspaceId as brandWorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@mindportalix/dsh-tenant-context'

/** Stable Cordis plugin name. */
export const name = 'tenant-session-guard'
/** Every service this plugin wraps or reads tenant identity from. */
export const inject = ['apiProxy', 'tenantContext', 'workspaceRegistry']

/** This plugin has no configuration: the tenant root base is `$DSH_HOME`, already env-configured. */
export type Config = Readonly<Record<string, never>>
/** Runtime schema for {@link Config}. */
export const Config = z.object({}) as unknown as z<Config>

/** Absolute tenant root for one tenant id. */
function tenantRootFor(tenantId: string): string {
  return dshHomePath('tenants', tenantId)
}

/** Whether `candidate` is `root` itself or a filesystem descendant of it, resolved lexically. */
function isUnderRoot(root: string, candidate: string): boolean {
  const resolvedRoot = resolvePath(root)
  const resolvedCandidate = resolvePath(candidate)
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + sep)
}

/** Build the `tenant-required` RPC error response (fail-closed: no bound tenant identity). */
function tenantRequiredResponse<T>(rpcId: RpcId): RpcResponse<T> {
  return {
    rpcId,
    result: {
      ok: false,
      error: { code: 'tenant-required', message: 'this method requires a bound tenant identity', details: {} },
    },
  }
}

/** Build the `tenant-path-invalid` RPC error response (a path outside the caller's tenant root). */
function tenantPathInvalidResponse<T>(rpcId: RpcId, path: string): RpcResponse<T> {
  return {
    rpcId,
    result: {
      ok: false,
      error: {
        code: 'tenant-path-invalid',
        message: `path ${JSON.stringify(path)} is outside the caller's tenant workspace`,
        details: { path },
      },
    },
  }
}

/** Build the `workspace-not-found` RPC error response (also used for a cross-tenant workspace: existence is not disclosed). */
function workspaceNotFoundResponse<T>(rpcId: RpcId, workspaceId: string): RpcResponse<T> {
  return {
    rpcId,
    result: {
      ok: false,
      error: {
        code: 'workspace-not-found',
        message: `workspace ${JSON.stringify(workspaceId)} was not found`,
        details: { workspaceId },
      },
    },
  }
}

/**
 * Build the `session-not-found` RPC error response — the same code a
 * genuinely unknown session id already produces on these methods, so a
 * cross-tenant id and an unknown id are indistinguishable to the caller
 * (never `permission-denied`, which would confirm the id exists).
 */
function sessionNotFoundResponse<T>(rpcId: RpcId, sessionId: SessionId): RpcResponse<T> {
  return {
    rpcId,
    result: {
      ok: false,
      error: {
        code: 'session-not-found',
        message: `session ${JSON.stringify(sessionId)} was not found`,
        details: { sessionId },
      },
    },
  }
}

/** Every original closure this plugin wraps, captured once so disposal can restore them exactly. */
interface OriginalMethods {
  sessionsCreate: ApiProxy['sessions']['create']
  sessionsList: ApiProxy['sessions']['list']
  sessionsSearch: ApiProxy['sessions']['search']
  sessionsHistory: ApiProxy['sessions']['history']
  sessionsModels: ApiProxy['sessions']['models']
  sessionsSelectModel: ApiProxy['sessions']['selectModel']
  sessionsRename: ApiProxy['sessions']['rename']
  sessionsFork: ApiProxy['sessions']['fork']
  sessionsPrompt: ApiProxy['sessions']['prompt']
  sessionsAttachment: ApiProxy['sessions']['attachment']
  sessionsUpdateQueue: ApiProxy['sessions']['updateQueue']
  sessionsCancel: ApiProxy['sessions']['cancel']
  workspaceList: ApiProxy['workspace']['list']
  workspaceCreate: ApiProxy['workspace']['create']
  workspaceRename: ApiProxy['workspace']['rename']
  workspaceDelete: ApiProxy['workspace']['delete']
  workspaceInsertBefore: ApiProxy['workspace']['insertBefore']
  workspaceInsertSessionBefore: ApiProxy['workspace']['insertSessionBefore']
  workspaceArchiveSession: ApiProxy['workspace']['archiveSession']
  hostListDirectory: ApiProxy['host']['listDirectory']
  hostCreateDirectory: ApiProxy['host']['createDirectory']
}

/**
 * Install the tenant-scoping wrapper over `ctx.apiProxy`.
 * @param ctx - context providing `apiProxy`, `tenantContext`, and `workspaceRegistry`.
 */
export function apply(ctx: Context): void {
  const seenTenantRoots = new Set<string>()
  /** Lazily create one tenant's root directory (mode 0700) the first time it is needed. */
  function ensureTenantRoot(tenantId: string): string {
    const root = tenantRootFor(tenantId)
    if (!seenTenantRoots.has(root)) {
      mkdirSync(root, { recursive: true, mode: 0o700 })
      seenTenantRoots.add(root)
    }
    return root
  }

  /** Resolve the bound tenant id and its root, or `undefined` after already answering a `tenant-required` error. */
  function requireTenant(): { tenantId: string; tenantRoot: string } | undefined {
    const tenantId = ctx.tenantContext.current()
    if (tenantId === undefined) return undefined
    return { tenantId, tenantRoot: ensureTenantRoot(tenantId) }
  }

  const sessions = ctx.apiProxy.sessions
  const workspace = ctx.apiProxy.workspace
  const host = ctx.apiProxy.host

  const original: OriginalMethods = {
    sessionsCreate: sessions.create.bind(sessions),
    sessionsList: sessions.list.bind(sessions),
    sessionsSearch: sessions.search.bind(sessions),
    sessionsHistory: sessions.history.bind(sessions),
    sessionsModels: sessions.models.bind(sessions),
    sessionsSelectModel: sessions.selectModel.bind(sessions),
    sessionsRename: sessions.rename.bind(sessions),
    sessionsFork: sessions.fork.bind(sessions),
    sessionsPrompt: sessions.prompt.bind(sessions),
    sessionsAttachment: sessions.attachment.bind(sessions),
    sessionsUpdateQueue: sessions.updateQueue.bind(sessions),
    sessionsCancel: sessions.cancel.bind(sessions),
    workspaceList: workspace.list.bind(workspace),
    workspaceCreate: workspace.create.bind(workspace),
    workspaceRename: workspace.rename.bind(workspace),
    workspaceDelete: workspace.delete.bind(workspace),
    workspaceInsertBefore: workspace.insertBefore.bind(workspace),
    workspaceInsertSessionBefore: workspace.insertSessionBefore.bind(workspace),
    workspaceArchiveSession: workspace.archiveSession.bind(workspace),
    hostListDirectory: host.listDirectory.bind(host),
    hostCreateDirectory: host.createDirectory.bind(host),
  }

  sessions.create = async (request) => {
    const tenant = requireTenant()
    if (tenant === undefined) return tenantRequiredResponse(request.rpcId)
    const { tenantRoot } = tenant
    const payload = request.payload
    if (payload.workspaceId !== undefined) {
      const target = ctx.workspaceRegistry.get(brandWorkspaceId(payload.workspaceId))
      if (target === undefined || !isUnderRoot(tenantRoot, target.path)) {
        return workspaceNotFoundResponse(request.rpcId, payload.workspaceId)
      }
      return original.sessionsCreate(request)
    }
    if (payload.cwd !== undefined) {
      if (!isUnderRoot(tenantRoot, payload.cwd)) return tenantPathInvalidResponse(request.rpcId, payload.cwd)
      return original.sessionsCreate(request)
    }
    // Explicit default: an omitted cwd/workspaceId lands in the tenant's own root,
    // never the process's shared default project directory.
    return original.sessionsCreate({ ...request, payload: { ...payload, cwd: tenantRoot } })
  }

  sessions.list = async (request) => {
    const tenant = requireTenant()
    if (tenant === undefined) return tenantRequiredResponse(request.rpcId)
    const response = await original.sessionsList(request)
    if (!response.result.ok) return response
    const items = response.result.value.items.filter((item: SessionSummary) =>
      item.cwd !== undefined && isUnderRoot(tenant.tenantRoot, item.cwd))
    return { rpcId: response.rpcId, result: { ok: true, value: { items } } }
  }

  sessions.search = async (request, signal) => {
    const tenant = requireTenant()
    if (tenant === undefined) return tenantRequiredResponse(request.rpcId)
    const [response, visible] = await Promise.all([
      original.sessionsSearch(request, signal),
      // Reuses the wrapped session.list (already tenant-filtered above) as the
      // visibility allowlist: session.search's items carry no cwd/path of
      // their own to clamp directly.
      sessions.list({ rpcId: request.rpcId, payload: {} }),
    ])
    if (!response.result.ok) return response
    const visibleIds = visible.result.ok ? new Set(visible.result.value.items.map(item => item.sessionId)) : new Set<string>()
    const items = response.result.value.items.filter((item: SessionSearchItem) => visibleIds.has(item.sessionId))
    return { rpcId: response.rpcId, result: { ok: true, value: { items, hasMore: response.result.value.hasMore } } }
  }

  /**
   * Whether `sessionId` is visible to the caller's tenant: resolved through
   * the already-wrapped, tenant-filtered `sessions.list()` (the same
   * allowlist `session.search` reuses above) rather than a second, separate
   * lookup path — a session with no recorded `cwd`, or whose `cwd` falls
   * outside the tenant root, is invisible here exactly as it is there.
   * @param rpcId - the caller's request id, threaded through to the internal `sessions.list()` call.
   * @param sessionId - the session id to check.
   * @returns whether the session is visible to the caller's tenant.
   */
  async function isOwnedSession(rpcId: RpcId, sessionId: SessionId): Promise<boolean> {
    const visible = await sessions.list({ rpcId, payload: {} })
    if (!visible.result.ok) return false
    return visible.result.value.items.some(item => item.sessionId === sessionId)
  }

  /**
   * Wrap one by-`sessionId` method: fail closed on no bound tenant, then
   * reject with `session-not-found` unless the target session is visible to
   * the caller's tenant (see {@link isOwnedSession}) — the same code an
   * unknown id already produces on these methods, so existence is never
   * disclosed cross-tenant.
   */
  function guardBySessionId<P extends { sessionId: SessionId }, T>(
    original: (request: { rpcId: RpcId; payload: P }) => Promise<RpcResponse<T>>,
  ): (request: { rpcId: RpcId; payload: P }) => Promise<RpcResponse<T>> {
    return async (request) => {
      const tenant = requireTenant()
      if (tenant === undefined) return tenantRequiredResponse(request.rpcId)
      if (!await isOwnedSession(request.rpcId, request.payload.sessionId)) {
        return sessionNotFoundResponse(request.rpcId, request.payload.sessionId)
      }
      return original(request)
    }
  }

  sessions.history = guardBySessionId(original.sessionsHistory)
  sessions.models = guardBySessionId(original.sessionsModels)
  sessions.selectModel = guardBySessionId(original.sessionsSelectModel)
  sessions.rename = guardBySessionId(original.sessionsRename)
  // fork's child inherits the source session's cwd verbatim (api-proxy.ts:
  // meta.cwd is set from source.header.cwd, never client-supplied), so
  // proving the SOURCE session is tenant-owned is sufficient — the child
  // cannot land outside the tenant root through this method.
  sessions.fork = guardBySessionId(original.sessionsFork)
  sessions.prompt = guardBySessionId(original.sessionsPrompt)
  sessions.attachment = guardBySessionId(original.sessionsAttachment)
  sessions.updateQueue = guardBySessionId(original.sessionsUpdateQueue)
  sessions.cancel = guardBySessionId(original.sessionsCancel)

  workspace.list = async (request) => {
    const tenant = requireTenant()
    if (tenant === undefined) return tenantRequiredResponse(request.rpcId)
    const response = await original.workspaceList(request)
    if (!response.result.ok) return response
    const items = response.result.value.items.filter((item: WorkspaceView) => isUnderRoot(tenant.tenantRoot, item.path))
    // Archived sessions carry no path of their own; a workspace accounts every
    // session it owns (including archived ones — see WorkspaceApi.list), so
    // membership in a tenant-visible workspace is the tenant-ownership proof.
    const visibleSessionIds = new Set(items.flatMap(item => item.sessionIds))
    const archivedSessionIds = response.result.value.archivedSessionIds.filter(id => visibleSessionIds.has(id))
    return { rpcId: response.rpcId, result: { ok: true, value: { items, archivedSessionIds } } }
  }

  workspace.create = async (request) => {
    const tenant = requireTenant()
    if (tenant === undefined) return tenantRequiredResponse(request.rpcId)
    if (!isUnderRoot(tenant.tenantRoot, request.payload.path)) {
      return tenantPathInvalidResponse(request.rpcId, request.payload.path)
    }
    return original.workspaceCreate(request)
  }

  workspace.rename = async (request) => {
    const tenant = requireTenant()
    if (tenant === undefined) return tenantRequiredResponse(request.rpcId)
    const target = ctx.workspaceRegistry.get(brandWorkspaceId(request.payload.workspaceId))
    if (target === undefined || !isUnderRoot(tenant.tenantRoot, target.path)) {
      return workspaceNotFoundResponse(request.rpcId, request.payload.workspaceId)
    }
    return original.workspaceRename(request)
  }

  workspace.delete = async (request) => {
    const tenant = requireTenant()
    if (tenant === undefined) return tenantRequiredResponse(request.rpcId)
    const target = ctx.workspaceRegistry.get(brandWorkspaceId(request.payload.workspaceId))
    if (target === undefined || !isUnderRoot(tenant.tenantRoot, target.path)) {
      return workspaceNotFoundResponse(request.rpcId, request.payload.workspaceId)
    }
    return original.workspaceDelete(request)
  }

  workspace.insertBefore = async (request) => {
    const tenant = requireTenant()
    if (tenant === undefined) return tenantRequiredResponse(request.rpcId)
    const { workspaceId, beforeWorkspaceId } = request.payload
    for (const id of [workspaceId, ...beforeWorkspaceId === undefined ? [] : [beforeWorkspaceId]]) {
      const target = ctx.workspaceRegistry.get(brandWorkspaceId(id))
      if (target === undefined || !isUnderRoot(tenant.tenantRoot, target.path)) {
        return workspaceNotFoundResponse(request.rpcId, id)
      }
    }
    return original.workspaceInsertBefore(request)
  }

  workspace.insertSessionBefore = async (request) => {
    const tenant = requireTenant()
    if (tenant === undefined) return tenantRequiredResponse(request.rpcId)
    const target = ctx.workspaceRegistry.get(brandWorkspaceId(request.payload.workspaceId))
    if (target === undefined || !isUnderRoot(tenant.tenantRoot, target.path)) {
      return workspaceNotFoundResponse(request.rpcId, request.payload.workspaceId)
    }
    return original.workspaceInsertSessionBefore(request)
  }

  workspace.archiveSession = async (request) => {
    const tenant = requireTenant()
    if (tenant === undefined) return tenantRequiredResponse(request.rpcId)
    // archiveSession's payload carries no workspaceId: ownership is proved by
    // workspace membership (a workspace accounts every session it owns,
    // including archived ones). Deliberately conservative — an UNGROUPED
    // session (owned by no workspace, whatever its actual tenant) also fails
    // closed here rather than being allowed through unverified; see this
    // package's README "Known Limitations and Deferred Work".
    const owner = ctx.workspaceRegistry.list().find(candidate => candidate.sessionIds.includes(request.payload.sessionId))
    if (owner === undefined || !isUnderRoot(tenant.tenantRoot, owner.path)) {
      return {
        rpcId: request.rpcId,
        result: {
          ok: false,
          error: {
            code: 'session-not-found',
            message: `session ${JSON.stringify(request.payload.sessionId)} was not found`,
            details: { sessionId: request.payload.sessionId },
          },
        },
      }
    }
    return original.workspaceArchiveSession(request)
  }

  /**
   * Rewrite one directory listing so its "Home" shortcut and breadcrumb trail
   * never point above the caller's tenant root: `home` becomes the tenant
   * root itself, and `crumbs` is cut to start at the tenant root (a caller
   * can browse back up TO it, never past it into container-wide paths like
   * `/data` or `/`). `target` is always the tenant root or a descendant by
   * the time this runs, so the tenant root is always one of `crumbs`'
   * ancestry entries.
   */
  function tenantScopedListing(tenantRoot: string, listing: DirectoryListing): DirectoryListing {
    const resolvedRoot = resolvePath(tenantRoot)
    const rootIndex = listing.crumbs.findIndex(crumb => resolvePath(crumb.path) === resolvedRoot)
    return {
      ...listing,
      home: tenantRoot,
      crumbs: rootIndex === -1 ? listing.crumbs : listing.crumbs.slice(rootIndex),
    }
  }

  host.listDirectory = async (request, signal) => {
    const tenant = requireTenant()
    if (tenant === undefined) return tenantRequiredResponse(request.rpcId)
    const { tenantRoot } = tenant
    const path = request.payload.path
    if (path !== undefined && !isUnderRoot(tenantRoot, path)) {
      return tenantPathInvalidResponse(request.rpcId, path)
    }
    // Explicit default: an omitted path opens the browser in the tenant's own
    // root, never the container OS user's home directory (never-tenant-scoped).
    const response = await original.hostListDirectory(
      path === undefined ? { ...request, payload: { ...request.payload, path: tenantRoot } } : request,
      signal,
    )
    if (!response.result.ok) return response
    return { rpcId: response.rpcId, result: { ok: true, value: tenantScopedListing(tenantRoot, response.result.value) } }
  }

  host.createDirectory = async (request) => {
    const tenant = requireTenant()
    if (tenant === undefined) return tenantRequiredResponse(request.rpcId)
    if (!isUnderRoot(tenant.tenantRoot, request.payload.path)) {
      return tenantPathInvalidResponse(request.rpcId, request.payload.path)
    }
    return original.hostCreateDirectory(request)
  }

  ctx.effect(() => () => {
    sessions.create = original.sessionsCreate
    sessions.list = original.sessionsList
    sessions.search = original.sessionsSearch
    sessions.history = original.sessionsHistory
    sessions.models = original.sessionsModels
    sessions.selectModel = original.sessionsSelectModel
    sessions.rename = original.sessionsRename
    sessions.fork = original.sessionsFork
    sessions.prompt = original.sessionsPrompt
    sessions.attachment = original.sessionsAttachment
    sessions.updateQueue = original.sessionsUpdateQueue
    sessions.cancel = original.sessionsCancel
    workspace.list = original.workspaceList
    workspace.create = original.workspaceCreate
    workspace.rename = original.workspaceRename
    workspace.delete = original.workspaceDelete
    workspace.insertBefore = original.workspaceInsertBefore
    workspace.insertSessionBefore = original.workspaceInsertSessionBefore
    workspace.archiveSession = original.workspaceArchiveSession
    host.listDirectory = original.hostListDirectory
    host.createDirectory = original.hostCreateDirectory
  }, 'tenant-session-guard: restore unwrapped apiProxy methods')
}

// Re-exported so tests and the invariant companion can assert on the exact
// tenant-root computation without duplicating the join logic. No default
// export: this is a named function plugin (name/inject/Config/apply), and a
// default export would make the Loader discard its namespace.
export { tenantRootFor, isUnderRoot }
