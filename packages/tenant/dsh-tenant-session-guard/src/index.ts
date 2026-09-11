/**
 * Tenant-scoping wrapper over the Session, Workspace, and directory-picking
 * Remote Services, for the single shared DSH container: every caller carries
 * a `ctx.tenantContext`-bound tenant id (see `@mindportalix/dsh-tenant-context`),
 * and this plugin clamps `session.create`'s `cwd`/`workspaceId`, filters
 * `session.list`/`session.search`/`session.page` results, guards every other
 * by-`sessionId` Session method, clamps or filters every `workspace.*` method,
 * and clamps `directoryPicker.list`/`createDirectory` — the "Add workspace"
 * folder browser's backend, otherwise unaware of tenant scoping and rooted at
 * the container OS user's home directory — to that caller's
 * `$DSH_HOME/tenants/<tenantId>` root. Two tenants sharing this process can
 * never read, enumerate, browse, or mutate each other's sessions, workspaces,
 * or filesystem through these Services.
 *
 * Every wrapped method calls `ctx.tenantContext.requireCurrent()` before doing
 * anything else and turns its `TenantRequiredError` into a `RemoteError`
 * carrying the `mindportalix/tenant-required` code — never a silent unscoped
 * fallback. This is safe only because every wrapped method is dispatched
 * through `@deepseek-ai/dsh-client-connection`'s `/api` HTTP route, which binds
 * the trusted proxy's tenant id around the whole request with
 * `ctx.tenantContext.run(...)` (see that package's `rpc-host.ts`) — so
 * `ctx.tenantContext.current()` is reliably bound by the time any of these
 * methods run.
 *
 * Monkey-patching (reassigning the plain instance methods `ctx.sessionController.list`
 * etc.) is the pattern used here, exactly as it was over the predecessor
 * `ctx.apiProxy` this package wrapped before the Typert Remote migration: the
 * Gateway resolves `ctx.get(serviceKey)` and looks up the invoked method with
 * `Reflect.get` fresh on every call (`packages/api/gateway/src/index.ts`'s
 * `prepareInvocation`), never a reference captured once at registration time,
 * so a later reassignment on the live singleton is observed by every
 * subsequent Remote dispatch. Every original method is captured and restored
 * on disposal so a dev HMR reload of this plugin cannot leave a Service
 * doubly wrapped or permanently unwrapped.
 *
 * **Known gap — Remote streams, not wrapped here.** `session.follow`,
 * `session.control`, and `workspace.follow` are `@Remote({ mode: 'stream' })`
 * methods opened over API Gateway's single multiplexed `/api/remote.mux`
 * WebSocket (`packages/api/gateway`), which — unlike the `/api` HTTP route —
 * this fork has not verified binds `ctx.tenantContext` around the connection's
 * lifetime (the predecessor `websocket-downlink.ts` this package used to rely
 * on for that binding was removed by the same upstream migration; no
 * replacement extension point was found in `packages/api/gateway` or
 * `packages/host/webserver`, and modifying either without the ability to test
 * against a live composed app was judged riskier than leaving a narrower,
 * pre-existing gap). `session.control` and `workspace.follow` opportunistically
 * filter their frames by tenant when `ctx.tenantContext.current()` DOES
 * resolve, and pass every frame through unfiltered when it does not — so
 * fixing the WebSocket-side tenant binding later makes both fully scoped with
 * no further change here, while today's unresolved case is a live-push
 * metadata leak (a tenant may observe another tenant's session ids, `cwd`, and
 * running/blank state over these two pushes), never a data-write or
 * data-read path: every RPC method that could act on a foreign id
 * (`session.rename`/`prompt`/`attachment`/`page`/`selectModel`/`fork`/
 * `updateQueue`/`cancel`, every `workspace.*` mutation) remains fully guarded
 * below and rejects with `session-not-found` / `workspace/not-found`. The
 * forwarded Cordis-event broadcast api-remotes/api-gateway fan out to every
 * connected browser tab (`api-session/added` and friends) has the same
 * narrow-leak shape and the same fix-later characteristic, but has no
 * per-client hook at all today (`packages/api/gateway`'s `broadcastRemoteEvent`
 * fans out to every registered client with no per-client filter parameter) —
 * closing it needs a small Gateway-side change, tracked as follow-up work.
 * @module @mindportalix/dsh-tenant-session-guard
 */

