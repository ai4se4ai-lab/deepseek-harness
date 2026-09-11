/**
 * TenantSessionGuard tests. A real TenantContextService drives tenant
 * binding (matching production ALS propagation); sessionController /
 * workspaceController / directoryPickerController and workspaceRegistry are
 * hand-built fakes narrow enough to exercise every wrapped method's
 * clamp/filter/fail-closed behavior without booting the real session/
 * workspace stack.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { TenantContextService } from '@mindportalix/dsh-tenant-context'
import * as TenantSessionGuard from '../src/index.ts'
import { isUnderRoot, tenantRootFor } from '../src/index.ts'

interface FakeWorkspace {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}

function makeWorkspace(workspaceId: string, path: string, sessionIds: string[] = []): FakeWorkspace {
  return { workspaceId, path, title: workspaceId, sessionIds, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' }
}

/** Ancestor-chain breadcrumbs for `target`, matching the real browse backend's shape. */
function fakeCrumbs(target: string): { name: string; path: string; hidden: boolean }[] {
  const crumbs: { name: string; path: string; hidden: boolean }[] = []
  let current = target
  for (;;) {
    const parent = dirname(current)
    crumbs.unshift({ name: parent === current ? current : current.slice(parent.length + 1), path: current, hidden: false })
    if (parent === current) return crumbs
    current = parent
  }
}

interface Fixture {
  sessions: { sessionId: string; updatedAt: number; running: boolean; blank: boolean; cwd?: string }[]
  searchItems: { sessionId: string; snippet: string }[]
  workspaces: FakeWorkspace[]
  archivedSessionIds: string[]
}

/** Fake `ctx.sessionController` narrow enough for this suite's clamp/filter/guard assertions. */
function fakeSessionController(fixture: Fixture): Context['sessionController'] {
  return {
    list: async () => ({ items: fixture.sessions }),
    search: async () => ({ items: fixture.searchItems, hasMore: false }),
    create: async (request: { workspaceId?: string; cwd?: string; sessionId?: string }) =>
      ({ sessionId: request.sessionId ?? 'created' }),
    // Each fake below echoes `reached: true` so tests can assert the call
    // actually reached the original implementation (pass-through), distinct
    // from a guard rejection (which never calls these).
    selectModel: async () => ({ selected: { provider: 'x', model: 'y' }, reached: true } as never),
    rename: async (request: { title: string }) => ({ title: request.title, seq: 0, reached: true } as never),
    fork: async () => ({ sessionId: 'forked', reached: true } as never),
    prompt: async () => ({ accepted: true, reached: true } as never),
    attachment: async () => ({ reached: true } as never),
    updateQueue: () => ({ accepted: true, reached: true } as never),
    cancel: () => ({ accepted: true, reached: true } as never),
    page: async () => ({ records: [], hasMore: false, reached: true } as never),
    control: () => (async function* () {})(),
  } as unknown as Context['sessionController']
}

/** Fake `ctx.workspaceController`. */
function fakeWorkspaceController(fixture: Fixture): Context['workspaceController'] {
  return {
    create: async (request: { path: string }) =>
      ({ workspace: makeWorkspace('new', request.path), created: true }),
    rename: async () => ({ workspace: fixture.workspaces[0], reached: true } as never),
    delete: async () => ({ deleted: true, reached: true } as never),
    insertBefore: async () => ({ workspaceIds: [], reached: true } as never),
    insertSessionBefore: async () => ({ workspace: fixture.workspaces[0], reached: true } as never),
    archiveSession: async (request: { sessionId: string }) =>
      ({ archivedSessionIds: [...fixture.archivedSessionIds, request.sessionId] }),
    follow: () => (async function* () {})(),
  } as unknown as Context['workspaceController']
}

/** Fake `ctx.directoryPickerController`. Echoes an untouched (non-tenant-aware) listing. */
function fakeDirectoryPickerController(): Context['directoryPickerController'] {
  return {
    list: async (path: string | undefined) => {
      const target = path ?? '/home/node'
      return { path: target, home: '/home/node', crumbs: fakeCrumbs(target), entries: [], truncated: false }
    },
    createDirectory: async (path: string, name: string) => join(path, name),
  } as unknown as Context['directoryPickerController']
}

function fakeWorkspaceRegistry(workspaces: FakeWorkspace[]): Context['workspaceRegistry'] {
  // Registry entries expose `.id` (the real Workspace record's field); the wire
  // WorkspaceView renames it to `workspaceId`. Alias both so the guard's
  // `String(candidate.id)` and the tests' `workspaceId` both resolve.
  const entries = workspaces.map(w => ({ ...w, id: w.workspaceId }))
  const byId = new Map(entries.map(w => [w.workspaceId, w]))
  return {
    get: (id: unknown) => byId.get(String(id)),
    list: () => entries,
  } as unknown as Context['workspaceRegistry']
}

/** Fake `ctx.sessions` store: resolves an attached session id to its recorded cwd from the fixture. */
function fakeSessionStore(fixture: Fixture): Context['sessions'] {
  return {
    get: (id: unknown) => {
      const found = fixture.sessions.find(session => session.sessionId === id)
      return found?.cwd === undefined ? undefined : { header: { cwd: found.cwd } }
    },
  } as unknown as Context['sessions']
}

let dshHome: string

beforeEach(() => {
  dshHome = mkdtempSync(join(tmpdir(), 'dsh-tenant-guard-'))
  process.env.DSH_HOME = dshHome
})

afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(dshHome, { recursive: true, force: true })
})

const TENANT_A = 'a'.repeat(32)
const TENANT_B = 'b'.repeat(32)

async function setup(fixture: Fixture): Promise<{
  ctx: Context
  sessionController: Context['sessionController']
  workspaceController: Context['workspaceController']
  directoryPickerController: Context['directoryPickerController']
}> {
  const ctx = new Context()
  await ctx.plugin(TenantContextService)
  const sessionController = fakeSessionController(fixture)
  const workspaceController = fakeWorkspaceController(fixture)
  const directoryPickerController = fakeDirectoryPickerController()
  ctx.provide('sessionController', sessionController)
  ctx.provide('workspaceController', workspaceController)
  ctx.provide('directoryPickerController', directoryPickerController)
  ctx.provide('workspaceRegistry', fakeWorkspaceRegistry(fixture.workspaces))
  ctx.provide('sessions', fakeSessionStore(fixture))
  await ctx.plugin(TenantSessionGuard)
  return { ctx, sessionController, workspaceController, directoryPickerController }
}

const NEVER_ABORTED = new AbortController().signal

describe('tenantRootFor / isUnderRoot', () => {
  it('computes the tenant root under $DSH_HOME/tenants/<id>', () => {
    expect(tenantRootFor(TENANT_A)).toBe(join(dshHome, 'tenants', TENANT_A))
  })

  it('isUnderRoot accepts the root itself and descendants, rejects siblings and ancestors', () => {
    const root = join(dshHome, 'tenants', TENANT_A)
    expect(isUnderRoot(root, root)).toBe(true)
    expect(isUnderRoot(root, join(root, 'sub', 'dir'))).toBe(true)
    expect(isUnderRoot(root, join(dshHome, 'tenants', TENANT_B))).toBe(false)
    expect(isUnderRoot(root, dshHome)).toBe(false)
    // A sibling directory that merely shares the root as a string PREFIX (not a path
    // component) must not pass — the classic "/tenants/a-evil" vs "/tenants/a" bug.
    expect(isUnderRoot(root, `${root}-evil`)).toBe(false)
  })
})

describe('session.list / session.create', () => {
  it('rejects every method with no bound tenant identity', async () => {
    const { sessionController } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    await expect(sessionController.list({}, NEVER_ABORTED)).rejects.toMatchObject(
      { code: 'mindportalix/tenant-required' } satisfies Partial<RemoteError>,
    )
  })

  it('filters session.list to sessions whose cwd is under the caller tenant root', async () => {
    const own = join(tenantRootFor(TENANT_A), 'proj')
    const foreign = join(tenantRootFor(TENANT_B), 'proj')
    const { ctx, sessionController } = await setup({
      sessions: [
        { sessionId: 's-own', updatedAt: 0, running: false, blank: false, cwd: own },
        { sessionId: 's-foreign', updatedAt: 0, running: false, blank: false, cwd: foreign },
        { sessionId: 's-no-cwd', updatedAt: 0, running: false, blank: false },
      ],
      searchItems: [], workspaces: [], archivedSessionIds: [],
    })
    const response = await ctx.tenantContext.run(TENANT_A, () => sessionController.list({}, NEVER_ABORTED))
    expect(response.items.map(item => item.sessionId)).toEqual(['s-own'])
  })

  it('defaults an omitted cwd/workspaceId to the tenant root', async () => {
    const { ctx, sessionController } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    const value = await ctx.tenantContext.run(TENANT_A, () => sessionController.create({}))
    expect(value.sessionId).toBe('created')
  })

  it('rejects a cwd outside the tenant root with mindportalix/tenant-path-invalid', async () => {
    const { ctx, sessionController } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    const foreignCwd = join(tenantRootFor(TENANT_B), 'project')
    await expect(ctx.tenantContext.run(TENANT_A, () => sessionController.create({ cwd: foreignCwd })))
      .rejects.toMatchObject({ code: 'mindportalix/tenant-path-invalid' })
  })

  it('rejects a cross-tenant workspaceId with workspace/not-found', async () => {
    const foreignWorkspace = makeWorkspace('ws-b', join(tenantRootFor(TENANT_B), 'proj'))
    const { ctx, sessionController } = await setup({
      sessions: [], searchItems: [], workspaces: [foreignWorkspace], archivedSessionIds: [],
    })
    await expect(ctx.tenantContext.run(TENANT_A, () => sessionController.create({ workspaceId: 'ws-b' } as never)))
      .rejects.toMatchObject({ code: 'workspace/not-found', details: { workspaceId: 'ws-b' } })
  })

  it('accepts a same-tenant workspaceId', async () => {
    const ownWorkspace = makeWorkspace('ws-a', join(tenantRootFor(TENANT_A), 'proj'))
    const { ctx, sessionController } = await setup({
      sessions: [], searchItems: [], workspaces: [ownWorkspace], archivedSessionIds: [],
    })
    const value = await ctx.tenantContext.run(TENANT_A, () => sessionController.create({ workspaceId: 'ws-a' } as never))
    expect(value.sessionId).toBe('created')
  })
})