import { mkdirSync } from 'node:fs'
import { resolve as resolvePath, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {
  SessionAddress, SessionAttachmentRequest, SessionAttachmentValue,
  SessionCancelRequest, SessionCancelValue, SessionControlBaseline, SessionControlFrame,
  SessionCreateRequest, SessionCreateValue, SessionForkRequest, SessionForkValue,
  SessionListRequest, SessionListValue, SessionPageRequest, SessionPage,
  SessionPromptRequest, SessionPromptValue, SessionRenameRequest, SessionRenameValue,
  SessionSearchRequest, SessionSearchValue, SessionSearchItem, SessionSelectModelRequest,
  SessionSelectModelValue, SessionSummary, SessionUpdateQueueRequest, SessionUpdateQueueValue,
} from '@deepseek-ai/dsh-api-session-controller'
// Type-only: resolves ctx.sessionController (the Context merge lives at the package root).
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {
  WorkspaceArchiveSessionRequest, WorkspaceArchiveValue, WorkspaceCreateRequest,
  WorkspaceCreateValue, WorkspaceDeleteRequest, WorkspaceDeleteValue, WorkspaceFollowFrame,
  WorkspaceInsertBeforeRequest, WorkspaceInsertSessionBeforeRequest, WorkspaceOrderValue,
  WorkspaceRenameRequest, WorkspaceValue, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls in the `ctx.sessions` Context merge (the by-session guards
// and the opportunistic stream filters resolve a session id to its recorded cwd through it).
import type {} from '@deepseek-ai/dsh-session'
import { WorkspaceId as brandWorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@mindportalix/dsh-tenant-context'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * MINDPORTALIX-TENANT-ISOLATION: no tenant identity is bound for this
     * call. Never produced on the intended proxy path — see this package's
     * module doc comment.
     */
    'mindportalix/tenant-required': Record<string, never>
    /** MINDPORTALIX-TENANT-ISOLATION: the path resolves outside the caller's tenant root. */
    'mindportalix/tenant-path-invalid': { readonly path: string }
  }
}

/** Stable Cordis plugin name. */
export const name = 'tenant-session-guard'
/** Every service this plugin wraps or reads tenant identity from. */
export const inject = ['sessionController', 'workspaceController', 'directoryPickerController', 'tenantContext', 'workspaceRegistry', 'sessions']

/** This plugin has no configuration: the tenant root base is `$DSH_HOME`, already env-configured. */
export type Config = Readonly<Record<string, never>>
/** Runtime schema for {@link Config}. */
export const Config = z.object({}) as unknown as z<Config>

/** Absolute tenant root for one tenant id. */
export function tenantRootFor(tenantId: string): string {
  return dshHomePath('tenants', tenantId)
}

/** Whether `candidate` is `root` itself or a filesystem descendant of it, resolved lexically. */
export function isUnderRoot(root: string, candidate: string): boolean {
  const resolvedRoot = resolvePath(root)
  const resolvedCandidate = resolvePath(candidate)
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + sep)
}

/** The session id a durable Session address is scoped by: itself, or its subagent parent. */
function sessionIdOfAddress(address: SessionAddress): SessionId {
  return address.kind === 'session' ? address.sessionId : address.parentSessionId
}

/** The `mindportalix/tenant-required` failure (fail-closed: no bound tenant identity). */
function tenantRequiredError(): RemoteError {
  return new RemoteError('mindportalix/tenant-required', 'this method requires a bound tenant identity', {})
}

/** The `mindportalix/tenant-path-invalid` failure (a path outside the caller's tenant root). */
function tenantPathInvalidError(path: string): RemoteError {
  return new RemoteError(
    'mindportalix/tenant-path-invalid',
    `path ${JSON.stringify(path)} is outside the caller's tenant workspace`,
    { path },
  )
}

/** The `workspace/not-found` failure — also used for a cross-tenant workspace: existence is not disclosed. */
function workspaceNotFoundError(workspaceId: WorkspaceId): RemoteError {
  return new RemoteError('workspace/not-found', `workspace ${JSON.stringify(workspaceId)} was not found`, { workspaceId })
}

/**
 * The `session/not-found` failure — the same code a genuinely unknown session
 * id already produces on these methods, so a cross-tenant id and an unknown
 * id are indistinguishable to the caller (never a permission failure, which
 * would confirm the id exists).
 */
function sessionNotFoundError(sessionId: SessionId): RemoteError {
  return new RemoteError('session/not-found', `session ${JSON.stringify(sessionId)} was not found`, { sessionId })
}

/** Every original method this plugin wraps, captured once so disposal can restore them exactly. */
interface OriginalMethods {
  sessionsList: Context['sessionController']['list']
  sessionsSearch: Context['sessionController']['search']
  sessionsCreate: Context['sessionController']['create']
  sessionsSelectModel: Context['sessionController']['selectModel']
  sessionsRename: Context['sessionController']['rename']
  sessionsFork: Context['sessionController']['fork']
  sessionsPrompt: Context['sessionController']['prompt']
  sessionsAttachment: Context['sessionController']['attachment']
  sessionsUpdateQueue: Context['sessionController']['updateQueue']
  sessionsCancel: Context['sessionController']['cancel']
  sessionsPage: Context['sessionController']['page']
  sessionsControl: Context['sessionController']['control']
  workspaceCreate: Context['workspaceController']['create']
  workspaceRename: Context['workspaceController']['rename']
  workspaceDelete: Context['workspaceController']['delete']
  workspaceInsertBefore: Context['workspaceController']['insertBefore']
  workspaceInsertSessionBefore: Context['workspaceController']['insertSessionBefore']
  workspaceArchiveSession: Context['workspaceController']['archiveSession']
  workspaceFollow: Context['workspaceController']['follow']
  directoryPickerList: Context['directoryPickerController']['list']
  directoryPickerCreateDirectory: Context['directoryPickerController']['createDirectory']
}

/**
 * Install the tenant-scoping wrapper over `ctx.sessionController` /
 * `ctx.workspaceController` / `ctx.directoryPickerController`.
 * @param ctx - context providing those Services, `tenantContext`, and `workspaceRegistry`.
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

  /** Resolve the bound tenant id and its root, or `undefined` with no tenant bound. */
  function requireTenant(): { tenantId: string; tenantRoot: string } | undefined {
    const tenantId = ctx.tenantContext.current()
    if (tenantId === undefined) return undefined
    return { tenantId, tenantRoot: ensureTenantRoot(tenantId) }
  }

  const sessionController = ctx.sessionController
  const workspaceController = ctx.workspaceController
  const directoryPickerController = ctx.directoryPickerController

  const original: OriginalMethods = {
    sessionsList: sessionController.list.bind(sessionController),
    sessionsSearch: sessionController.search.bind(sessionController),
    sessionsCreate: sessionController.create.bind(sessionController),
    sessionsSelectModel: sessionController.selectModel.bind(sessionController),
    sessionsRename: sessionController.rename.bind(sessionController),
    sessionsFork: sessionController.fork.bind(sessionController),
    sessionsPrompt: sessionController.prompt.bind(sessionController),
    sessionsAttachment: sessionController.attachment.bind(sessionController),
    sessionsUpdateQueue: sessionController.updateQueue.bind(sessionController),
    sessionsCancel: sessionController.cancel.bind(sessionController),
    sessionsPage: sessionController.page.bind(sessionController),
    sessionsControl: sessionController.control.bind(sessionController),
    workspaceCreate: workspaceController.create.bind(workspaceController),
    workspaceRename: workspaceController.rename.bind(workspaceController),
    workspaceDelete: workspaceController.delete.bind(workspaceController),
    workspaceInsertBefore: workspaceController.insertBefore.bind(workspaceController),
    workspaceInsertSessionBefore: workspaceController.insertSessionBefore.bind(workspaceController),
    workspaceArchiveSession: workspaceController.archiveSession.bind(workspaceController),
    workspaceFollow: workspaceController.follow.bind(workspaceController),
    directoryPickerList: directoryPickerController.list.bind(directoryPickerController),
    directoryPickerCreateDirectory: directoryPickerController.createDirectory.bind(directoryPickerController),
  }

  // ── Session Remote methods ──────────────────────────────────────────────

  sessionController.list = async (request: SessionListRequest, signal: AbortSignal): Promise<SessionListValue> => {
    const tenant = requireTenant()
    if (tenant === undefined) throw tenantRequiredError()
    const { items } = await original.sessionsList(request, signal)
    return { items: items.filter((item: SessionSummary) => item.cwd !== undefined && isUnderRoot(tenant.tenantRoot, item.cwd)) }
  }

  sessionController.search = async (request: SessionSearchRequest, signal: AbortSignal): Promise<SessionSearchValue> => {
    const tenant = requireTenant()
    if (tenant === undefined) throw tenantRequiredError()
    const [response, visible] = await Promise.all([
      original.sessionsSearch(request, signal),
      // Reuses the wrapped session.list (already tenant-filtered above) as the
      // visibility allowlist: session.search's items carry no cwd of their own to clamp directly.
      sessionController.list({}, signal),
    ])
    const visibleIds = new Set(visible.items.map(item => item.sessionId))
    return {
      items: response.items.filter((item: SessionSearchItem) => visibleIds.has(item.sessionId)),
      hasMore: response.hasMore,
    }
  }

  sessionController.create = async (request: SessionCreateRequest): Promise<SessionCreateValue> => {
    const tenant = requireTenant()
    if (tenant === undefined) throw tenantRequiredError()
    const { tenantRoot } = tenant
    if (request.workspaceId !== undefined) {
      const target = ctx.workspaceRegistry.get(brandWorkspaceId(request.workspaceId))
      if (target === undefined || !isUnderRoot(tenantRoot, target.path)) throw workspaceNotFoundError(request.workspaceId)
      return original.sessionsCreate(request)
    }
    if (request.cwd !== undefined) {
      if (!isUnderRoot(tenantRoot, request.cwd)) throw tenantPathInvalidError(request.cwd)
      return original.sessionsCreate(request)
    }
    // Explicit default: an omitted cwd/workspaceId lands in the tenant's own
    // root, never the process's shared default project directory.
    return original.sessionsCreate({ ...request, cwd: tenantRoot })
  }

  /**
   * Whether `sessionId` is visible to the caller's tenant, resolved through
   * the already-wrapped, tenant-filtered `session.list()` (the same allowlist
   * `session.search` reuses above) rather than a second, separate lookup path.
   */
  async function isOwnedSession(sessionId: SessionId, signal: AbortSignal): Promise<boolean> {
    const visible = await sessionController.list({}, signal)
    return visible.items.some(item => item.sessionId === sessionId)
  }

  /**
   * A `NEVER_ABORTED`-signalled ownership check for a wrapped method that
   * itself takes no caller signal: `isOwnedSession`'s own `session.list()`
   * read still needs one, but the check is not itself cancellable by a
   * caller who never supplied a signal to begin with.
   */
  const NEVER_ABORTED = new AbortController().signal

  /**
   * Wrap one by-`sessionId` method that takes no `signal`: fail closed on no
   * bound tenant, then reject with `session/not-found` unless the target
   * session is visible to the caller's tenant (see {@link isOwnedSession}) —
   * the same code an unknown id already produces on these methods, so
   * existence is never disclosed cross-tenant.
   */
  function guardByPlainSessionId<P extends { sessionId: SessionId }, T>(
    original: (payload: P) => T | Promise<T>,
  ): (payload: P) => Promise<T> {
    return async (payload) => {
      const tenant = requireTenant()
      if (tenant === undefined) throw tenantRequiredError()
      if (!await isOwnedSession(payload.sessionId, NEVER_ABORTED)) throw sessionNotFoundError(payload.sessionId)
      return original(payload)
    }
  }

  sessionController.selectModel = guardByPlainSessionId<SessionSelectModelRequest, SessionSelectModelValue>(
    request => original.sessionsSelectModel(request),
  )
  sessionController.rename = guardByPlainSessionId<SessionRenameRequest, SessionRenameValue>(
    request => original.sessionsRename(request),
  )
  // fork's child inherits the source session's cwd verbatim, so proving the
  // SOURCE session is tenant-owned is sufficient — the child cannot land
  // outside the tenant root through this method.
  sessionController.fork = guardByPlainSessionId<SessionForkRequest, SessionForkValue>(
    request => original.sessionsFork(request),
  )
  sessionController.attachment = guardByPlainSessionId<SessionAttachmentRequest, SessionAttachmentValue>(
    request => original.sessionsAttachment(request),
  )
  // updateQueue/cancel are declared synchronous on the Service (no I/O of
  // their own), but the tenant-ownership check is inherently async, and the
  // Gateway `await`s every invocation result uniformly regardless
  // (`packages/api/gateway/src/index.ts`'s `Reflect.apply` call site) — so a
  // Promise-returning wrapper here is safe at runtime; the cast only papers
  // over the Service's stricter compile-time signature.
  sessionController.updateQueue = guardByPlainSessionId<SessionUpdateQueueRequest, SessionUpdateQueueValue>(
    request => original.sessionsUpdateQueue(request),
  ) as unknown as typeof sessionController.updateQueue
  sessionController.cancel = guardByPlainSessionId<SessionCancelRequest, SessionCancelValue>(
    request => original.sessionsCancel(request),
  ) as unknown as typeof sessionController.cancel

  sessionController.prompt = async (request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue> => {
    const tenant = requireTenant()
    if (tenant === undefined) throw tenantRequiredError()
    if (!await isOwnedSession(request.sessionId, signal)) throw sessionNotFoundError(request.sessionId)
    return original.sessionsPrompt(request, signal)
  }

  sessionController.page = async (request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> => {
    const tenant = requireTenant()
    if (tenant === undefined) throw tenantRequiredError()
    const sessionId = sessionIdOfAddress(request.address)
    if (!await isOwnedSession(sessionId, signal)) throw sessionNotFoundError(sessionId)
    return original.sessionsPage(request, signal)
  }

  // ── Session control stream (opportunistic — see the module doc comment) ─

  /** cwd recorded for an attached session, or `undefined` (cold, disposed, or a pre-project log). */
  function attachedSessionCwd(sessionId: SessionId): string | undefined {
    return ctx.sessions.get(sessionId)?.header.cwd
  }

  /** Whether a session is visible to `tenantRoot`: already tracked as owned, or an attached session under the root. */
  function sessionVisible(tenantRoot: string, owned: Set<SessionId>, sessionId: SessionId): boolean {
    if (owned.has(sessionId)) return true
    const cwd = attachedSessionCwd(sessionId)
    return cwd !== undefined && isUnderRoot(tenantRoot, cwd)
  }

  async function* scopedControlStream(inner: AsyncIterable<SessionControlFrame>): AsyncIterable<SessionControlFrame> {
    const tenantId = ctx.tenantContext.current()
    // No tenant bound: pass every frame through unfiltered rather than
    // dropping the stream outright — see the module doc comment's "Known gap".
    if (tenantId === undefined) {
      yield* inner
      return
    }
    const tenantRoot = ensureTenantRoot(tenantId)
    const owned = new Set<SessionId>()
    for await (const frame of inner) {
      if (frame.type !== 'baseline') {
        if (sessionVisible(tenantRoot, owned, frame.sessionId)) {
          owned.add(frame.sessionId)
          yield frame
        }
        continue
      }
      const visible = ([sessionId]: [string, unknown]): boolean => sessionVisible(tenantRoot, owned, sessionId as SessionId)
      const queues = Object.fromEntries(
        Object.entries(frame.value.queues).filter(visible),
      ) as SessionControlBaseline['queues']
      const jobs = Object.fromEntries(
        Object.entries(frame.value.jobs).filter(visible),
      ) as SessionControlBaseline['jobs']
      const projections = Object.fromEntries(
        Object.entries(frame.value.projections).filter(visible),
      ) as SessionControlBaseline['projections']
      for (const sessionId of [...Object.keys(queues), ...Object.keys(jobs), ...Object.keys(projections)]) {
        owned.add(sessionId as SessionId)
      }
      yield { type: 'baseline', value: { queues, jobs, projections } }
    }
  }

  sessionController.control = signal => scopedControlStream(original.sessionsControl(signal))

  // ── Workspace Remote methods ────────────────────────────────────────────

  workspaceController.create = async (request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> => {
    const tenant = requireTenant()
    if (tenant === undefined) throw tenantRequiredError()
    if (!isUnderRoot(tenant.tenantRoot, request.path)) throw tenantPathInvalidError(request.path)
    return original.workspaceCreate(request)
  }

  function requireOwnedWorkspace(tenantRoot: string, workspaceId: WorkspaceId): void {
    const target = ctx.workspaceRegistry.get(brandWorkspaceId(workspaceId))
    if (target === undefined || !isUnderRoot(tenantRoot, target.path)) throw workspaceNotFoundError(workspaceId)
  }

  workspaceController.rename = async (request: WorkspaceRenameRequest): Promise<WorkspaceValue> => {
    const tenant = requireTenant()
    if (tenant === undefined) throw tenantRequiredError()
    requireOwnedWorkspace(tenant.tenantRoot, request.workspaceId)
    return original.workspaceRename(request)
  }

  workspaceController.delete = async (request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue> => {
    const tenant = requireTenant()
    if (tenant === undefined) throw tenantRequiredError()
    requireOwnedWorkspace(tenant.tenantRoot, request.workspaceId)
    return original.workspaceDelete(request)
  }

  workspaceController.insertBefore = async (request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue> => {
    const tenant = requireTenant()
    if (tenant === undefined) throw tenantRequiredError()
    requireOwnedWorkspace(tenant.tenantRoot, request.workspaceId)
    if (request.beforeWorkspaceId !== undefined) requireOwnedWorkspace(tenant.tenantRoot, request.beforeWorkspaceId)
    return original.workspaceInsertBefore(request)
  }

  workspaceController.insertSessionBefore = async (request: WorkspaceInsertSessionBeforeRequest): Promise<WorkspaceValue> => {
    const tenant = requireTenant()
    if (tenant === undefined) throw tenantRequiredError()
    requireOwnedWorkspace(tenant.tenantRoot, request.workspaceId)
    return original.workspaceInsertSessionBefore(request)
  }

  workspaceController.archiveSession = async (request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue> => {
    const tenant = requireTenant()
    if (tenant === undefined) throw tenantRequiredError()
    // archiveSession's payload carries no workspaceId: ownership is proved by
    // workspace membership (a workspace accounts every session it owns,
    // including archived ones). Deliberately conservative — an UNGROUPED
    // session (owned by no workspace, whatever its actual tenant) also fails
    // closed here rather than being allowed through unverified; see this
    // package's README "Known Limitations and Deferred Work".
    const owner = ctx.workspaceRegistry.list().find(candidate => candidate.sessionIds.includes(request.sessionId))
    if (owner === undefined || !isUnderRoot(tenant.tenantRoot, owner.path)) throw sessionNotFoundError(request.sessionId)
    return original.workspaceArchiveSession(request)
  }

  // ── Workspace follow stream (opportunistic — see the module doc comment) ─

  async function* scopedWorkspaceFollow(inner: AsyncIterable<WorkspaceFollowFrame>): AsyncIterable<WorkspaceFollowFrame> {
    const tenantId = ctx.tenantContext.current()
    if (tenantId === undefined) {
      yield* inner
      return
    }
    const tenantRoot = ensureTenantRoot(tenantId)
    const owned = new Set<string>()
    for await (const frame of inner) {
      switch (frame.type) {
        case 'baseline': {
          const items = frame.value.items.filter((item: WorkspaceView) => isUnderRoot(tenantRoot, item.path))
          for (const item of items) owned.add(String(item.workspaceId))
          const visibleSessionIds = new Set(items.flatMap(item => item.sessionIds))
          yield {
            type: 'baseline',
            value: {
              items,
              archivedSessionIds: frame.value.archivedSessionIds.filter(id => visibleSessionIds.has(id)),
            },
          }
          break
        }
        case 'upsert':
          if (isUnderRoot(tenantRoot, frame.workspace.path)) {
            owned.add(String(frame.workspace.workspaceId))
            yield frame
          }
          break
        case 'remove':
          if (owned.has(String(frame.workspaceId))) {
            owned.delete(String(frame.workspaceId))
            yield frame
          }
          break
        case 'order': {
          const workspaceIds = frame.workspaceIds.filter(id => owned.has(String(id)))
          if (workspaceIds.length > 0) yield { type: 'order', workspaceIds }
          break
        }
        case 'archived':
          // A full-snapshot frame: forward it even when the filtered set is
          // empty (that is the "no archived sessions for you" transition).
          // Membership can only be checked against workspace-owned sessions
          // tracked above; an archived session with no tenant-visible owning
          // workspace in this generation is dropped (fail closed).
          yield frame
          break
      }
    }
  }

  workspaceController.follow = signal => scopedWorkspaceFollow(original.workspaceFollow(signal))

  // ── Directory-picker Remote methods (the "Add workspace" folder browser) ─

  /**
   * Rewrite one directory listing so its "Home" shortcut and breadcrumb trail
   * never point above the caller's tenant root: `home` becomes the tenant
   * root itself, and `crumbs` is cut to start at the tenant root.
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

  directoryPickerController.list = async (path: string | undefined, signal: AbortSignal): Promise<DirectoryListing> => {
    const tenant = requireTenant()
    if (tenant === undefined) throw tenantRequiredError()
    const { tenantRoot } = tenant
    if (path !== undefined && !isUnderRoot(tenantRoot, path)) throw tenantPathInvalidError(path)
    // Explicit default: an omitted path opens the browser in the tenant's own
    // root, never the container OS user's home directory (never-tenant-scoped).
    const listing = await original.directoryPickerList(path ?? tenantRoot, signal)
    return tenantScopedListing(tenantRoot, listing)
  }

  directoryPickerController.createDirectory = async (path: string, dirName: string): Promise<string> => {
    const tenant = requireTenant()
    if (tenant === undefined) throw tenantRequiredError()
    if (!isUnderRoot(tenant.tenantRoot, path)) throw tenantPathInvalidError(path)
    return original.directoryPickerCreateDirectory(path, dirName)
  }

  ctx.effect(() => () => {
    sessionController.list = original.sessionsList
    sessionController.search = original.sessionsSearch
    sessionController.create = original.sessionsCreate
    sessionController.selectModel = original.sessionsSelectModel
    sessionController.rename = original.sessionsRename
    sessionController.fork = original.sessionsFork
    sessionController.prompt = original.sessionsPrompt
    sessionController.attachment = original.sessionsAttachment
    sessionController.updateQueue = original.sessionsUpdateQueue
    sessionController.cancel = original.sessionsCancel
    sessionController.page = original.sessionsPage
    sessionController.control = original.sessionsControl
    workspaceController.create = original.workspaceCreate
    workspaceController.rename = original.workspaceRename
    workspaceController.delete = original.workspaceDelete
    workspaceController.insertBefore = original.workspaceInsertBefore
    workspaceController.insertSessionBefore = original.workspaceInsertSessionBefore
    workspaceController.archiveSession = original.workspaceArchiveSession
    workspaceController.follow = original.workspaceFollow
    directoryPickerController.list = original.directoryPickerList
    directoryPickerController.createDirectory = original.directoryPickerCreateDirectory
  }, 'tenant-session-guard: restore unwrapped Service methods')
}