describe('session.search', () => {
  it('filters results to the caller tenant\'s visible sessions', async () => {
    const own = join(tenantRootFor(TENANT_A), 'proj')
    const { ctx, sessionController } = await setup({
      sessions: [{ sessionId: 's-own', updatedAt: 0, running: false, blank: false, cwd: own }],
      searchItems: [{ sessionId: 's-own', snippet: 'hit' }, { sessionId: 's-foreign', snippet: 'hit' }],
      workspaces: [], archivedSessionIds: [],
    })
    const response = await ctx.tenantContext.run(TENANT_A, () => sessionController.search({ query: 'hit' }, NEVER_ABORTED))
    expect(response.items.map(item => item.sessionId)).toEqual(['s-own'])
  })
})

describe('by-sessionId guards', () => {
  it('rejects rename on a foreign session with session/not-found', async () => {
    const { ctx, sessionController } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    await expect(ctx.tenantContext.run(TENANT_A, () => sessionController.rename({ sessionId: SessionId('foreign'), title: 't' })))
      .rejects.toMatchObject({ code: 'session/not-found', details: { sessionId: SessionId('foreign') } })
  })

  it('reaches the original implementation for an owned session', async () => {
    const own = join(tenantRootFor(TENANT_A), 'proj')
    const { ctx, sessionController } = await setup({
      sessions: [{ sessionId: 's-own', updatedAt: 0, running: false, blank: false, cwd: own }],
      searchItems: [], workspaces: [], archivedSessionIds: [],
    })
    const value = await ctx.tenantContext.run(TENANT_A, () => sessionController.rename({ sessionId: SessionId('s-own'), title: 'new' }))
    expect(value).toMatchObject({ title: 'new', reached: true })
  })

  it('rejects prompt on a foreign session', async () => {
    const { ctx, sessionController } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    await expect(ctx.tenantContext.run(TENANT_A, () => sessionController.prompt({
      requestId: 'r' as never, sessionId: SessionId('foreign'), mode: 'queue', content: [],
    }, NEVER_ABORTED))).rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('resolves a subagent address via its parent session for page', async () => {
    const own = join(tenantRootFor(TENANT_A), 'proj')
    const { ctx, sessionController } = await setup({
      sessions: [{ sessionId: 'parent', updatedAt: 0, running: false, blank: false, cwd: own }],
      searchItems: [], workspaces: [], archivedSessionIds: [],
    })
    const value = await ctx.tenantContext.run(TENANT_A, () => sessionController.page({
      address: { kind: 'subagent', parentSessionId: SessionId('parent'), childSessionId: SessionId('child'), mode: 'one-shot' },
      throughSeq: 0,
    }, NEVER_ABORTED))
    expect(value).toMatchObject({ reached: true })
  })

  it('rejects updateQueue (a sync-returning method) on a foreign session', async () => {
    const { ctx, sessionController } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    await expect(ctx.tenantContext.run(TENANT_A, () => sessionController.updateQueue({
      sessionId: SessionId('foreign'), itemId: 'm' as never, action: { kind: 'remove' },
    }))).rejects.toMatchObject({ code: 'session/not-found' })
  })
})

describe('workspace.* methods', () => {
  it('rejects workspace.create outside the tenant root', async () => {
    const { ctx, workspaceController } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    const foreignPath = join(tenantRootFor(TENANT_B), 'proj')
    await expect(ctx.tenantContext.run(TENANT_A, () => workspaceController.create({ path: foreignPath })))
      .rejects.toMatchObject({ code: 'mindportalix/tenant-path-invalid' })
  })

  it('accepts workspace.create under the tenant root', async () => {
    const { ctx, workspaceController } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    const ownPath = join(tenantRootFor(TENANT_A), 'proj')
    const value = await ctx.tenantContext.run(TENANT_A, () => workspaceController.create({ path: ownPath }))
    expect(value.created).toBe(true)
  })

  it('rejects rename/delete on a cross-tenant workspace with workspace/not-found', async () => {
    const foreignWorkspace = makeWorkspace('ws-b', join(tenantRootFor(TENANT_B), 'proj'))
    const { ctx, workspaceController } = await setup({
      sessions: [], searchItems: [], workspaces: [foreignWorkspace], archivedSessionIds: [],
    })
    await expect(ctx.tenantContext.run(TENANT_A, () => workspaceController.rename({ workspaceId: 'ws-b' as never, title: 't' })))
      .rejects.toMatchObject({ code: 'workspace/not-found' })
    await expect(ctx.tenantContext.run(TENANT_A, () => workspaceController.delete({ workspaceId: 'ws-b' as never })))
      .rejects.toMatchObject({ code: 'workspace/not-found' })
  })

  it('rejects archiveSession for a session owned by no tenant-visible workspace (fail closed)', async () => {
    const { ctx, workspaceController } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    await expect(ctx.tenantContext.run(TENANT_A, () => workspaceController.archiveSession({ sessionId: 'ungrouped' as never })))
      .rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('accepts archiveSession for a session owned by a tenant-visible workspace', async () => {
    const ownWorkspace = makeWorkspace('ws-a', join(tenantRootFor(TENANT_A), 'proj'), ['s-own'])
    const { ctx, workspaceController } = await setup({
      sessions: [], searchItems: [], workspaces: [ownWorkspace], archivedSessionIds: [],
    })
    const value = await ctx.tenantContext.run(TENANT_A, () => workspaceController.archiveSession({ sessionId: SessionId('s-own') }))
    expect(value.archivedSessionIds).toContain('s-own')
  })
})

describe('directoryPicker.list / createDirectory', () => {
  it('defaults an omitted path to the tenant root and rewrites home/crumbs', async () => {
    const { ctx, directoryPickerController } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    const listing = await ctx.tenantContext.run(TENANT_A, () => directoryPickerController.list(undefined, NEVER_ABORTED))
    const tenantRoot = tenantRootFor(TENANT_A)
    expect(listing.home).toBe(tenantRoot)
    expect(listing.path).toBe(tenantRoot)
    expect(listing.crumbs[0]?.path).toBe(tenantRoot)
  })

  it('rejects an explicit path outside the tenant root', async () => {
    const { ctx, directoryPickerController } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    const foreignPath = join(tenantRootFor(TENANT_B), 'x')
    await expect(ctx.tenantContext.run(TENANT_A, () => directoryPickerController.list(foreignPath, NEVER_ABORTED)))
      .rejects.toMatchObject({ code: 'mindportalix/tenant-path-invalid' })
  })

  it('rejects createDirectory whose parent path is outside the tenant root', async () => {
    const { ctx, directoryPickerController } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    const foreignParent = tenantRootFor(TENANT_B)
    await expect(ctx.tenantContext.run(TENANT_A, () => directoryPickerController.createDirectory(foreignParent, 'sub')))
      .rejects.toMatchObject({ code: 'mindportalix/tenant-path-invalid' })
  })

  it('accepts createDirectory under the tenant root', async () => {
    const { ctx, directoryPickerController } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    const tenantRoot = tenantRootFor(TENANT_A)
    const created = await ctx.tenantContext.run(TENANT_A, () => directoryPickerController.createDirectory(tenantRoot, 'sub'))
    expect(created).toBe(join(tenantRoot, 'sub'))
  })
})

describe('disposal', () => {
  it('restores every original method when the plugin fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(TenantContextService)
    const sessionController = fakeSessionController({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    const workspaceController = fakeWorkspaceController({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    const directoryPickerController = fakeDirectoryPickerController()
    ctx.provide('sessionController', sessionController)
    ctx.provide('workspaceController', workspaceController)
    ctx.provide('directoryPickerController', directoryPickerController)
    ctx.provide('workspaceRegistry', fakeWorkspaceRegistry([]))
    ctx.provide('sessions', fakeSessionStore({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] }))
    const originalList = sessionController.list
    const fiber = ctx.plugin(TenantSessionGuard)
    await fiber.await()
    const wrappedList = sessionController.list
    expect(wrappedList).not.toBe(originalList)
    await fiber.dispose()
    // The restored method is a fresh `.bind()` of the original (not the exact
    // same function reference captured above), so assert behavior instead of
    // identity: unwrapped, it must no longer reject with mindportalix/tenant-required.
    expect(sessionController.list).not.toBe(wrappedList)
    await expect(sessionController.list({}, NEVER_ABORTED)).resolves.toMatchObject({ items: [] })
  })
})
